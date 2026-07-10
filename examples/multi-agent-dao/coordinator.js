/**
 * Sluice → Multi-Agent DAO coordinator, Buildathon Direction #3.
 *
 * Sluice matches an on-chain governance / treasury event (e.g. a large treasury
 * inflow) and POSTs it to THIS server's /webhook. That single push is the
 * trigger: the coordinator fans the event out to a swarm of specialized agents
 * that deliberate CONCURRENTLY, then tallies their votes and would execute.
 *
 *   Sluice ──POST /webhook──▶ coordinator
 *                                 ├─▶ riskAgent()     ┐
 *                                 ├─▶ treasuryAgent() ├─ Promise.all (concurrent)
 *                                 └─▶ legalAgent()    ┘
 *                                 └─▶ tally → approve if >=2 approve → execute / reject
 *
 * Each agent asks a REAL LLM (Anthropic Claude) for its vote when
 * ANTHROPIC_API_KEY is set, and falls back to a deterministic rule-based
 * heuristic otherwise, so the demo still runs with zero API keys and a
 * reproducible transcript. See README "AI decisions".
 *
 * Required env:
 *   SLUICE_WEBHOOK_SECRET   shared HMAC secret (matches the Sluice subscription's secret).
 *                           If unset, the server still runs but flags deliveries as unsigned.
 *   PORT                    (optional, default: 8790)
 *   QUORUM                  (optional, default: 2) approve votes needed to pass.
 *   ANTHROPIC_API_KEY       (optional) if set, agents reason with Claude; if unset,
 *                           they fall back to the deterministic heuristic (offline-safe).
 *   SLUICE_AGENT_MODEL      (optional, default: claude-sonnet-5) Claude model to use.
 */
'use strict';

const express = require('express');
const { createHmac, timingSafeEqual } = require('node:crypto');
const Anthropic = require('@anthropic-ai/sdk');

const oneLine = (v) => String(v).replace(/[\r\n]/g, ' ');

const SLUICE_WEBHOOK_SECRET = process.env.SLUICE_WEBHOOK_SECRET; // optional but recommended
const PORT = Number(process.env.PORT || 8790);
const QUORUM = Number(process.env.QUORUM || 2); // approve votes required to pass

const MOTES_PER_CSPR = 1_000_000_000n;

// Default model each agent reasons with; override with SLUICE_AGENT_MODEL.
const AGENT_MODEL = process.env.SLUICE_AGENT_MODEL || 'claude-sonnet-5';

/* ───────────────────────── HMAC verification ─────────────────────────
 * Same scheme the Sluice matcher uses (and the same one @sluice/client's
 * sluiceExpress middleware implements): the signature header is
 *   X-Sluice-Signature: sha256=<hex HMAC-SHA256 of the RAW request body>
 * We capture raw bytes so the HMAC matches byte-for-byte, then compare in
 * constant time. This file inlines it so the example runs standalone.
 */

function computeSignature(rawBody, secret) {
  return 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
}

function verifyHmacSignature(rawBody, signature, secret) {
  if (!signature) return false;
  const expected = Buffer.from(computeSignature(rawBody, secret), 'utf8');
  const got = Buffer.from(signature, 'utf8');
  if (expected.length !== got.length) return false;
  try { return timingSafeEqual(expected, got); } catch { return false; }
}

/** Express middleware: buffer raw body, verify signature, parse JSON. */
function sluiceWebhook(secret) {
  return (req, res, next) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const sig = req.headers['x-sluice-signature'];
      const verified = secret ? verifyHmacSignature(raw, sig, secret) : false;
      if (secret && !verified) { res.status(401).json({ error: 'invalid X-Sluice-Signature' }); return; }
      let parsed;
      try { parsed = JSON.parse(raw.toString('utf8')); }
      catch { res.status(400).json({ error: 'body is not valid JSON' }); return; }
      req.body = parsed;
      req.sluice = {
        verified,
        idempotencyKey: req.headers['x-sluice-idempotency-key'],
        subId: req.headers['x-sluice-sub-id'],
      };
      next();
    });
    req.on('error', next);
  };
}

/* ────────────────────────── helpers ────────────────────────── */

/** motes (string) → whole CSPR as a BigInt (floor). */
function motesToCspr(motes) {
  try { return BigInt(motes) / MOTES_PER_CSPR; } catch { return 0n; }
}

/** Normalize the Sluice envelope into the fields the agents reason over. */
function extractProposal(payload) {
  const ev = (payload && payload.event) || payload || {};
  return {
    amountMotes: ev.amount || '0',
    cspr: motesToCspr(ev.amount || '0'),
    to: ev.to_account_hash || '(unknown)',
    from: ev.initiator_account_hash || '(unknown)',
    deployHash: ev.deploy_hash || '(unknown)',
    blockHeight: ev.block_height,
    timestamp: ev.timestamp || new Date().toISOString(),
    subscriptionId: payload && payload.subscription_id,
  };
}

/** Truncate an account hash for prompts/logs. */
function short(s) {
  s = String(s);
  return s.length > 20 ? s.slice(0, 14) + '…' + s.slice(-4) : s;
}

/* ─────────────────────── real LLM helper (Anthropic Claude) ───────────────────────
 * askClaude is the single place we talk to the model, shared by all three
 * agents so auth, model selection, and prompt caching live in one spot. When
 * ANTHROPIC_API_KEY is set the agents reason with Claude; when it isn't, this
 * THROWS a clearly-typed error each agent catches to fall back to its heuristic,
 * so the swarm still deliberates fully offline. */

class MissingApiKeyError extends Error {
  constructor() {
    super('ANTHROPIC_API_KEY is not set');
    this.name = 'MissingApiKeyError';
  }
}

/**
 * Ask Claude a single-turn question and return the model's text. The system
 * prompt carries `cache_control: ephemeral` so each persona's instructions hit
 * the prompt cache across events (a Claude API best practice).
 */
async function askClaude(systemPrompt, userPrompt, { model = AGENT_MODEL, maxTokens = 300 } = {}) {
  if (!process.env.ANTHROPIC_API_KEY) throw new MissingApiKeyError();
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const msg = await anthropic.messages.create({
    model,
    max_tokens: maxTokens,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userPrompt }],
  });
  return msg.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

/** Pull the first {...} block out of a model reply and JSON.parse it (defensive). */
function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) throw new Error('no JSON object in model reply');
  return JSON.parse(text.slice(start, end + 1));
}

const VOTES = new Set(['approve', 'reject', 'abstain']);

/**
 * Ask one specialized agent (persona = its system prompt) for a structured vote
 * on the proposal, then validate the JSON. Throws on missing key or any
 * parse/enum failure so the caller can fall back to its heuristic.
 */
async function askAgentVote(systemPrompt, proposal) {
  const userPrompt =
    `Treasury movement to vote on:\n` +
    `- amount: ${proposal.cspr} CSPR\n` +
    `- from: ${short(proposal.from)}\n` +
    `- to: ${short(proposal.to)}\n` +
    `- deploy: ${short(proposal.deployHash)}  block ${proposal.blockHeight ?? '?'}\n` +
    `Cast your vote and reply with the strict JSON verdict.`;
  const text = await askClaude(systemPrompt, userPrompt);
  const parsed = extractJson(text);
  const vote = String(parsed.vote || '').toLowerCase();
  if (!VOTES.has(vote)) throw new Error(`invalid vote from model: ${parsed.vote}`);
  return { vote, reason: String(parsed.reason || '').slice(0, 400) || 'model gave no reason' };
}

/**
 * Wrap a heuristic agent with the LLM path: try Claude first, fall back to the
 * heuristic on a missing key or any parse/enum failure. Tags each opinion with
 * `decidedBy` and logs which path was used so a judge can see the model decide.
 */
async function withLlmFallback(persona, systemPrompt, proposal, heuristic) {
  try {
    const out = await askAgentVote(systemPrompt, proposal);
    console.log(`[${persona}] decided by: ${AGENT_MODEL}`);
    return { ...out, decidedBy: AGENT_MODEL };
  } catch (e) {
    if (!(e instanceof MissingApiKeyError)) {
      console.warn(`[${persona}] LLM unavailable, using heuristic`);
    }
    const out = await heuristic(proposal);
    console.log(`[${persona}] decided by: heuristic`);
    return { ...out, decidedBy: 'heuristic' };
  }
}

const RISK_SYSTEM_PROMPT =
  'You are a DAO risk officer. Judge the blast radius / exposure of a treasury movement. ' +
  'Very large single transactions (roughly 1M+ CSPR) are risky enough to reject pending manual review; ' +
  'mid-size amounts are approvable but monitored; small amounts are routine. ' +
  'Reply with STRICT JSON only: {"vote":"approve|reject|abstain","reason":"..."}.';

const TREASURY_SYSTEM_PROMPT =
  'You are a DAO treasury manager. Judge the impact of this movement on reserves and runway. ' +
  'In this context the watched event is a treasury INFLOW, so more funds strengthen the treasury; ' +
  'abstain only if the amount is zero or undecodable. ' +
  'Reply with STRICT JSON only: {"vote":"approve|reject|abstain","reason":"..."}.';

const LEGAL_SYSTEM_PROMPT =
  'You are DAO compliance counsel. Judge legal / sanctions / KYC exposure of a treasury movement. ' +
  'Reject clearly sanctioned or blocklisted counterparties; abstain above a large reporting threshold ' +
  '(roughly 1M+ CSPR) pending a filed disclosure; otherwise approve. ' +
  'Reply with STRICT JSON only: {"vote":"approve|reject|abstain","reason":"..."}.';

/* ══════════════════════════════════════════════════════════════════════
 *  THE AGENT SWARM
 *
 *  Each agent is an async function that receives the normalized proposal and
 *  returns { vote: 'approve' | 'reject' | 'abstain', reason }.
 *
 *  Each agent asks a REAL LLM (Claude) via withLlmFallback() when
 *  ANTHROPIC_API_KEY is set, and otherwise runs the deterministic HEURISTIC in
 *  its `--- HEURISTIC ---` block, so the demo runs with no API keys and a
 *  reproducible transcript. The heuristics are kept intact and always callable.
 * ════════════════════════════════════════════════════════════════════════ */

/**
 * Risk Agent, judges blast radius. Large, sudden movements are riskier.
 * Asks Claude when a key is present; otherwise runs riskHeuristic().
 */
async function riskAgent(p) {
  return withLlmFallback('risk', RISK_SYSTEM_PROMPT, p, riskHeuristic);
}

async function riskHeuristic(p) {
  // --- HEURISTIC: deterministic risk-officer policy (offline fallback) ---
  const cspr = p.cspr;
  if (cspr >= 1_000_000n) {
    return { vote: 'reject', reason: `Movement of ${cspr} CSPR exceeds the 1M single-tx risk ceiling; requires manual review.` };
  }
  if (cspr >= 100_000n) {
    return { vote: 'approve', reason: `${cspr} CSPR is large but within the 100k, 1M managed band; monitored approval.` };
  }
  return { vote: 'approve', reason: `${cspr} CSPR is a routine amount, negligible blast radius.` };
  // --- END HEURISTIC ----------------------------------------------------
}

/**
 * Treasury Agent, judges whether the movement is healthy for the treasury.
 * Inflows are good; a well-known counterparty helps.
 * Asks Claude when a key is present; otherwise runs treasuryHeuristic().
 */
async function treasuryAgent(p) {
  return withLlmFallback('treasury', TREASURY_SYSTEM_PROMPT, p, treasuryHeuristic);
}

async function treasuryHeuristic(p) {
  // --- HEURISTIC: deterministic treasury-manager policy (offline fallback) ---
  const cspr = p.cspr;
  if (cspr <= 0n) {
    return { vote: 'abstain', reason: 'Zero/undecodable amount; nothing for the treasury to weigh in on.' };
  }
  // In this demo the watched event is a treasury INFLOW, so more is better.
  if (cspr >= 50_000n) {
    return { vote: 'approve', reason: `Inflow of ${cspr} CSPR materially strengthens runway; accept.` };
  }
  return { vote: 'approve', reason: `Inflow of ${cspr} CSPR is modest but positive for reserves.` };
  // --- END HEURISTIC ----------------------------------------------------
}

/**
 * Legal Agent, judges compliance. Flags counterparties on a (stub) blocklist
 * and anything above a reporting threshold that lacks review.
 * Asks Claude when a key is present; otherwise runs legalHeuristic().
 */
async function legalAgent(p) {
  return withLlmFallback('legal', LEGAL_SYSTEM_PROMPT, p, legalHeuristic);
}

async function legalHeuristic(p) {
  // --- HEURISTIC: deterministic compliance policy + local sanctions/KYC lookup ---
  const BLOCKLIST = new Set([
    // demo-only: an account hash we pretend is sanctioned
    'account-hash-0000000000000000000000000000000000000000000000000000000000',
  ]);
  if (BLOCKLIST.has(p.from) || BLOCKLIST.has(p.to)) {
    return { vote: 'reject', reason: 'Counterparty appears on the compliance blocklist; cannot proceed.' };
  }
  if (p.cspr >= 1_000_000n) {
    return { vote: 'abstain', reason: 'Above the 1M reporting threshold; defer pending a filed disclosure.' };
  }
  return { vote: 'approve', reason: 'No counterparty flags; below mandatory-reporting threshold.' };
  // --- END HEURISTIC ----------------------------------------------------
}

const AGENTS = [
  { name: 'Risk Agent', fn: riskAgent },
  { name: 'Treasury Agent', fn: treasuryAgent },
  { name: 'Legal Agent', fn: legalAgent },
];

/* ───────────────────── coordinator / tally ───────────────────── */

async function deliberate(proposal) {
  // Fan out: every agent forms its opinion at the same time.
  const opinions = await Promise.all(
    AGENTS.map(async (a) => {
      try {
        const { vote, reason, decidedBy } = await a.fn(proposal);
        return { agent: a.name, vote, reason, decidedBy: decidedBy || 'heuristic' };
      } catch (e) {
        // A failing agent abstains rather than blocking the whole vote.
        return { agent: a.name, vote: 'abstain', reason: `agent error: ${e.message}`, decidedBy: 'heuristic' };
      }
    }),
  );

  const approve = opinions.filter((o) => o.vote === 'approve').length;
  const reject = opinions.filter((o) => o.vote === 'reject').length;
  const abstain = opinions.filter((o) => o.vote === 'abstain').length;
  const passed = approve >= QUORUM;

  return { opinions, tally: { approve, reject, abstain, quorum: QUORUM }, passed };
}

/**
 * Execution seam. In production this is where the coordinator would BUILD and
 * SIGN a Casper deploy (e.g. via @sluice/client tx builders or the CSPR SDK)
 * to enact the DAO decision. Left as a log to avoid any accidental spend.
 */
async function execute(proposal, result) {
  console.log(`  ↳ EXECUTE: enacting proposal ${oneLine(proposal.deployHash)}, would submit on-chain deploy here (stubbed).`);
}

/** Pretty-print the whole deliberation so a judge sees the swarm think. */
function logTranscript(proposal, result, ctx) {
  const line = '─'.repeat(66);
  console.log(`\n╔${line}╗`);
  console.log(`  GOVERNANCE TRIGGER received from Sluice ${ctx.verified ? '🔒 verified' : '⚠️  unsigned'}`);
  console.log(`  proposal: ${proposal.cspr} CSPR treasury movement`);
  console.log(`    from ${oneLine(short(proposal.from))}  →  to ${oneLine(short(proposal.to))}`);
  console.log(`    deploy ${oneLine(short(proposal.deployHash))}  block ${oneLine(proposal.blockHeight ?? '?')}  sub_${oneLine(proposal.subscriptionId ?? '?')}`);
  console.log(`  ${line}`);
  const via = result.opinions.every((o) => o.decidedBy === 'heuristic')
    ? 'heuristic'
    : result.opinions[0].decidedBy;
  console.log(`  swarm deliberation (concurrent, decided by: ${via}):`);
  for (const o of result.opinions) {
    console.log(`    ${badge(o.vote)} ${o.agent.padEnd(15)} ${o.reason}`);
  }
  console.log(`  ${line}`);
  const t = result.tally;
  console.log(`  tally: ${t.approve} approve · ${t.reject} reject · ${t.abstain} abstain  (quorum ${t.quorum})`);
  console.log(`  DECISION: ${result.passed ? '✅ PASSED, executing' : '❌ REJECTED, no action'}`);
  console.log(`╚${line}╝`);
}

function badge(vote) {
  return vote === 'approve' ? '✅' : vote === 'reject' ? '⛔' : '➖';
}

/* ───────────────────────── server ───────────────────────── */

const app = express();

if (!SLUICE_WEBHOOK_SECRET) {
  console.warn('⚠️  SLUICE_WEBHOOK_SECRET is unset, deliveries will be accepted but flagged unsigned.');
}

app.post('/webhook', sluiceWebhook(SLUICE_WEBHOOK_SECRET), async (req, res) => {
  // Acknowledge fast; deliberation happens after the 200 so we never make
  // Sluice wait on agent latency (and never risk a redelivery mid-vote).
  res.sendStatus(200);

  const payload = req.body;
  if (!payload || typeof payload !== 'object') return;

  const proposal = extractProposal(payload);
  try {
    const result = await deliberate(proposal);
    logTranscript(proposal, result, req.sluice);
    if (result.passed) await execute(proposal, result);
  } catch (e) {
    console.error('deliberation error', e);
  }
});

app.get('/health', (_req, res) => res.json({ ok: true, agents: AGENTS.map((a) => a.name), quorum: QUORUM }));

app.listen(PORT, () => {
  console.log(`multi-agent DAO coordinator listening on :${PORT}`);
  console.log(`  agents: ${AGENTS.map((a) => a.name).join(', ')}  ·  quorum: ${QUORUM} approve`);
  console.log(`  waiting for Sluice governance triggers on POST /webhook …`);
});

module.exports = {
  deliberate,
  riskAgent,
  treasuryAgent,
  legalAgent,
  riskHeuristic,
  treasuryHeuristic,
  legalHeuristic,
  askClaude,
  extractProposal,
  computeSignature,
};
