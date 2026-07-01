# Sluice hosted MCP, Streamable HTTP transport.
#
# This image runs `sluice-mcp-http` (NOT the stdio server). It serves the
# read-only surface, recent_deliveries, sluice_sandbox_dispatch, and every
# resource + prompt, so MCP clients can connect by URL with no install:
#
#   claude mcp add sluice https://<your-host>/mcp
#
# The stdio server still ships via npm for users who need subscribe / cancel
# (those tools require a Casper signing key on the same machine).

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --include=dev --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist

ENV PORT=7800
EXPOSE 7800
HEALTHCHECK --interval=30s --timeout=4s --retries=3 \
  CMD wget -qO- http://127.0.0.1:7800/healthz || exit 1
CMD ["node", "dist/server-http.js"]
