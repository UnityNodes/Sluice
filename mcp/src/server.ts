#!/usr/bin/env node
/**
 * Sluice MCP server, exposes Casper event subscriptions to AI agents.
 *
 *   Tool                         | Effect
 *   ---------------------------- | --------------------------------------------------
 *   subscribe_to_events          | Wraps `sluice subscribe ...`, locks CSPR, stores predicate
 *   list_subscriptions           | Returns the subscriptions owned by --owner
 *   cancel_subscription          | Refunds and deactivates a subscription
 *   recent_deliveries            | Returns the last N deliveries seen by the matcher
 *   sluice_sandbox_dispatch      | Fires N webhooks at a URL with NO on-chain effect, receiver development
 *
 * Transport: stdio (Claude Code, Codex compatible).
 * Register in Claude Code:
 *   claude mcp add-json sluice '{"command":"sluice-mcp"}'
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import { PREDICATE_SCHEMA } from './predicate-schema.js';

const SUBSCRIBE_TOOL = {
  name: 'subscribe_to_events',
  description:
    'Lock CSPR into the Sluice on-chain subscription registry, with a predicate over Casper Transfer events and a webhook URL. ' +
    'Returns the tx hash and the assigned subscription id.',
  inputSchema: {
    type: 'object',
    properties: {
      predicate_json: {
        type: 'string',
        description: 'JSON predicate, shape {"and":[{"field":"...","op":"eq|neq|gt|gte|lt|lte","value":"..."}, ...]}',
      },
      webhook_url: {
        type: 'string',
        description: 'HTTPS URL where matched events should be POSTed',
      },
      amount_cspr: {
        type: 'integer',
        description: 'CSPR to lock as escrow (integer)',
        minimum: 1,
      },
    },
    required: ['predicate_json', 'webhook_url', 'amount_cspr'],
  },
} as const;

const LIST_TOOL = {
  name: 'list_subscriptions',
  description: 'List the subscriptions owned by the configured subscriber key.',
  inputSchema: { type: 'object', properties: {} },
} as const;

const CANCEL_TOOL = {
  name: 'cancel_subscription',
  description: 'Cancel a subscription by id; remaining balance is refunded to the subscriber.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'integer', minimum: 1 } },
    required: ['id'],
  },
} as const;

export const SANDBOX_TOOL = {
  name: 'sluice_sandbox_dispatch',
  description:
    'Fire N synthetic-or-buffered Casper Transfer events at a webhook URL with no on-chain effect and no CSPR spent. ' +
    'Use this to help the user develop their webhook receiver, for example, "POST 5 whale transfer events at https://my.app/hook to test my HMAC verifier". ' +
    'The optional predicate filters which historical buffer events to use; missing matches are topped up with synthetic events. ' +
    'When SLUICE_WEBHOOK_SECRET is set on the matcher, the X-Sluice-Signature HMAC header is sent on every POST.',
  inputSchema: {
    type: 'object',
    properties: {
      webhook_url: { type: 'string', description: 'HTTP/HTTPS URL to POST synthetic events to' },
      predicate_json: { type: 'string', description: 'Optional JSON predicate to filter buffer events first' },
      count: { type: 'number', description: 'How many events to send (1..10, default 3)' },
      api_url: { type: 'string', description: 'Sluice matcher API base URL (default https://sluice.unitynodes.com/api or env SLUICE_API_URL)' },
    },
    required: ['webhook_url'],
  },
} as const;

export const RECENT_TOOL = {
  name: 'recent_deliveries',
  description: 'Return the last N deliveries seen by the local matcher (if connected).',
  inputSchema: {
    type: 'object',
    properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
  },
} as const;

const TOOLS = [SUBSCRIBE_TOOL, LIST_TOOL, CANCEL_TOOL, RECENT_TOOL, SANDBOX_TOOL];

const SubscribeArgs = z.object({
  predicate_json: z.string().min(1),
  webhook_url: z.string().url(),
  amount_cspr: z.number().int().positive(),
});

const CancelArgs = z.object({ id: z.number().int().positive() });
export const RecentArgs = z.object({ limit: z.number().int().positive().max(100).optional() });
export const SandboxArgs = z.object({
  webhook_url: z.string().url(),
  predicate_json: z.string().optional(),
  count: z.number().int().positive().max(10).optional(),
  api_url: z.string().url().optional(),
});

async function runSluiceCancel(args: z.infer<typeof CancelArgs>): Promise<string> {
  const child = spawn(
    process.env.SLUICE_CLI_BIN ?? 'sluice',
    ['cancel', '--id', String(args.id)],
    { env: process.env },
  );
  return await new Promise<string>((resolve, reject) => {
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`sluice cancel exit ${code}: ${stderr || stdout}`));
    });
  });
}

async function runSluiceSubscribe(args: z.infer<typeof SubscribeArgs>): Promise<string> {
  // Write the predicate to a temp file because the CLI expects a path. A
  // predictable name in a shared /tmp lets another user pre-create it as a
  // symlink, so own the directory and keep the predicate private.
  const fs = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const tmpDir = await fs.mkdtemp(join(tmpdir(), 'sluice-mcp-'));
  const tmpFile = join(tmpDir, 'predicate.json');
  await fs.writeFile(tmpFile, args.predicate_json, { encoding: 'utf8', mode: 0o600 });

  const child = spawn(
    process.env.SLUICE_CLI_BIN ?? 'sluice',
    ['subscribe',
      '--predicate', tmpFile,
      '--webhook', args.webhook_url,
      '--amount', String(args.amount_cspr),
    ],
    { env: process.env },
  );

  return await new Promise<string>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
      if (code === 0) resolve(stdout);
      else reject(new Error(`sluice subscribe failed (exit ${code}): ${stderr || stdout}`));
    });
  });
}

/* ─────────────────── resources ─────────────────── */
// Exposing matcher state as MCP resources lets Claude/Codex read snapshot
// data without making a tool call. Resources are pull-fetched on demand from
// the configured matcher API base.

export const RESOURCES = [
  {
    uri: 'sluice://snapshot',
    mimeType: 'application/json',
    name: 'Matcher snapshot',
    description: 'Full /api/snapshot.json, contract hash, chain, subscriptions, recent deliveries. Refreshed by the matcher every ~5s.',
  },
  {
    uri: 'sluice://subs',
    mimeType: 'application/json',
    name: 'Subscriptions',
    description: 'Just the subscriptions array from the snapshot, id, owner, predicate, webhook_url, balance, deliveries, active, created_at.',
  },
  {
    uri: 'sluice://recent-events',
    mimeType: 'application/json',
    name: 'Recent deliveries',
    description: 'Last 20 webhook deliveries the matcher dispatched, subscription_id, status, tx_hash, latency, full payload.',
  },
  {
    uri: 'sluice://predicate-schema',
    mimeType: 'application/schema+json',
    name: 'Predicate JSON Schema',
    description: 'Draft 2020-12 schema for the AND-of-conditions predicate format. Use to validate or build predicates.',
  },
] as const;

export const RESOURCE_TEMPLATES = [
  {
    uriTemplate: 'sluice://sub/{id}',
    name: 'Subscription by id',
    mimeType: 'application/json',
    description: 'One subscription record by integer id, fields: owner, predicate, webhook_url, balance, deliveries, active, created_at.',
  },
  {
    uriTemplate: 'sluice://sub/{id}/events',
    name: 'Recent deliveries for one subscription',
    mimeType: 'application/json',
    description: 'Filter the matcher\'s recent_events ring buffer to one subscription id. Newest first.',
  },
  {
    uriTemplate: 'sluice://metrics/{name}',
    name: 'Single metric value',
    mimeType: 'application/json',
    description: 'Resolve one Prometheus metric value by name. Examples: sluice_deliveries_total, sluice_subscriptions, sluice_ws_connected.',
  },
] as const;

export async function readResource(uri: string): Promise<{ uri: string; mimeType: string; text: string }> {
  const apiBase = (process.env.SLUICE_API_URL ?? 'https://sluice.unitynodes.com/api').replace(/\/$/, '');

  // Templated URIs, parameterised reads.
  const subMatch = uri.match(/^sluice:\/\/sub\/(\d+)$/);
  if (subMatch) {
    const id = Number(subMatch[1]);
    const r = await fetch(`${apiBase}/snapshot.json`);
    if (!r.ok) throw new Error(`snapshot HTTP ${r.status}`);
    const j = await r.json() as { subscriptions: Array<{ id: number }> };
    const sub = j.subscriptions.find((s) => s.id === id);
    if (!sub) throw new Error(`subscription ${id} not in matcher view`);
    return { uri, mimeType: 'application/json', text: JSON.stringify(sub, null, 2) };
  }
  const subEventsMatch = uri.match(/^sluice:\/\/sub\/(\d+)\/events$/);
  if (subEventsMatch) {
    const id = Number(subEventsMatch[1]);
    const r = await fetch(`${apiBase}/snapshot.json`);
    if (!r.ok) throw new Error(`snapshot HTTP ${r.status}`);
    const j = await r.json() as { recent_events: Array<{ subscription_id: number }> };
    const events = j.recent_events.filter((e) => e.subscription_id === id);
    return { uri, mimeType: 'application/json', text: JSON.stringify(events, null, 2) };
  }
  const metricMatch = uri.match(/^sluice:\/\/metrics\/([a-zA-Z0-9_]+)$/);
  if (metricMatch) {
    const name = metricMatch[1];
    const r = await fetch(`${apiBase}/metrics`);
    if (!r.ok) throw new Error(`metrics HTTP ${r.status}`);
    const text = await r.text();
    const lines = text.split('\n').filter((l) => l.startsWith(name + ' ') || l.startsWith(name + '{'));
    if (lines.length === 0) throw new Error(`metric ${name} not found`);
    const values = lines.map((l) => {
      const m = l.match(/^([a-zA-Z0-9_]+)(\{[^}]*\})?\s+(.+)$/);
      return m ? { name: m[1], labels: m[2] ?? '', value: m[3].trim() } : { raw: l };
    });
    return { uri, mimeType: 'application/json', text: JSON.stringify(values, null, 2) };
  }

  switch (uri) {
    case 'sluice://snapshot': {
      const r = await fetch(`${apiBase}/snapshot.json`);
      if (!r.ok) throw new Error(`snapshot HTTP ${r.status}`);
      return { uri, mimeType: 'application/json', text: await r.text() };
    }
    case 'sluice://subs': {
      const r = await fetch(`${apiBase}/snapshot.json`);
      if (!r.ok) throw new Error(`snapshot HTTP ${r.status}`);
      const j = await r.json() as { subscriptions: unknown[] };
      return { uri, mimeType: 'application/json', text: JSON.stringify(j.subscriptions ?? [], null, 2) };
    }
    case 'sluice://recent-events': {
      const r = await fetch(`${apiBase}/snapshot.json`);
      if (!r.ok) throw new Error(`snapshot HTTP ${r.status}`);
      const j = await r.json() as { recent_events: unknown[] };
      return { uri, mimeType: 'application/json', text: JSON.stringify(j.recent_events ?? [], null, 2) };
    }
    case 'sluice://predicate-schema': {
      // Served from the bundle rather than fetched: the hosted server talks to
      // the matcher API, which has no static file route, so fetching returned
      // 405. Embedding also makes the resource work offline over stdio.
      return {
        uri,
        mimeType: 'application/schema+json',
        text: JSON.stringify(PREDICATE_SCHEMA, null, 2),
      };
    }
    default:
      throw new Error(`unknown resource uri: ${uri}`);
  }
}

/* ─────────────────── prompts ─────────────────── */
// Bundled prompt templates. Claude Code / Codex surface these in the slash-
// command menu (e.g. `/mcp__sluice__sluice-build-watcher`), so the user can
// run a guided flow from inside the IDE.

export const PROMPTS = [
  {
    name: 'sluice-build-watcher',
    description: 'Guide the user through building a new Sluice subscription end-to-end, recipe choice, dry-run, sign, watch.',
    arguments: [
      { name: 'goal', description: 'What the user wants to watch, free-form. Examples: "whales over 100k CSPR", "transfers to my treasury", "anyone topping up sub_3"', required: true },
      { name: 'webhook_url', description: 'Where to POST matched events. Use /h/<slug> for a sluice-hosted receiver if the user has no server.', required: false },
    ],
  },
  {
    name: 'sluice-debug-sub',
    description: 'Investigate why a subscription is not firing the expected webhooks. Walks: snapshot → predicate.explain on a known event → recent deliveries.',
    arguments: [
      { name: 'subscription_id', description: 'The sub id to investigate', required: true },
      { name: 'expected_event', description: 'Optional, paste a Transfer event you expected to match (JSON) so we can run predicate/explain on it.', required: false },
    ],
  },
] as const;

export function buildPromptMessages(name: string, args: Record<string, string>): { description: string; messages: Array<{ role: 'user' | 'assistant'; content: { type: 'text'; text: string } }> } {
  switch (name) {
    case 'sluice-build-watcher': {
      const goal = args.goal || '(unspecified)';
      const webhook = args.webhook_url || 'https://sluice.unitynodes.com/api/hooks/my-test-slug';
      return {
        description: `Build a Sluice subscription for: ${goal}`,
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: [
              `I want to watch Casper on-chain events. Goal: **${goal}**.`,
              '',
              'Help me build a Sluice subscription end-to-end:',
              '',
              `1. Translate the goal into a predicate. Use the predicate JSON Schema at \`sluice://predicate-schema\` for the shape. ${args.goal ? 'You can pass the goal to the matcher\'s plain-English parser via:' : 'Suggest a starting predicate based on common patterns.'}`,
              args.goal ? `   \`\`\`bash` : '',
              args.goal ? `   sluice ai ${JSON.stringify(args.goal)} --validate` : '',
              args.goal ? `   \`\`\`` : '',
              '   (or use the sluice_sandbox_dispatch tool to dry-run candidates without spending CSPR.)',
              '',
              '2. Validate it: call the `recent_deliveries` tool (or read `sluice://snapshot`) to see what the matcher has been seeing lately, then use `sluice_sandbox_dispatch` with `predicate` set to confirm matches.',
              '',
              `3. Once we're happy, call \`subscribe_to_events\` with the final predicate JSON, webhook_url \`${webhook}\`, and a sensible \`amount_cspr\` (10 is fine for testing, that locks 10 CSPR into the registry).`,
              '',
              '4. After submit, watch the first few deliveries land. The user can run `sluice tail --sub <id>` themselves, or you can poll `sluice://recent-events` here.',
              '',
              'Confirm each step with me before moving on. Start with step 1.',
            ].filter(Boolean).join('\n'),
          },
        }],
      };
    }
    case 'sluice-debug-sub': {
      const id = args.subscription_id || '?';
      const expected = args.expected_event;
      return {
        description: `Debug Sluice subscription #${id}`,
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Subscription **sub_${id}** isn't firing as expected. Help me diagnose.`,
              '',
              `Walk this in order:`,
              '',
              `1. Read \`sluice://subs\` and find sub_${id}. Confirm it's \`active: true\` and has a non-zero \`balance\`. If it's inactive, the escrow ran dry: top it up from the dashboard, which builds the on-chain top-up transaction for your wallet to sign.`,
              '',
              '2. Pull `sluice://recent-events` and filter entries with that subscription_id. If the matcher has seen recent deliveries, the issue is on the receiver side (look at `status` codes). If there are none recent, the predicate may be too strict.',
              '',
              expected
                ? `3. The user provided an event they expected to match, run \`sluice ai\` first to remind ourselves what the predicate says, then call the predicate/explain endpoint on the matcher (via the \`sluice_sandbox_dispatch\` tool with a contrived predicate that should match, or recommend that the user POST to /api/predicate/explain directly). Expected event JSON:\n\n\`\`\`json\n${expected}\n\`\`\``
                : '3. If you have a Transfer event you expect to match, paste it and we\'ll run /api/predicate/explain on it to see condition-by-condition what passed and what failed.',
              '',
              '4. Summarise: probable cause + concrete next step (top-up / loosen predicate / fix receiver / replay-last).',
            ].join('\n'),
          },
        }],
      };
    }
    default:
      throw new Error(`unknown prompt: ${name}`);
  }
}

async function main(): Promise<void> {
  const server = new Server(
    { name: 'sluice-mcp', version: '0.2.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: RESOURCES }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: RESOURCE_TEMPLATES }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const r = await readResource(req.params.uri);
    return { contents: [r] };
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS }));
  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, string>;
    return buildPromptMessages(req.params.name, args);
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: rawArgs } = req.params;

    try {
      switch (name) {
        case SUBSCRIBE_TOOL.name: {
          const args = SubscribeArgs.parse(rawArgs);
          const output = await runSluiceSubscribe(args);
          return { content: [{ type: 'text', text: output }] };
        }
        case LIST_TOOL.name: {
          const snapshotPath = process.env.SLUICE_SNAPSHOT_PATH ?? '/tmp/sluice-snapshot.json';
          const fs = await import('node:fs/promises');
          try {
            const raw = await fs.readFile(snapshotPath, 'utf8');
            return { content: [{ type: 'text', text: raw }] };
          } catch (e) {
            return {
              content: [{ type: 'text', text: `Snapshot not available at ${snapshotPath}: ${(e as Error).message}. Is sluice-matcher running with SLUICE_SNAPSHOT_PATH set?` }],
              isError: true,
            };
          }
        }
        case CANCEL_TOOL.name: {
          const args = CancelArgs.parse(rawArgs);
          const output = await runSluiceCancel(args);
          return { content: [{ type: 'text', text: output }] };
        }
        case RECENT_TOOL.name: {
          const args = RecentArgs.parse(rawArgs);
          const limit = args.limit ?? 20;
          const snapshotPath = process.env.SLUICE_SNAPSHOT_PATH ?? '/tmp/sluice-snapshot.json';
          const fs = await import('node:fs/promises');
          try {
            const raw = JSON.parse(await fs.readFile(snapshotPath, 'utf8')) as { recent_events?: unknown[] };
            // This tool returns deliveries, not subscriptions. The snapshot
            // keeps them under recent_events; returning subscriptions here (the
            // old behaviour) answered "last N deliveries" with the wrong data.
            const deliveries = (raw.recent_events ?? []).slice(0, limit);
            return { content: [{ type: 'text', text: JSON.stringify(deliveries, null, 2) }] };
          } catch (e) {
            return {
              content: [{ type: 'text', text: `Snapshot unavailable: ${(e as Error).message}` }],
              isError: true,
            };
          }
        }
        case SANDBOX_TOOL.name: {
          const args = SandboxArgs.parse(rawArgs);
          const apiUrl = (args.api_url ?? process.env.SLUICE_API_URL ?? 'https://sluice.unitynodes.com/api').replace(/\/$/, '');
          let predicate: unknown = null;
          if (args.predicate_json) {
            try { predicate = JSON.parse(args.predicate_json); }
            catch (e) { return { content: [{ type: 'text', text: `predicate_json is not valid JSON: ${(e as Error).message}` }], isError: true }; }
          }
          const r = await fetch(`${apiUrl}/sandbox/dispatch`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ webhook: args.webhook_url, predicate, count: args.count ?? 3 }),
          });
          const text = await r.text();
          if (!r.ok) return { content: [{ type: 'text', text: `sandbox dispatch HTTP ${r.status}: ${text.slice(0, 400)}` }], isError: true };
          return { content: [{ type: 'text', text }] };
        }
        default:
          return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
      }
    } catch (e) {
      const msg = (e as Error).message;
      return { content: [{ type: 'text', text: `error: ${msg}` }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Stdio transport keeps the process alive on stdin.
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
