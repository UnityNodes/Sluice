# syntax=docker/dockerfile:1.7

# ─── Build stage 1: casper-client (optional but recommended) ────────────────────
# casper-client is invoked by the matcher to submit `record_delivery` txs (it
# sidesteps a casper-js-sdk@5.0.0-rc6 serialisation bug, see HONEST_LIMITS §9).
# Building it from source on first `docker compose build` takes ~10 minutes.
# Skip this stage with `--build-arg INSTALL_CASPER_CLIENT=false` if you only
# need read-only matcher (WS in, webhook out, no on-chain record).
ARG INSTALL_CASPER_CLIENT=true
FROM rust:1.83-slim-bookworm AS casper-builder
ARG INSTALL_CASPER_CLIENT
WORKDIR /tmp
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential pkg-config libssl-dev ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && if [ "$INSTALL_CASPER_CLIENT" = "true" ]; then \
      cargo install casper-client@5.0.1 --locked --root /out ; \
    else \
      mkdir -p /out/bin && printf '#!/bin/sh\necho "casper-client not bundled, record_delivery disabled" >&2; exit 127\n' > /out/bin/casper-client && chmod +x /out/bin/casper-client ; \
    fi

# ─── Build stage 2: TypeScript compile ─────────────────────────────────────────
# Build context is the repo root (see docker-compose.yml), so paths are
# prefixed with matcher/ here.
FROM node:20-bookworm-slim AS node-builder
WORKDIR /src
COPY matcher/package.json matcher/package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY matcher/tsconfig.json ./
COPY matcher/src/ ./src/
RUN npx tsc -p .

# ─── Runtime ───────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim
LABEL org.opencontainers.image.title="sluice-matcher"
LABEL org.opencontainers.image.source="https://github.com/UnityNodes/Sluice"
LABEL org.opencontainers.image.licenses="MIT"
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl tini \
 && rm -rf /var/lib/apt/lists/*
COPY --from=casper-builder /out/bin/casper-client /usr/local/bin/casper-client
WORKDIR /app
COPY matcher/package.json matcher/package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=node-builder /src/dist ./dist
COPY scripts/record-delivery.sh /app/scripts/record-delivery.sh
RUN chmod +x /app/scripts/record-delivery.sh || true
ENV NODE_ENV=production \
    CASPER_CLIENT_BIN=/usr/local/bin/casper-client \
    SLUICE_NODE_RPC_URL=https://node.testnet.casper.network/rpc \
    SLUICE_CHAIN_NAME=casper-test \
    SLUICE_API_PORT=7799 \
    SLUICE_SNAPSHOT_PATH=/var/snapshot/snapshot.json
EXPOSE 7799
VOLUME ["/keys", "/var/snapshot"]
HEALTHCHECK --interval=30s --timeout=5s CMD curl -fsS -X POST -H 'content-type: application/json' http://127.0.0.1:7799/health -d '{}' || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
