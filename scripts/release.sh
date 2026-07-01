#!/usr/bin/env bash
# Stage release artifacts and (optionally) cut a GitHub release.
#
# Usage:
#   scripts/release.sh                       # build everything + dry-run
#   scripts/release.sh --publish v0.1.0      # actually create the tag + GitHub release
#
# Never publishes anything unless --publish is passed explicitly.
set -euo pipefail
cd "$(dirname "$0")/.."

TAG=""
PUBLISH=false

while [ $# -gt 0 ]; do
  case "$1" in
    --publish) PUBLISH=true; TAG="${2:?--publish needs a tag like v0.1.0}"; shift 2 ;;
    --tag)     TAG="${2:?--tag needs a value}"; shift 2 ;;
    *) echo "unknown arg: $1"; exit 1 ;;
  esac
done

OUT="release-artifacts"
rm -rf "$OUT"
mkdir -p "$OUT"

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

step "1/4 build matcher"
(cd matcher && npm install --silent && npm run build && npm test --silent)
cp matcher/dist/cli.js "$OUT/sluice-cli.js"

step "2/4 build + pack TypeScript client"
(cd clients/typescript && npm install --silent && npm pack --silent)
mv clients/typescript/*.tgz "$OUT/"

step "3/4 build + pack Python client"
(cd clients/python && rm -rf dist build *.egg-info && python3 -m build --sdist --wheel)
cp clients/python/dist/*.whl clients/python/dist/*.tar.gz "$OUT/"

step "4/4 build + pack MCP server"
(cd mcp && npm install --silent && npm run build && npm pack --silent)
mv mcp/*.tgz "$OUT/"

step "→ artifact list"
ls -lah "$OUT/"

if [ "$PUBLISH" = "false" ]; then
  echo
  echo "Dry-run complete. Inspect ./$OUT then publish with:"
  echo "  scripts/release.sh --publish v0.1.0"
  exit 0
fi

step "→ git tag ${TAG}"
if git rev-parse "${TAG}" >/dev/null 2>&1; then
  echo "tag ${TAG} already exists locally; reusing it"
else
  git tag -a "${TAG}" -m "Sluice ${TAG}"
fi
git push origin "${TAG}"

step "→ gh release create ${TAG}"
gh release create "${TAG}" \
  --title "Sluice ${TAG}" \
  --notes-file CHANGELOG.md \
  "$OUT"/*

echo
echo "Done. https://github.com/UnityNodes/Sluice/releases/tag/${TAG}"
