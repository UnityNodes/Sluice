#!/usr/bin/env node
/**
 * Sluice MCP server, Streamable-HTTP transport (hosted variant).
 *
 * What this is:
 *   The same Sluice MCP that runs over stdio (server.ts), but listening on
 *   HTTP at /mcp so MCP clients can connect via URL, no `npm i -g`, no local
 *   process, just:
 *
 *     claude mcp add sluice https://sluice.unitynodes.com/mcp
 *
 * What this is NOT:
 *   A way to subscribe / cancel from a remote agent. Those tools require a
 *   Casper secret key for signing on-chain deploys; serving them publicly
 *   would let strangers move someone else's CSPR. They stay stdio-only.
 *
 * Hosted MCP exposes the read-only surface, recent_deliveries +
 * sluice_sandbox_dispatch (no on-chain effect), plus every resource and
 * prompt the stdio server has.
 *
 * Stateless mode: every POST creates a fresh transport, server's lifetime ==
 * single request. No session ID, no resumability, keeps the deploy simple.
 *
 *   PORT (default 7800), bind port
 *   SLUICE_MCP_PUBLIC_URL, used in advertised links only (optional)
 *   SLUICE_API_URL, matcher base, propagated from server.ts (default https://sluice.unitynodes.com/api)
 */

import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import {
  RECENT_TOOL, SANDBOX_TOOL, RecentArgs, SandboxArgs,
  RESOURCES, RESOURCE_TEMPLATES, readResource,
  PROMPTS, buildPromptMessages,
} from './server.js';

const PORT = Number(process.env.PORT || 7800);
// Loopback by default: Caddy proxies to it, so it never needs to answer on the
// public IP directly. Set HOST=0.0.0.0 only to expose it without a proxy.
const HOST = process.env.HOST || '127.0.0.1';

/** Build a fresh MCP server pre-wired with read-only tools + every resource/prompt. */
function buildServer(): Server {
  const server = new Server(
    { name: 'sluice-mcp-http', version: '0.2.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  // Read-only tool set. Subscribe + cancel are stdio-only, see file header.
  const TOOLS = [RECENT_TOOL, SANDBOX_TOOL];
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
        case RECENT_TOOL.name: {
          const args = RecentArgs.parse(rawArgs);
          const limit = args.limit ?? 20;
          const apiBase = (process.env.SLUICE_API_URL ?? 'https://sluice.unitynodes.com/api').replace(/\/$/, '');
          const r = await fetch(`${apiBase}/snapshot.json`);
          if (!r.ok) return { content: [{ type: 'text', text: `snapshot HTTP ${r.status}` }], isError: true };
          const j = await r.json() as { subscriptions?: unknown[]; recent_events?: unknown[] };
          const recent = (j.recent_events ?? []).slice(0, limit);
          return { content: [{ type: 'text', text: JSON.stringify(recent, null, 2) }] };
        }
        case SANDBOX_TOOL.name: {
          const args = SandboxArgs.parse(rawArgs);
          // SECURITY: never let a remote caller choose the fetch target here.
          // On the hosted, unauthenticated endpoint an attacker-supplied
          // api_url would be a server-side request forgery primitive with
          // response reflection (e.g. cloud metadata). The matcher base is
          // fixed by the operator's env; args.api_url is deliberately ignored.
          const apiUrl = (process.env.SLUICE_API_URL ?? 'https://sluice.unitynodes.com/api').replace(/\/$/, '');
          let predicate: unknown = null;
          if (args.predicate_json) {
            try { predicate = JSON.parse(args.predicate_json); }
            catch (e) { return { content: [{ type: 'text', text: `predicate_json invalid: ${(e as Error).message}` }], isError: true }; }
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
          return { content: [{ type: 'text', text: `tool "${name}" not available over hosted MCP (subscribe / cancel sign with a local Casper key). Build the stdio server from the repo: git clone https://github.com/UnityNodes/Sluice && cd Sluice/mcp && npm install && npm run build && npm link` }], isError: true };
      }
    } catch (e) {
      return { content: [{ type: 'text', text: `error: ${(e as Error).message}` }], isError: true };
    }
  });

  return server;
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');

  // CORS, MCP clients may run from arbitrary origins.
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, mcp-session-id, accept, last-event-id');
  res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('access-control-expose-headers', 'mcp-session-id');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, name: 'sluice-mcp-http', version: '0.2.0' }));
    return;
  }
  // Stateless transport: a GET normally opens the server->client SSE stream for a
  // session, but there are no sessions here, so handleRequest would hang the
  // client. Answer 405 promptly and point at POST.
  if ((url.pathname === '/mcp' || url.pathname === '/' || url.pathname === '/mcp/') && req.method === 'GET') {
    res.writeHead(405, { 'content-type': 'application/json', allow: 'POST, OPTIONS' });
    res.end(JSON.stringify({ error: 'this MCP endpoint is stateless; use POST for JSON-RPC (initialize, tools/list, ...)' }));
    return;
  }
  if (url.pathname === '/' || url.pathname === '/mcp/') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(
      'Sluice hosted MCP, Streamable HTTP transport\n' +
      '\n' +
      'Add to Claude Code:\n' +
      `  claude mcp add sluice ${process.env.SLUICE_MCP_PUBLIC_URL || 'https://sluice.unitynodes.com/mcp'}\n` +
      '\n' +
      'POST your MCP JSON-RPC messages to /mcp.  Hosted surface is READ-ONLY:\n' +
      '  - tools:     recent_deliveries, sluice_sandbox_dispatch\n' +
      '  - resources: sluice://snapshot, sluice://subs, sluice://recent-events, etc.\n' +
      '  - prompts:   sluice-build-watcher, sluice-debug-sub\n' +
      '\n' +
      'For subscribe / cancel (requires local Casper key) use the stdio server:\n' +
      '  npm i -g @sluice/mcp && claude mcp add-json sluice \'{"command":"sluice-mcp"}\'\n');
    return;
  }
  if (url.pathname !== '/mcp') {
    res.writeHead(404); res.end('not found');
    return;
  }

  try {
    // Stateless per-request transport (matches the StreamableHTTPServerTransport
    // "no sessionIdGenerator" mode, keeps the deploy stateless and simple).
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = buildServer();
    await server.connect(transport);

    // For POST requests, MCP SDK needs the parsed JSON body.
    let parsedBody: unknown = undefined;
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim()) {
        try { parsedBody = JSON.parse(raw); }
        catch { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid JSON' })); return; }
      }
    }
    await transport.handleRequest(req, res, parsedBody);
    res.on('close', () => { transport.close().catch(() => undefined); server.close().catch(() => undefined); });
  } catch (e) {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: (e as Error).message }));
  }
});

httpServer.listen(PORT, HOST, () => {
  console.log(`sluice-mcp-http listening on http://${HOST}:${PORT}/mcp`);
});
