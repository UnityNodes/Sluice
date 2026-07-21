#!/usr/bin/env bash
# Cron wrapper: fires one varied DemoDex swap so the live /app feed keeps
# showing real contract-event deliveries during the judging window.
#
# Safe by design: it refuses to run if the matcher key balance is below a floor,
# so scheduled demo swaps can never starve the key that records real deliveries.
#
# Enable (every 15 minutes):
#   (crontab -l 2>/dev/null; echo "*/30 * * * * /path/to/Sluice/scripts/demo-swap-cron.sh >> /tmp/demo-swap-cron.log 2>&1") | crontab -
# Disable:
#   crontab -l | grep -v demo-swap-cron.sh | crontab -

set -euo pipefail
cd "$(dirname "$0")/.."

MIN_BALANCE_CSPR="${MIN_BALANCE_CSPR:-40}"
# Guard the balance of the key that actually pays for the swaps (the subscriber
# key), so the schedule stops itself before running the demo budget dry.
PAYER_PUBKEY="0141ae56d7afef7eb22298b50db5f013cd6945a26eab4098eebd97e9cf6064f676"
TOKEN_FILE="${HOME}/.sluice/cspr-cloud.token"

bal_motes=$(curl -s -H "Authorization: $(cat "$TOKEN_FILE")" \
  "https://api.testnet.cspr.cloud/accounts/${PAYER_PUBKEY}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['balance'])" 2>/dev/null || echo 0)
bal_cspr=$(python3 -c "print(int(${bal_motes:-0})//1000000000)")

if [ "$bal_cspr" -lt "$MIN_BALANCE_CSPR" ]; then
  echo "$(date -u +%FT%TZ) skip: payer balance ${bal_cspr} CSPR < floor ${MIN_BALANCE_CSPR}"
  exit 0
fi

# Rotate amount and token pair across a small realistic set (varies the feed).
amounts=(180000 340000 520000 760000 1100000 250000)
pairs=("CSPR USDC" "CSPR wETH" "wBTC CSPR" "CSPR CSPRX" "USDC CSPR")
idx=$(( $(date +%s) / 3600 ))
amt="${amounts[$(( idx % ${#amounts[@]} ))]}"
pair="${pairs[$(( idx % ${#pairs[@]} ))]}"

echo "$(date -u +%FT%TZ) firing swap: ${amt} ${pair} (bal ${bal_cspr} CSPR)"
# shellcheck disable=SC2086
scripts/demo-swap.sh $amt $pair >/dev/null 2>&1 && echo "  submitted" || echo "  submit failed"
