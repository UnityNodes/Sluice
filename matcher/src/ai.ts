/**
 * Natural-language → predicate parser.
 *
 * Rule-based, offline. No LLM dependency. Recognises:
 *
 *   amount comparison    : "over 100k cspr", "above 5 million", "exceeding 1B",
 *                          "under 10 cspr", "below 2.5 cspr", "exactly 100 cspr"
 *   account targets      : "to <hex>", "to address <hex>", "from <hex>", "by <hex>"
 *   block height         : "block above 8M", "in block 8346792", "after block 8M"
 *   amount precision     : "ending in 000000000" → ends_with
 *   subset               : "from <hex>, <hex>, <hex>" → in
 *   timestamp            : "today", "this hour", "in 2026" → contains <year>
 *
 * Unknown phrases are dropped silently; the caller sees what was extracted in
 * the `understood` list. If we can't extract anything, the returned predicate
 * is null and `understood` is empty.
 */

import type { Predicate, PredicateNode, Operator } from './types';

const CSPR_TO_MOTES = 1_000_000_000n;

interface Parsed {
  predicate: Predicate | null;
  understood: string[];
  unknown: string[];
}

function parseAmount(token: string): bigint | null {
  // accepts "100k", "5.5m", "1_000", "1B", "2,500"
  const cleaned = token.replace(/[_,]/g, '');
  const m = cleaned.match(/^(\d+(?:\.\d+)?)\s*([kmbKMB])?$/);
  if (!m) {
    if (/^\d+$/.test(cleaned)) {
      try { return BigInt(cleaned); } catch { return null; }
    }
    return null;
  }
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const mult = m[2] ? ({ k: 1e3, K: 1e3, m: 1e6, M: 1e6, b: 1e9, B: 1e9 } as Record<string, number>)[m[2]] : 1;
  return BigInt(Math.round(n * mult));
}

function pushCond(out: Predicate, cond: { field: string; op: Operator; value: string | string[] | boolean }): void {
  out.and.push(cond as PredicateNode);
}

function pushNode(out: Predicate, node: PredicateNode): void {
  out.and.push(node);
}

const HEX64 = /\b([0-9a-f]{64})\b/gi;

/**
 * Detect "to/from A or B [or C]" phrases. Returns the OR group + the consumed
 * substring length so the caller can chomp it from `lc` before running the
 * single-hex matchers. Supports comma- and "or"-separated lists.
 */
function parseHexOrList(
  lc: string,
  verb: 'to' | 'from',
): { node: PredicateNode; consumed: string; addresses: string[] } | null {
  const verbRe = verb === 'to'
    ? /\b(?:to|destination|recipient)(?:\s+(?:account|address))?\s+/
    : /\b(?:from|sent\s+by|by)\s+/;
  const startMatch = lc.match(verbRe);
  if (!startMatch) return null;
  const startIdx = startMatch.index! + startMatch[0].length;
  const tail = lc.slice(startIdx);
  // accept "<hex>(\s*,?\s*(?:or|,)\s*<hex>){1,}"
  const m = tail.match(/^((?:0x)?[0-9a-f]{64})((?:\s*(?:,\s+or|,|\s+or)\s+(?:0x)?[0-9a-f]{64})+)/);
  if (!m) return null;
  const all = [m[1]].concat(...Array.from(m[2].matchAll(/(?:0x)?([0-9a-f]{64})/gi)).map((x) => [x[1]]))
    .map((h) => h.replace(/^0x/, ''));
  if (all.length < 2) return null;
  const field = verb === 'to' ? 'to_account_hash' : 'initiator_account_hash';
  const node: PredicateNode = {
    or: all.map((h) => ({ field, op: 'eq' as Operator, value: h })),
  };
  return { node, consumed: startMatch[0] + m[0], addresses: all };
}

/** Lowercased, with multi-word amount phrases coalesced ("5 million" → "5m"). */
function preprocess(input: string): string {
  let s = input.toLowerCase();
  s = s.replace(/(\d+(?:\.\d+)?)\s+million/g, '$1m');
  s = s.replace(/(\d+(?:\.\d+)?)\s+billion/g, '$1b');
  s = s.replace(/(\d+(?:\.\d+)?)\s+thousand/g, '$1k');
  s = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  return s;
}

/**
 * Public entry. Extracts `(...)`-grouped sub-clauses first, parses each as
 * its own predicate, then merges them as nested AND/OR groups into the
 * outer flat parse. Parens are non-nested in v0.3, `((X) or Y)` will be
 * partially flattened by the iterative replace pass.
 *
 * Examples it now understands that the flat parser couldn't:
 *   "(from A or from B) above 5k cspr"
 *   "between 100 and 1000 cspr and (to A or to B)"
 *   "amount under 10 cspr or block above 8m"   ← outer " or " also recognised
 */
export function parseNaturalLanguage(input: string): Parsed {
  let working = preprocess(input);
  const groups: PredicateNode[] = [];
  const groupUnderstood: string[] = [];
  const groupUnknown: string[] = [];

  // 1) Pull out (...) groups one at a time, replace with whitespace.
  let guard = 0;
  while (guard++ < 8) {
    const m = working.match(/\(([^()]+)\)/);
    if (!m) break;
    const inner = m[1].trim();
    const arms = inner.split(/\s+or\s+/i).map((s) => s.trim()).filter(Boolean);
    if (arms.length >= 2) {
      const armResults = arms.map((arm) => parseFlat(arm));
      const armNodes: PredicateNode[] = armResults
        .map((r) => r.predicate)
        .filter((p): p is Predicate => !!p)
        .map((p) => (p.and.length === 1 ? p.and[0] : { and: p.and }));
      if (armNodes.length >= 2) {
        groups.push({ or: armNodes });
        groupUnderstood.push(`(${arms.length}-arm OR group)`);
        armResults.forEach((r) => { groupUnknown.push(...r.unknown); });
      } else if (armNodes.length === 1) {
        groups.push(armNodes[0]);
      }
    } else {
      const sub = parseFlat(inner);
      if (sub.predicate) {
        const conds = sub.predicate.and;
        groups.push(conds.length === 1 ? conds[0] : { and: conds });
        groupUnderstood.push(...sub.understood);
        groupUnknown.push(...sub.unknown);
      }
    }
    working = working.slice(0, m.index!) + ' ' + working.slice(m.index! + m[0].length);
  }

  // 2) Detect top-level " or " between two clauses at outer scope. Only
  //    recognised when no paren-group was already split out, and the " or "
  //    is NOT part of a "to/from <hex> or <hex>" address list (parseFlat
  //    handles those better, splitting here would mis-parenthesise).
  const addressOrRe = /\b(?:to|from|sent\s+by|by)(?:\s+(?:account|address))?\s+(?:0x)?[0-9a-f]{64}\s*(?:,\s*or|,|\s+or)\s+(?:0x)?[0-9a-f]{64}/;
  if (groups.length === 0 && / or /.test(working) && !addressOrRe.test(working)) {
    const idx = working.indexOf(' or ');
    const left = working.slice(0, idx).trim();
    const right = working.slice(idx + 4).trim();
    const lRes = parseFlat(left);
    const rRes = parseFlat(right);
    if (lRes.predicate && rRes.predicate) {
      const lNode: PredicateNode = lRes.predicate.and.length === 1 ? lRes.predicate.and[0] : { and: lRes.predicate.and };
      const rNode: PredicateNode = rRes.predicate.and.length === 1 ? rRes.predicate.and[0] : { and: rRes.predicate.and };
      return {
        predicate: { and: [{ or: [lNode, rNode] }] },
        understood: ['(top-level 2-arm OR)', ...lRes.understood, ...rRes.understood],
        unknown: [...lRes.unknown, ...rRes.unknown],
      };
    }
  }

  // 3) Parse the remainder as flat, then merge in extracted groups.
  const outer = parseFlat(working);
  const conds = (outer.predicate?.and ?? []).concat(groups);
  return {
    predicate: conds.length > 0 ? { and: conds } : null,
    understood: [...outer.understood, ...groupUnderstood],
    unknown: [...outer.unknown, ...groupUnknown],
  };
}

/**
 * Original single-pass parser. Handles flat AND-of-conditions + the "to/from
 * A or B" address-OR shortcut. Called by parseNaturalLanguage on each
 * paren-group arm.
 */
function parseFlat(input: string): Parsed {
  const understood: string[] = [];
  const unknown: string[] = [];
  const predicate: Predicate = { and: [] };
  const lc = preprocess(input);

  // 1. amount comparisons. patterns we recognise:
  //    "over X cspr", "above X cspr", "greater than X cspr", "exceeding X cspr"  → gte
  //    "under X cspr", "below X cspr", "less than X cspr"                        → lte
  //    "exactly X cspr", "equal to X cspr", "= X cspr"                           → eq
  //    "X to Y cspr" range                                                       → gte+lte
  const amountUnit = /(?:cspr|motes)?/.source;
  const amountTok = /(\d+(?:[\d_,.]*\d)?\s*[kKmMbB]?)/.source;
  const rangeRe = new RegExp(`\\bbetween\\s+${amountTok}\\s+and\\s+${amountTok}\\s*${amountUnit}\\b`);
  const overRe  = new RegExp(`\\b(?:over|above|greater\\s+than|exceeding|>=|>)\\s+${amountTok}\\s*${amountUnit}\\b`);
  const underRe = new RegExp(`\\b(?:under|below|less\\s+than|<=|<)\\s+${amountTok}\\s*${amountUnit}\\b`);
  const exactRe = new RegExp(`\\b(?:exactly|equal\\s+to|=)\\s+${amountTok}\\s*${amountUnit}\\b`);

  const matchRange = lc.match(rangeRe);
  if (matchRange) {
    const a = parseAmount(matchRange[1]); const b = parseAmount(matchRange[2]);
    if (a !== null && b !== null) {
      const isMotes = /motes/.test(matchRange[0]);
      const lo = isMotes ? a : a * CSPR_TO_MOTES;
      const hi = isMotes ? b : b * CSPR_TO_MOTES;
      pushCond(predicate, { field: 'amount', op: 'gte', value: lo.toString() });
      pushCond(predicate, { field: 'amount', op: 'lte', value: hi.toString() });
      understood.push(`amount between ${a}${isMotes ? '' : ' cspr'} and ${b}${isMotes ? '' : ' cspr'}`);
    }
  } else {
    const tryOne = (re: RegExp, op: Operator, label: string) => {
      const m = lc.match(re);
      if (!m) return;
      const n = parseAmount(m[1]);
      if (n === null) return;
      const isMotes = /motes/.test(m[0]);
      const motes = isMotes ? n : n * CSPR_TO_MOTES;
      pushCond(predicate, { field: 'amount', op, value: motes.toString() });
      understood.push(`${label} ${n}${isMotes ? ' motes' : ' cspr'}`);
    };
    tryOne(overRe, 'gte', 'amount ≥');
    tryOne(underRe, 'lte', 'amount ≤');
    tryOne(exactRe, 'eq', 'amount =');
  }

  // 2. targets, first try "to A or B" / "from A or B" OR-lists, then fall back to single-hex.
  let lcRemain = lc;
  const consumedAddresses = new Set<string>();
  const toOr = parseHexOrList(lcRemain, 'to');
  if (toOr) {
    pushNode(predicate, toOr.node);
    understood.push(`to_account_hash in [${toOr.addresses.length} addresses]`);
    toOr.addresses.forEach((h) => consumedAddresses.add(h));
    lcRemain = lcRemain.replace(toOr.consumed, ' ');
  }
  const fromOr = parseHexOrList(lcRemain, 'from');
  if (fromOr) {
    pushNode(predicate, fromOr.node);
    understood.push(`initiator_account_hash in [${fromOr.addresses.length} addresses]`);
    fromOr.addresses.forEach((h) => consumedAddresses.add(h));
    lcRemain = lcRemain.replace(fromOr.consumed, ' ');
  }
  const toMatch = lcRemain.match(new RegExp(`\\b(?:to|destination|recipient)(?:\\s+account|\\s+address)?\\s+(0x)?([0-9a-f]{64})\\b`));
  if (toMatch && !consumedAddresses.has(toMatch[2])) {
    const hex = toMatch[2];
    pushCond(predicate, { field: 'to_account_hash', op: 'eq', value: hex });
    understood.push(`to_account_hash = ${hex.slice(0, 12)}…`);
    consumedAddresses.add(hex);
  }
  const fromMatch = lcRemain.match(new RegExp(`\\b(?:from|sent\\s+by|by)\\s+(0x)?([0-9a-f]{64})\\b`));
  if (fromMatch && !consumedAddresses.has(fromMatch[2])) {
    const hex = fromMatch[2];
    pushCond(predicate, { field: 'initiator_account_hash', op: 'eq', value: hex });
    understood.push(`initiator_account_hash = ${hex.slice(0, 12)}…`);
    consumedAddresses.add(hex);
  }

  // 3. set membership, "to any of <hex>, <hex>, <hex>"
  const anyOfMatch = lc.match(/\b(?:any\s+of|one\s+of)\s+([0-9a-f, ]+)\b/);
  if (anyOfMatch) {
    const list = Array.from(anyOfMatch[1].matchAll(HEX64)).map((m) => m[1]);
    if (list.length > 0) {
      pushCond(predicate, { field: 'to_account_hash', op: 'in', value: list });
      understood.push(`to_account_hash in [${list.length} addresses]`);
    }
  }

  // 4. block height, "block above 8m", "after block 8346792"
  const blockOver = lc.match(/\bblock(?:\s+height)?\s+(?:above|>=|>|after)\s+(\d+(?:\.\d+)?\s*[kKmMbB]?)\b/);
  if (blockOver) {
    const n = parseAmount(blockOver[1]);
    if (n !== null) {
      pushCond(predicate, { field: 'block_height', op: 'gte', value: n.toString() });
      understood.push(`block_height ≥ ${n}`);
    }
  }
  const blockEq = lc.match(/\bin\s+block\s+(\d+)\b/);
  if (blockEq) {
    pushCond(predicate, { field: 'block_height', op: 'eq', value: blockEq[1] });
    understood.push(`block_height = ${blockEq[1]}`);
  }

  // 5. round numbers, "ending in 000000000" or "round (cspr) amounts"
  if (/\bending\s+in\s+([0-9]+)\b/.test(lc)) {
    const m = lc.match(/\bending\s+in\s+([0-9]+)\b/)!;
    pushCond(predicate, { field: 'amount', op: 'ends_with', value: m[1] });
    understood.push(`amount ends_with "${m[1]}"`);
  } else if (/\bround\s+(?:cspr\s+)?amounts?\b/.test(lc)) {
    pushCond(predicate, { field: 'amount', op: 'ends_with', value: '000000000' });
    understood.push(`amount ends_with "000000000" (round CSPR)`);
  }

  // 6. timestamp, year, today, yesterday, this hour, since/before, last N units.
  //    Timestamps are ISO-8601 UTC strings in TransferEvent ("2026-06-30T10:55:00.123Z"),
  //    so starts_with on a date prefix gives day/hour windows for free.
  const pad = (n: number) => String(n).padStart(2, '0');
  const isoDate = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const isoHour = (d: Date) => `${isoDate(d)}T${pad(d.getUTCHours())}`;

  if (/\bin\s+(20\d\d)\b/.test(lc)) {
    const yr = lc.match(/\bin\s+(20\d\d)\b/)![1];
    pushCond(predicate, { field: 'timestamp', op: 'contains', value: yr });
    understood.push(`timestamp contains "${yr}"`);
  }
  // Use Date.now() explicitly (not `new Date()`) so tests can mock the clock.
  if (/\btoday(?:'s)?\b/.test(lc)) {
    const day = isoDate(new Date(Date.now()));
    pushCond(predicate, { field: 'timestamp', op: 'starts_with', value: day });
    understood.push(`timestamp starts_with "${day}" (today)`);
  }
  if (/\byesterday(?:'s)?\b/.test(lc)) {
    const day = isoDate(new Date(Date.now() - 86_400_000));
    pushCond(predicate, { field: 'timestamp', op: 'starts_with', value: day });
    understood.push(`timestamp starts_with "${day}" (yesterday)`);
  }
  if (/\bthis\s+hour\b/.test(lc)) {
    const h = isoHour(new Date(Date.now()));
    pushCond(predicate, { field: 'timestamp', op: 'starts_with', value: h });
    understood.push(`timestamp starts_with "${h}" (this hour)`);
  }
  // "last 24h", "last 1 hour", "last 30 minutes", "last 7 days", "last 1 week"
  const lastWindowRe = /\b(?:last|past)\s+(\d+(?:\.\d+)?)\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w)\b/;
  const lwm = lc.match(lastWindowRe);
  if (lwm) {
    const n = parseFloat(lwm[1]);
    const u = lwm[2];
    const ms = /^(minutes?|mins?|m)$/.test(u) ? n * 60_000
             : /^(hours?|hrs?|h)$/.test(u)     ? n * 3_600_000
             : /^(days?|d)$/.test(u)           ? n * 86_400_000
             : /* weeks */                       n * 7 * 86_400_000;
    if (Number.isFinite(ms) && ms > 0) {
      const cutoff = new Date(Date.now() - ms).toISOString();
      pushCond(predicate, { field: 'timestamp', op: 'gte', value: cutoff });
      understood.push(`timestamp ≥ ${cutoff.slice(0, 19)}Z (last ${n} ${u})`);
    }
  }
  const sinceRe = /\bsince\s+(20\d\d-\d{2}-\d{2}(?:T\d{2}(?::\d{2}(?::\d{2})?)?)?)\b/;
  const sm = lc.match(sinceRe);
  if (sm) {
    pushCond(predicate, { field: 'timestamp', op: 'gte', value: sm[1] });
    understood.push(`timestamp ≥ ${sm[1]}`);
  }
  const beforeRe = /\bbefore\s+(20\d\d-\d{2}-\d{2}(?:T\d{2}(?::\d{2}(?::\d{2})?)?)?)\b/;
  const bm = lc.match(beforeRe);
  if (bm) {
    pushCond(predicate, { field: 'timestamp', op: 'lt', value: bm[1] });
    understood.push(`timestamp < ${bm[1]}`);
  }

  // 7. flag any unrecognised hex-looking tokens so the caller can see them
  const hexLeftovers = Array.from(lc.matchAll(HEX64)).map((m) => m[1])
    .filter((h) => !consumedAddresses.has(h));
  for (const h of hexLeftovers) unknown.push(`unused account_hash: ${h.slice(0, 12)}…`);

  return {
    predicate: predicate.and.length > 0 ? predicate : null,
    understood,
    unknown,
  };
}
