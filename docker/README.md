# Self-host with Docker

One command brings up the matcher, Caddy reverse-proxy, and the optional demo webhook receiver:

```bash
git clone https://github.com/UnityNodes/Sluice && cd Sluice
cp .env.sample .env                               # paste your CSPR.cloud token + key path
docker compose up --build                          # ~ 10 min first build (cargo install casper-client)
# (optional) include the demo webhook receiver on :8787:
docker compose --profile with-demo-webhook up --build
```

Open http://localhost:8080, landing + `/app` + `/feed` + `/h/` all served from the local stack.

## What's in the box

| Service       | Image / build                | Port    | Notes                                                                            |
|---------------|------------------------------|---------|----------------------------------------------------------------------------------|
| `matcher`     | `matcher/Dockerfile`         | `7799`  | TypeScript matcher + bundled `casper-client` for `record_delivery` submissions.  |
| `caddy`       | `caddy:2-alpine`             | `8080`  | Serves `/web` + reverse-proxies `/api/tx/*` and `/api/hooks/*` to the matcher.   |
| `demo-webhook`| `node:20-alpine` + Express   | `8787`  | Optional. HMAC-verifying receiver, a minimal logging receiver (`docker/demo-webhook/`), not the Discord bridge.      |

## Volumes

- `./keys` → `/keys` (read-only). The matcher reads `/keys/matcher/secret_key.pem`.
- `snapshot` (named volume) shared between `matcher` (write) and `caddy` (read). The matcher writes `snapshot.json` and `badge.svg` here; Caddy serves them under `/api/snapshot.json` + `/api/badge.svg`.

## Env vars

Most defaults point to the public testnet contract. Override in `.env` (or shell):

| Variable                  | Default                                                                 | What it does                                                       |
|---------------------------|-------------------------------------------------------------------------|--------------------------------------------------------------------|
| `SLUICE_CONTRACT_HASH`    | `f3710eaf…b971` (live testnet)                                          | Package hash to watch.                                             |
| `SLUICE_CSPR_CLOUD_TOKEN` | **required**                                                            | CSPR.cloud streaming bearer.                                       |
| `SLUICE_STREAMING_WS_URL` | `wss://streaming.testnet.cspr.cloud/transfers`                          | WS endpoint for transfers.                                         |
| `SLUICE_NODE_RPC_URL`     | `https://node.testnet.casper.network/rpc`                               | JSON-RPC endpoint (no auth) for `casper-client send-transaction`.  |
| `SLUICE_CHAIN_NAME`       | `casper-test`                                                           | Chain id.                                                          |
| `SLUICE_WEBHOOK_SECRET`   | *(unset)*                                                                | When set, matcher signs webhooks with `X-Sluice-Signature`.        |
| `SLUICE_HTTP_PORT`        | `8080`                                                                  | Host port Caddy binds to.                                          |

## Skip the casper-client build

`record_delivery` is the only place the matcher shells out to `casper-client`. If you only want a read-only matcher (WS in, webhook out, no on-chain receipt), skip the 10-minute Rust build:

```bash
docker compose build --build-arg INSTALL_CASPER_CLIENT=false matcher
docker compose up
```

The image still runs; the matcher catches events and POSTs webhooks; `record_delivery` calls exit 127 and the failure is logged but doesn't crash the loop.

## Reset / rebuild

```bash
docker compose down -v                     # also wipes the snapshot volume
docker compose build --no-cache matcher    # force a fresh casper-client build
```
