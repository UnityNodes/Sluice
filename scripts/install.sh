#!/usr/bin/env bash
# scripts/install.sh, one-shot provisioner for a fresh Ubuntu 22.04 / 24.04 VPS.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/UnityNodes/Sluice/main/scripts/install.sh | sudo bash
#   # then:  sudo SLUICE_DOMAIN=sluice.mydomain.com SLUICE_CSPR_CLOUD_TOKEN=… sluice-bootstrap
#
# Or run locally after cloning:
#   sudo SLUICE_DOMAIN=sluice.local SLUICE_CSPR_CLOUD_TOKEN=… ./scripts/install.sh
#
# What this does:
#   1. apt-installs build deps + Node 20 + Caddy
#   2. installs Rust toolchain + casper-client (~10 min on first run)
#   3. clones Sluice into /opt/sluice (or uses the current checkout when run from it)
#   4. generates a matcher keypair if one is not already present
#   5. drops a systemd unit (sluice-matcher.service) + reverse-proxy Caddyfile
#   6. opens :80 and :443 in ufw if ufw is active
#
# Re-runnable: every step is idempotent.

set -euo pipefail
[[ "$EUID" -ne 0 ]] && { echo "run as root (sudo)."; exit 1; }

SLUICE_DIR="${SLUICE_DIR:-/opt/sluice}"
SLUICE_USER="${SLUICE_USER:-sluice}"
SLUICE_DOMAIN="${SLUICE_DOMAIN:-localhost}"
SLUICE_CONTRACT_HASH="${SLUICE_CONTRACT_HASH:-f3710eaf12c30346eb1c642da832bc1af8ff900254c46bcc49a1efca81d8b971}"
SLUICE_CSPR_CLOUD_TOKEN="${SLUICE_CSPR_CLOUD_TOKEN:-}"
SLUICE_GIT_URL="${SLUICE_GIT_URL:-https://github.com/UnityNodes/Sluice.git}"
SLUICE_GIT_REF="${SLUICE_GIT_REF:-main}"

step()  { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
warn()  { printf '\033[33m⚠ %s\033[0m\n' "$*"; }
ok()    { printf '\033[32m✓ %s\033[0m\n' "$*"; }

[[ -z "$SLUICE_CSPR_CLOUD_TOKEN" ]] && warn "SLUICE_CSPR_CLOUD_TOKEN is empty, the matcher will run but WebSocket streams need this set in /etc/sluice/env once it is provisioned. Get one free at https://cspr.cloud."

step "1/6  apt deps + Node 20 + Caddy"
DEBIAN_FRONTEND=noninteractive apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates gnupg lsb-release pkg-config build-essential libssl-dev git ufw
if ! command -v node >/dev/null || ! node -v | grep -q "^v20"; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs
fi
if ! command -v caddy >/dev/null; then
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-archive-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/caddy-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" \
    > /etc/apt/sources.list.d/caddy-stable.list
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq caddy
fi
ok "node $(node -v)   caddy $(caddy version | head -1)"

step "2/6  user + dir"
id "$SLUICE_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$SLUICE_USER"
mkdir -p "$SLUICE_DIR" "/etc/sluice" "/var/lib/sluice/snapshot" "/var/www/sluice/api"
chown -R "$SLUICE_USER":"$SLUICE_USER" "$SLUICE_DIR" "/var/lib/sluice"
ok "service user '$SLUICE_USER'  dir $SLUICE_DIR"

step "3/6  rust toolchain + casper-client (~10 min first time)"
if ! sudo -u "$SLUICE_USER" bash -c 'command -v cargo' >/dev/null 2>&1; then
  sudo -u "$SLUICE_USER" bash -c 'curl -fsSL --proto =https --tlsv1.2 https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal'
fi
sudo -u "$SLUICE_USER" bash -c 'source ~/.cargo/env && cargo install --locked --quiet casper-client@5.0.1 || true'
CASPER_CLIENT_BIN="$(sudo -u "$SLUICE_USER" bash -c 'echo $HOME')/.cargo/bin/casper-client"
ok "casper-client at $CASPER_CLIENT_BIN"

step "4/6  clone + build matcher"
if [[ -d "$SLUICE_DIR/.git" ]]; then
  sudo -u "$SLUICE_USER" git -C "$SLUICE_DIR" fetch --quiet origin
  sudo -u "$SLUICE_USER" git -C "$SLUICE_DIR" checkout --quiet "$SLUICE_GIT_REF"
  sudo -u "$SLUICE_USER" git -C "$SLUICE_DIR" pull --quiet --ff-only
else
  sudo -u "$SLUICE_USER" git clone --quiet --branch "$SLUICE_GIT_REF" "$SLUICE_GIT_URL" "$SLUICE_DIR"
fi
sudo -u "$SLUICE_USER" bash -c "cd '$SLUICE_DIR/matcher' && npm install --silent && npm run build --silent"
ok "matcher built"

step "5/6  matcher keypair, env, systemd, Caddy"
KEY_DIR="$SLUICE_DIR/keys/matcher"
mkdir -p "$KEY_DIR"
if [[ ! -f "$KEY_DIR/secret_key.pem" ]]; then
  sudo -u "$SLUICE_USER" "$CASPER_CLIENT_BIN" keygen "$KEY_DIR" >/dev/null
  ok "generated matcher keypair (FAUCET this: $(cat $KEY_DIR/public_key_hex))"
else
  ok "matcher keypair already present"
fi

cat >/etc/sluice/env <<EOF
SLUICE_CONTRACT_HASH=$SLUICE_CONTRACT_HASH
SLUICE_CSPR_CLOUD_TOKEN=$SLUICE_CSPR_CLOUD_TOKEN
SLUICE_STREAMING_WS_URL=wss://streaming.testnet.cspr.cloud/transfers
SLUICE_NODE_RPC_URL=https://node.testnet.casper.network/rpc
SLUICE_CHAIN_NAME=casper-test
SLUICE_MATCHER_KEY_PATH=$KEY_DIR/secret_key.pem
SLUICE_SNAPSHOT_PATH=/var/www/sluice/api/snapshot.json
SLUICE_API_PORT=7799
SLUICE_POLL_SUBS_MS=30000
CASPER_CLIENT_BIN=$CASPER_CLIENT_BIN
EOF
chmod 0640 /etc/sluice/env

cat >/etc/systemd/system/sluice-matcher.service <<EOF
[Unit]
Description=Sluice matcher, Casper event subscription dispatcher
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SLUICE_USER
Group=$SLUICE_USER
WorkingDirectory=$SLUICE_DIR/matcher
EnvironmentFile=/etc/sluice/env
ExecStart=/usr/bin/node $SLUICE_DIR/matcher/dist/index.js
Restart=on-failure
RestartSec=4

# tighten privileges
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/www/sluice/api /var/lib/sluice
PrivateTmp=true
StandardOutput=append:/var/log/sluice/matcher.log
StandardError=append:/var/log/sluice/matcher.log

[Install]
WantedBy=multi-user.target
EOF
install -d -o "$SLUICE_USER" -g "$SLUICE_USER" /var/log/sluice

cat >/etc/caddy/Caddyfile <<EOF
$SLUICE_DOMAIN {
  encode gzip zstd

  @snapshot path /api/snapshot.json /api/badge.svg
  handle @snapshot {
    header Cache-Control "no-store"
    root * /var/www/sluice
    file_server
  }

  handle_path /api/tx/*        { rewrite * /tx{uri};         reverse_proxy 127.0.0.1:7799 }
  handle_path /api/hooks/*     { rewrite * /hooks{uri};      reverse_proxy 127.0.0.1:7799 }
  handle_path /api/predicate/* { rewrite * /predicate{uri};  reverse_proxy 127.0.0.1:7799 }
  handle_path /api/sub/*       { rewrite * /sub{uri};        reverse_proxy 127.0.0.1:7799 }
  handle_path /api/health      { rewrite * /health;          reverse_proxy 127.0.0.1:7799 }
  handle_path /api/metrics     { rewrite * /metrics;         reverse_proxy 127.0.0.1:7799 }
  handle_path /og/*            { rewrite * /og{uri};         reverse_proxy 127.0.0.1:7799 }
  handle_path /api/chain/*     { rewrite * /chain{uri};      reverse_proxy 127.0.0.1:7799 }
  handle_path /api/stream      { rewrite * /stream;          reverse_proxy 127.0.0.1:7799 }
  handle_path /api/badges/*    { rewrite * /badges{uri};     reverse_proxy 127.0.0.1:7799 }
  handle_path /embed/*         { rewrite * /embed{uri};      reverse_proxy 127.0.0.1:7799 }
  handle_path /api/openapi.yaml{ rewrite * /openapi.yaml;    reverse_proxy 127.0.0.1:7799 }
  handle_path /api/sandbox/*   { rewrite * /sandbox{uri};    reverse_proxy 127.0.0.1:7799 }

  handle /h/* {
    root * $SLUICE_DIR/web
    try_files {path} /h/index.html
    file_server
  }

  handle {
    root * $SLUICE_DIR/web
    try_files {path} {path}/index.html
    file_server
  }
}
EOF
systemctl daemon-reload
systemctl enable --now sluice-matcher.service
systemctl reload caddy 2>/dev/null || systemctl restart caddy
ok "matcher running, caddy reloaded"

step "6/6  firewall (ufw, skipped if inactive)"
if ufw status | grep -q 'Status: active'; then
  ufw allow 80/tcp  || true
  ufw allow 443/tcp || true
  ok "ufw allows 80/443"
else
  warn "ufw is inactive, not modifying firewall rules"
fi

cat <<EOF

╭───────────────────────────────────────────────────────────────────────╮
│  Sluice is up.                                                        │
│                                                                       │
│  Domain:        $SLUICE_DOMAIN
│  Matcher unit:  systemctl status sluice-matcher.service
│  Logs:          journalctl -u sluice-matcher -f  (and /var/log/sluice/matcher.log)
│  Snapshot:      curl https://$SLUICE_DOMAIN/api/snapshot.json
│  Health:        curl -X POST https://$SLUICE_DOMAIN/api/health -d '{}'
│  Edit secrets:  /etc/sluice/env  (then  systemctl restart sluice-matcher)
│                                                                       │
│  Fund the matcher key (testnet faucet), pubkey:                      │
│    $(cat "$KEY_DIR/public_key_hex" 2>/dev/null || echo '???')
│                                                                       │
╰───────────────────────────────────────────────────────────────────────╯
EOF
