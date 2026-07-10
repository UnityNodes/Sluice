/**
 * Predicate evaluation engine.
 *
 * Predicate JSON is an AND-of-conditions over fields of a Transfer event:
 *
 *   {
 *     "and": [
 *       { "field": "to_account_hash", "op": "eq",  "value": "<hex>" },
 *       { "field": "amount",          "op": "gt",  "value": "1000000000" }
 *     ]
 *   }
 *
 * Strings and bigint-strings are compared numerically when both sides parse
 * as bigints; otherwise as plain strings. Booleans compare strictly.
 *
 * `field` supports dot.notation for nested access.
 */

import type { Condition, Operator, Predicate, PredicateNode, TransferEvent } from './types';

const ALLOWED_OPS: Operator[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'starts_with', 'ends_with', 'in', 'not_in', 'regex'];
const MAX_DEPTH = 4;
const MAX_CONDITIONS_TOTAL = 32;

export class PredicateError extends Error {}

const MAX_REGEX_LEN = 200;

/** No event field worth matching is longer than this, and it bounds backtracking. */
const MAX_REGEX_SUBJECT_LEN = 4096;

/** True for `*`, `+` and `{n,}`, the quantifiers that admit unbounded repetition. */
function unboundedQuantifierAt(src: string, i: number): boolean {
  const c = src[i];
  if (c === '*' || c === '+') return true;
  if (c !== '{') return false;
  const close = src.indexOf('}', i);
  if (close === -1) return false;
  return /^\d+,$/.test(src.slice(i + 1, close));
}

/**
 * Guard against catastrophic-backtracking regexes. Predicates are
 * attacker-controlled (anyone can create a subscription), so a pathological
 * pattern would otherwise stall the single-threaded matcher on the first
 * matching event.
 *
 * Rejects a group under an unbounded quantifier when the group itself contains
 * an unbounded quantifier (star height >= 2, e.g. `(a+)+`, `([a-z]+)*`) or an
 * alternation whose branches may overlap (e.g. `(a|a)+`, `(a|ab)*`). Both are
 * the shapes that make matching exponential. Disjoint alternations such as
 * `(a|b)+` are rejected too: express them as a character class `[ab]+`.
 */
function looksCatastrophicRegex(src: string): boolean {
  type Frame = { quant: boolean; alt: boolean };
  const stack: Frame[] = [];
  let top: Frame = { quant: false, alt: false };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (c === '[') {
      i++;
      while (i < src.length && src[i] !== ']') { if (src[i] === '\\') i++; i++; }
      continue;
    }
    if (c === '(') { stack.push(top); top = { quant: false, alt: false }; continue; }
    if (c === '|') { top.alt = true; continue; }
    if (c === ')') {
      const closed = top;
      top = stack.pop() ?? { quant: false, alt: false };
      const quantified = unboundedQuantifierAt(src, i + 1);
      if (quantified && (closed.quant || closed.alt)) return true;
      top.quant = top.quant || closed.quant || quantified;
      continue;
    }
    if (unboundedQuantifierAt(src, i)) top.quant = true;
  }
  return false;
}

/** Type guards for the nested grammar. */
function isAndGroup(n: unknown): n is { and: PredicateNode[] } {
  return !!n && typeof n === 'object' && Array.isArray((n as { and?: unknown }).and);
}
function isOrGroup(n: unknown): n is { or: PredicateNode[] } {
  return !!n && typeof n === 'object' && Array.isArray((n as { or?: unknown }).or);
}

/** Walks `obj` via "a.b.c" notation. Returns undefined if any segment misses. */
export function getField(obj: Record<string, unknown>, path: string): unknown {
  if (!path) return undefined;
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function tryBigInt(v: unknown): bigint | null {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) {
    try { return BigInt(v); } catch { return null; }
  }
  return null;
}

function compare(left: unknown, op: Operator, right: unknown): boolean {
  if (typeof left === 'boolean' || typeof right === 'boolean') {
    if (op !== 'eq' && op !== 'neq') return false;
    return op === 'eq' ? left === right : left !== right;
  }

  const ls = left === undefined || left === null ? '' : String(left);

  // String-only ops (run on the raw stringified value).
  switch (op) {
    case 'contains':    return ls.includes(String(right ?? ''));
    case 'starts_with': return ls.startsWith(String(right ?? ''));
    case 'ends_with':   return ls.endsWith(String(right ?? ''));
    case 'regex': {
      const src = String(right ?? '');
      if (src.length > MAX_REGEX_LEN || looksCatastrophicRegex(src)) return false;
      if (ls.length > MAX_REGEX_SUBJECT_LEN) return false;
      try { return new RegExp(src).test(ls); }
      catch { return false; }
    }
    case 'in':
    case 'not_in': {
      if (!Array.isArray(right)) return false;
      const inList = right.some((v) => String(v) === ls);
      return op === 'in' ? inList : !inList;
    }
  }

  const lb = tryBigInt(left);
  const rb = tryBigInt(right);
  if (lb !== null && rb !== null) {
    switch (op) {
      case 'eq':  return lb === rb;
      case 'neq': return lb !== rb;
      case 'gt':  return lb >  rb;
      case 'gte': return lb >= rb;
      case 'lt':  return lb <  rb;
      case 'lte': return lb <= rb;
    }
  }

  // string fallback for comparison ops
  const rs = right === undefined || right === null ? '' : String(right);
  switch (op) {
    case 'eq':  return ls === rs;
    case 'neq': return ls !== rs;
    case 'gt':  return ls >  rs;
    case 'gte': return ls >= rs;
    case 'lt':  return ls <  rs;
    case 'lte': return ls <= rs;
  }
  return false;
}

function validateNode(node: unknown, depth: number, path: string, counter: { n: number }): void {
  if (depth > MAX_DEPTH) throw new PredicateError(`predicate too deeply nested at ${path} (max ${MAX_DEPTH})`);
  if (counter.n > MAX_CONDITIONS_TOTAL) throw new PredicateError(`predicate has too many conditions (max ${MAX_CONDITIONS_TOTAL})`);
  if (!node || typeof node !== 'object') throw new PredicateError(`${path} must be an object`);

  if (isAndGroup(node) || isOrGroup(node)) {
    const arr = (node as { and?: unknown; or?: unknown }).and ?? (node as { or: unknown[] }).or;
    const key = isAndGroup(node) ? 'and' : 'or';
    if (!Array.isArray(arr)) throw new PredicateError(`${path}.${key} must be an array`);
    if (arr.length === 0) throw new PredicateError(`${path}.${key} must not be empty`);
    arr.forEach((child, i) => validateNode(child, depth + 1, `${path}.${key}[${i}]`, counter));
    return;
  }

  // Leaf condition
  const cc = node as Partial<Condition>;
  if (typeof cc.field !== 'string' || !cc.field) throw new PredicateError(`${path}.field missing`);
  if (typeof cc.op !== 'string' || !ALLOWED_OPS.includes(cc.op as Operator)) {
    throw new PredicateError(`${path}.op invalid (got ${cc.op})`);
  }
  if (cc.value === undefined || cc.value === null) throw new PredicateError(`${path}.value missing`);
  if ((cc.op === 'in' || cc.op === 'not_in') && !Array.isArray(cc.value)) {
    throw new PredicateError(`${path}.value must be an array for op=${cc.op}`);
  }
  if (cc.op === 'regex') {
    const src = String(cc.value);
    if (src.length > MAX_REGEX_LEN) throw new PredicateError(`${path}.value regex too long (max ${MAX_REGEX_LEN} chars)`);
    if (looksCatastrophicRegex(src)) throw new PredicateError(`${path}.value regex rejected: nested quantifier risks catastrophic backtracking`);
    try { new RegExp(src); } catch (e) { throw new PredicateError(`${path}.value invalid regex: ${(e as Error).message}`); }
  }
  counter.n++;
}

export function validatePredicate(p: unknown): asserts p is Predicate {
  if (!p || typeof p !== 'object') throw new PredicateError('predicate must be an object');
  const pp = p as { and?: unknown };
  if (!Array.isArray(pp.and)) throw new PredicateError('predicate.and must be an array');
  if (pp.and.length === 0) throw new PredicateError('predicate.and must contain at least one condition');
  const counter = { n: 0 };
  pp.and.forEach((child, i) => validateNode(child, 1, `and[${i}]`, counter));
}

function evalNode(node: PredicateNode, event: TransferEvent): boolean {
  if (isAndGroup(node)) {
    for (const child of node.and) if (!evalNode(child, event)) return false;
    return true;
  }
  if (isOrGroup(node)) {
    for (const child of node.or) if (evalNode(child, event)) return true;
    return false;
  }
  const cond = node;
  const lhs = getField(event as unknown as Record<string, unknown>, cond.field);
  if (lhs === undefined) return false;
  return compare(lhs, cond.op, cond.value);
}

export function evaluate(predicate: Predicate, event: TransferEvent): boolean {
  for (const node of predicate.and) if (!evalNode(node, event)) return false;
  return true;
}

export interface ExplainStep {
  index: number;
  field: string;
  op: Operator;
  expected: Condition['value'];
  actual: unknown;
  pass: boolean;
  reason: string;          // human-readable one-liner, e.g. "5000000000000 >= 5000000000000 ✓"
  group?: string;          // dotted-path label like "and[0].or[1]" when nested
}

export interface ExplainResult {
  match: boolean;
  conditions_total: number;
  conditions_passed: number;
  trace: ExplainStep[];
}

function describe(left: unknown, op: Operator, right: unknown, pass: boolean): string {
  const fmt = (v: unknown): string => {
    if (v === undefined) return '<missing>';
    if (Array.isArray(v)) return `[${v.slice(0, 3).map(fmt).join(', ')}${v.length > 3 ? `, +${v.length - 3}` : ''}]`;
    const s = String(v);
    return s.length > 64 ? s.slice(0, 60) + '…' : s;
  };
  const glyph = pass ? '✓' : '✗';
  switch (op) {
    case 'eq':          return `${fmt(left)} == ${fmt(right)} ${glyph}`;
    case 'neq':         return `${fmt(left)} != ${fmt(right)} ${glyph}`;
    case 'gt':          return `${fmt(left)} >  ${fmt(right)} ${glyph}`;
    case 'gte':         return `${fmt(left)} >= ${fmt(right)} ${glyph}`;
    case 'lt':          return `${fmt(left)} <  ${fmt(right)} ${glyph}`;
    case 'lte':         return `${fmt(left)} <= ${fmt(right)} ${glyph}`;
    case 'contains':    return `${fmt(left)} contains ${fmt(right)} ${glyph}`;
    case 'starts_with': return `${fmt(left)} starts with ${fmt(right)} ${glyph}`;
    case 'ends_with':   return `${fmt(left)} ends with ${fmt(right)} ${glyph}`;
    case 'regex':       return `${fmt(left)} matches /${fmt(right)}/ ${glyph}`;
    case 'in':          return `${fmt(left)} in ${fmt(right)} ${glyph}`;
    case 'not_in':      return `${fmt(left)} not in ${fmt(right)} ${glyph}`;
    default:            return `${fmt(left)} ${op} ${fmt(right)} ${glyph}`;
  }
}

/**
 * Evaluate every condition independently, returns a per-condition pass/fail
 * trace. Drives /api/predicate/explain so users can debug "why didn't my
 * filter catch this event?". Unlike `evaluate`, this does NOT short-circuit
 * on the first failure, every step is recorded.
 */
function traceNode(node: PredicateNode, event: TransferEvent, path: string, trace: ExplainStep[]): boolean {
  if (isAndGroup(node)) {
    let allPass = true;
    node.and.forEach((child, i) => { if (!traceNode(child, event, `${path}.and[${i}]`, trace)) allPass = false; });
    return allPass;
  }
  if (isOrGroup(node)) {
    let anyPass = false;
    node.or.forEach((child, i) => { if (traceNode(child, event, `${path}.or[${i}]`, trace)) anyPass = true; });
    return anyPass;
  }
  const cond = node;
  const lhs = getField(event as unknown as Record<string, unknown>, cond.field);
  let pass: boolean;
  let reason: string;
  if (lhs === undefined) { pass = false; reason = `field "${cond.field}" missing from event ✗`; }
  else { pass = compare(lhs, cond.op, cond.value); reason = describe(lhs, cond.op, cond.value, pass); }
  trace.push({ index: trace.length, field: cond.field, op: cond.op, expected: cond.value, actual: lhs, pass, reason, group: path });
  return pass;
}

export function evaluateWithTrace(predicate: Predicate, event: TransferEvent): ExplainResult {
  const trace: ExplainStep[] = [];
  let allPass = true;
  predicate.and.forEach((node, i) => { if (!traceNode(node, event, `and[${i}]`, trace)) allPass = false; });
  const passed = trace.filter((s) => s.pass).length;
  return { match: allPass, conditions_total: trace.length, conditions_passed: passed, trace };
}
