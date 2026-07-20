# @sluice/client

Typed TypeScript/JavaScript wrapper for the [Sluice](https://sluice.unitynodes.com) matcher API, on-chain event subscriptions for Casper.

```bash
npm i @sluice/client
# optional, only if you want the live WebSocket stream and you're on Node < 22:
npm i ws
```

## Five-minute tour

```ts
import { SluiceClient } from '@sluice/client';

const sluice = new SluiceClient();   // defaults to https://sluice.unitynodes.com/api

// 1. inspect subs
const subs = await sluice.subs.list();
console.log(`${subs.length} subscriptions, ${subs.filter(s => s.active).length} active`);

// 2. dry-run a predicate against recent on-chain events before paying CSPR
const probe = await sluice.predicate.validate({
  and: [{ field: 'amount', op: 'gte', value: '100000000000000' }],  // ≥ 100k CSPR
});
console.log(`would match ${probe.matches}/${probe.total_scanned} events  (~${probe.estimated_per_day}/day)`);

// 3. why didn't this one match? per-condition trace
const why = await sluice.predicate.explain(predicate, event);
why.trace.forEach(t => console.log(t.pass ? '✓' : '✗', t.reason));

// 4. fire synthetic webhooks at your receiver without spending CSPR
await sluice.sandbox.dispatch('https://my.app/webhook', { count: 5 });

// 5. live stream of every delivery the matcher fans out
const close = sluice.stream.subscribe(
  (env) => console.log(env.type, env.data),
  { sub: 42, onOpen: () => console.log('connected') },
);
// ... later: close();
```

## In Node.js < 22

```ts
import WS from 'ws';
import { SluiceClient } from '@sluice/client';

const sluice = new SluiceClient({ websocketCtor: WS as unknown as typeof WebSocket });
```

## Self-host

Point at any matcher you control:

```ts
const sluice = new SluiceClient({ baseUrl: 'http://localhost:8080/api' });
```

## Reference

| Namespace            | Method                                  | Returns                                |
|----------------------|-----------------------------------------|----------------------------------------|
| `sluice`             | `health()`                              | `{ ok, contract, chain }`              |
| `sluice`             | `snapshot()`                            | full `Snapshot`                        |
| `sluice`             | `metricsText()`                         | Prometheus text body                   |
| `sluice`             | `badgeUrl(metric)`                      | URL string                             |
| `sluice.subs`        | `list()`                                | `Subscription[]`                       |
| `sluice.subs`        | `get(id)`                               | `Subscription \| null`                  |
| `sluice.subs`        | `replayLast(id, n=10)`                  | replay results                         |
| `sluice.subs`        | `ics(id)` / `og(id)`                    | URL strings                            |
| `sluice.predicate`   | `validate(predicate)`                   | dry-run result                         |
| `sluice.predicate`   | `explain(predicate, event)`             | per-condition trace                    |
| `sluice.sandbox`     | `dispatch(webhook, {predicate?,count?})`| webhook dispatch results               |
| `sluice.chain`       | `head()`                                | cached Casper chain head               |
| `sluice.stream`      | `subscribe(cb, {sub?,onOpen?,onError?,onClose?})` | close-fn          |
| `sluice.tx`          | `testWebhook(subId)` / `replay(hash)`   | dispatch result                        |

Errors throw `SluiceApiError` with `status` and the parsed response body.

## Webhook verification (`@sluice/client/middleware`)

A second entry point verifies the `X-Sluice-Signature` HMAC on incoming
deliveries, so a receiver only acts on events Sluice actually sent. It needs the
**raw** body: mount it before any JSON body parser.

```ts
import express from 'express';
import { sluiceExpress } from '@sluice/client/middleware';

const app = express();
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use('/webhook', sluiceExpress(process.env.SLUICE_WEBHOOK_SECRET));

app.post('/webhook', (req, res) => {
  // req.sluice: { verified, eventHash, subscriptionId, rawBody }
  res.sendStatus(200);
});
```

| Export | Purpose |
|---|---|
| `sluiceExpress(secret)` | Express middleware, populates `req.sluice`, 401s a bad signature |
| `sluiceFastify(fastify, opts)` | The same guard as a Fastify plugin |
| `verifyHmacSignature(rawBody, signature, secret)` | Standalone check, for any other framework |
| `computeSignature(body, secret)` | Produces the `sha256=<hex>` header value |

With no secret configured the middleware fails **open** and marks the request
`verified: false` rather than rejecting it, so set a secret in production. Wire
format and non-JS receivers are in [docs/HMAC_VERIFY.md](../../docs/HMAC_VERIFY.md).

## License

MIT
