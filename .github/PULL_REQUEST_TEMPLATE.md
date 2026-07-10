## What this changes

<!-- One or two sentences. What behaviour is different after this merges? -->

## Why

<!-- The problem it solves. Link the issue if there is one. -->

Closes #

## How it was tested

<!-- Commands you ran, and what you saw. Not "it should work". -->

- [ ] `cd matcher && npm run lint && npm test && npm run build`
- [ ] `cd mcp && npm run build`
- [ ] `cd contract && cargo check && cargo test` (only if the contract changed)
- [ ] Exercised the change against testnet, or explained why that is not possible

## Checklist

- [ ] Tests cover the change. A fix has a test that failed before it.
- [ ] No hardcoded value stands in for a real fix.
- [ ] No dead code left behind.
- [ ] Docs updated if behaviour or setup changed.
- [ ] No secrets, keys, or `.env` contents in the diff.
