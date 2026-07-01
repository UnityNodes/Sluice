#!/usr/bin/env bash
# Syncs /root/Sluice/web → /var/www/sluice and reloads Caddy.
# Use after changing the landing or app HTML.
#
#   sudo scripts/deploy-web.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO_DIR/web"
DST="/var/www/sluice"

if [ ! -d "$SRC" ]; then
  echo "missing $SRC, run from a checkout of UnityNodes/Sluice" >&2
  exit 1
fi

sudo mkdir -p "$DST"
# `--delete` would wipe /var/www/sluice/api which the matcher writes to at runtime;
# excluding it keeps the snapshot intact across deploys.
sudo rsync -a --delete --exclude='api/' "$SRC/" "$DST/"
# Static files owned by caddy; api/ stays claude:caddy 775 (matcher writes there).
sudo find "$DST" -path "$DST/api" -prune -o -exec chown caddy:caddy {} +

sudo systemctl reload caddy
echo "deployed $(date -u +%FT%TZ), https://sluice.unitynodes.com"
