# sluice → GitHub Actions

Trigger a GitHub Actions workflow on every Sluice match. Two pieces:

1. **`.github/workflows/sluice-watch.yml`**, drops into your repo, listens for `repository_dispatch` of type `sluice-match`.
2. **`dispatcher.js`**, tiny Express server that receives Sluice's webhook, verifies HMAC, and forwards the payload as a `repository_dispatch` via the GitHub REST API.

## Use case

> When CSPR drops into our treasury, run CI to refresh the public balance widget.

You can also kick off a deploy, post a status, run a test suite, anything Actions can do.

## Setup

In your repo:

```bash
cp examples/github-action/.github/workflows/sluice-watch.yml .github/workflows/
git add .github/workflows/sluice-watch.yml && git commit -m "watch Sluice matches"
```

Run the bridge somewhere reachable:

```bash
cd examples/github-action && npm install

export GITHUB_TOKEN=ghp_…             # PAT with `repo` scope
export GITHUB_REPO=owner/repo
export SLUICE_WEBHOOK_SECRET=<shared with sluice matcher>
node dispatcher.js
```

Then in Sluice:

```bash
sluice subscribe \
  --predicate ../treasury-inbox.json \
  --webhook https://your-bridge.example/sluice \
  --amount 10
```

Every matched event becomes a workflow run. The full Casper event JSON shows up under `github.event.client_payload`.
