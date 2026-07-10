# Security policy

## Supported versions

Sluice is a prototype running on Casper **testnet**. Only the `main` branch is
supported. Do not use it to custody value on mainnet.

| Version | Supported |
|---|---|
| `main` | Yes |
| Older tags | No |

## Reporting a vulnerability

**Do not open a public issue for security reports.**

Use GitHub's private vulnerability reporting:

1. Go to <https://github.com/UnityNodes/Sluice/security/advisories/new>
2. Describe the issue, the impact, and how to reproduce it.
3. Include the commit hash you tested against.

We aim to acknowledge a report within 72 hours and to ship a fix or a
mitigation plan within 14 days. We will credit you in the advisory unless you
ask us not to.

## Scope

In scope:

- The matcher service (`matcher/`), including the predicate engine, the webhook
  dispatcher, and the HTTP API.
- The hosted MCP server (`mcp/`).
- The `SubscriptionRegistry` contract (`contract/`).
- The example agents (`examples/`).

Out of scope:

- Findings that require a compromised operator machine or a leaked private key.
- Denial of service against the public testnet demo instance.
- Vulnerabilities in Casper node software, CSPR.cloud, or the x402 facilitator.
  Report those to their maintainers.

## Known limits of the prototype

The honest limits of this build are documented in
[`docs/HONEST_LIMITS.md`](docs/HONEST_LIMITS.md). Behaviour listed there is
known and intentional, not a vulnerability.

## Hardening already in place

- Webhook URLs are validated against SSRF (private and link-local ranges are
  rejected, and the resolved IP is pinned for the request).
- Webhook bodies are HMAC-signed, and deliveries carry an idempotency key.
- Predicate regexes are length-capped and screened for catastrophic
  backtracking.
- The HTTP API rate-limits writes per client IP.
- Dependencies are monitored by Dependabot, and every push runs CodeQL and
  `npm audit --audit-level=high`.
