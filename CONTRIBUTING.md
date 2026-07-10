# Contributing to Sluice

Thanks for taking the time. Sluice is a push-based on-chain event service for
Casper. This document explains how to get it running, what we expect from a
change, and how to get it merged.

## Getting set up

You need Node 20 and, if you touch the contract, the Rust toolchain pinned in
[`contract/rust-toolchain`](contract/rust-toolchain).

```bash
git clone https://github.com/UnityNodes/Sluice.git
cd Sluice

cd matcher && npm ci && cd ..
cd mcp && npm ci && cd ..
```

Copy `.env.sample` to `.env` and fill in your own CSPR.cloud token. Never commit
`.env` or anything under `keys/`.

## Running the checks

Everything CI runs, you can run locally. Do this before you open a pull request.

```bash
cd matcher
npm run lint     # tsc --noEmit
npm test         # jest, 74 tests
npm run build

cd ../mcp
npm run build

cd ../contract
cargo check
cargo test       # 6 tests
```

## What we look for in a change

- **Tests.** A bug fix comes with a test that fails before it and passes after.
  A new predicate operator comes with cases in `matcher/test/`.
- **No dead code.** If you remove the last caller, remove the function.
- **No hardcoded values as a fix.** If a number comes out wrong, find out why.
  Pinning the output to a constant hides the bug and breaks something later.
- **Small commits.** One logical change each, in the form
  `type(scope): description`, where type is one of `feat`, `fix`, `docs`,
  `refactor`, `chore`, `test`.

## Opening a pull request

1. Branch off `main`.
2. Make the change, keep CI green.
3. Fill in the pull request template. Say what you changed and how you tested it.
4. A maintainer reviews it. Expect questions about edge cases in the predicate
   engine and about anything that touches webhook delivery or the escrow.

## Reporting a bug

Open an issue with the bug report template. Include the subscription predicate,
the event you expected to match, and what actually happened. If it involves a
live delivery, the `x-sluice-idempotency-key` header from the webhook request
helps us find it.

Security issues do not go in the public tracker. See
[`SECURITY.md`](SECURITY.md).

## Code of conduct

Participating in this project means agreeing to the
[Code of Conduct](CODE_OF_CONDUCT.md).

## License

Contributions are licensed under the MIT License, the same as the project. See
[`LICENSE`](LICENSE).
