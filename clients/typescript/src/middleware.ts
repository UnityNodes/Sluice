/**
 * Drop-in HMAC-verify middleware for Sluice webhook receivers.
 *
 * Express:
 *
 *   import { sluiceExpress } from '@sluice/client/middleware';
 *   app.post('/hook', sluiceExpress(process.env.SLUICE_WEBHOOK_SECRET), (req, res) => {
 *     // req.body, parsed JSON envelope (Sluice payload)
 *     // req.sluice, { verified: true, eventHash, subscriptionId? }
 *     res.sendStatus(200);
 *   });
 *
 * Fastify:
 *
 *   import { sluiceFastify } from '@sluice/client/middleware';
 *   await fastify.register(sluiceFastify, { secret: process.env.SLUICE_WEBHOOK_SECRET });
 *
 * Both read the raw request body (so HMAC matches byte-for-byte), compare
 * the supplied signature in constant time, parse JSON, attach a `.sluice`
 * marker, and 401 on mismatch. If no secret is configured the middleware
 * still parses JSON but flags `verified: false`, useful for local dev.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Compute the same sha256=hex tag the matcher writes into X-Sluice-Signature. */
export function computeSignature(body: string | Buffer, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

/** Constant-time compare two `sha256=hex` signatures. */
export function verifyHmacSignature(rawBody: string | Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = computeSignature(rawBody, secret);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
}

/* ─────────────────── Express ─────────────────── */

interface ExpressReq {
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, fn: (chunk: any) => void): this;
  // a custom field we attach so handler code knows what happened
  sluice?: SluiceReqContext;
}
interface ExpressRes {
  status(code: number): ExpressRes;
  json(body: unknown): ExpressRes;
  end(): void;
}
type ExpressNext = (err?: unknown) => void;

export interface SluiceReqContext {
  verified: boolean;
  eventHash?: string;
  subscriptionId?: number;
  /** Raw bytes, kept so handlers that want to re-verify or forward can. */
  rawBody: Buffer;
}

/**
 * Express middleware factory. Must be mounted BEFORE any other body parser
 * for this route (otherwise the raw bytes will already have been consumed).
 */
export function sluiceExpress(secret: string | undefined): (req: ExpressReq, res: ExpressRes, next: ExpressNext) => void {
  return (req, res, next) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const sigHeader = req.headers['x-sluice-signature'];
      const sig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
      const verified = secret ? verifyHmacSignature(raw, sig, secret) : false;
      if (secret && !verified) { res.status(401).json({ error: 'invalid X-Sluice-Signature' }); return; }
      let parsed: { event_hash?: string; subscription_id?: number } | undefined;
      try { parsed = JSON.parse(raw.toString('utf8')); }
      catch { res.status(400).json({ error: 'body is not valid JSON' }); return; }
      req.body = parsed;
      req.sluice = {
        verified,
        eventHash: parsed?.event_hash,
        subscriptionId: parsed?.subscription_id,
        rawBody: raw,
      };
      next();
    });
    req.on('error', (e: Error) => next(e));
  };
}

/* ─────────────────── Fastify ─────────────────── */

interface FastifyInstance {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addContentTypeParser(contentType: string, opts: { parseAs: 'buffer' }, fn: (req: unknown, body: Buffer, done: (err: Error | null, body?: unknown) => void) => void): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addHook(name: 'preHandler', fn: (req: any, reply: any) => Promise<void>): void;
}
interface FastifyOpts { secret?: string }

/**
 * Fastify plugin, `await fastify.register(sluiceFastify, { secret })`.
 * Registers a JSON content-type parser that captures raw bytes for HMAC
 * verify, then a preHandler hook that runs the verify on every request.
 */
export async function sluiceFastify(fastify: FastifyInstance, opts: FastifyOpts): Promise<void> {
  const secret = opts.secret;
  fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    try { done(null, { __sluiceRaw: body, parsed: JSON.parse(body.toString('utf8')) }); }
    catch (e) { done(e as Error); }
  });
  fastify.addHook('preHandler', async (req, reply) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wrapped = (req as any).body as { __sluiceRaw?: Buffer; parsed?: { event_hash?: string; subscription_id?: number } } | undefined;
    if (!wrapped || !wrapped.__sluiceRaw) return;
    const sig = (req as { headers: Record<string, string | string[] | undefined> }).headers['x-sluice-signature'];
    const sigStr = Array.isArray(sig) ? sig[0] : sig;
    const verified = secret ? verifyHmacSignature(wrapped.__sluiceRaw, sigStr, secret) : false;
    if (secret && !verified) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (reply as any).code(401).send({ error: 'invalid X-Sluice-Signature' });
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req as any).body = wrapped.parsed;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req as any).sluice = {
      verified,
      eventHash: wrapped.parsed?.event_hash,
      subscriptionId: wrapped.parsed?.subscription_id,
      rawBody: wrapped.__sluiceRaw,
    };
  });
}
