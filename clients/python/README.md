# sluice-client (Python)

Minimal Python client for the [Sluice](https://sluice.unitynodes.com) matcher API, on-chain event subscriptions for Casper.

```bash
pip install sluice-client
# optional, only if you need the live WebSocket stream:
pip install 'sluice-client[stream]'
```

Mirrors the [`@sluice/client`](../typescript) TypeScript surface so the mental model is portable across languages.

## Five-minute tour

```python
from sluice_client import SluiceClient

sluice = SluiceClient()                       # https://sluice.unitynodes.com/api

# 1. inspect subs
subs = sluice.subs.list()
print(f"{len(subs)} subs, {sum(1 for s in subs if s['active'])} active")

# 2. dry-run a predicate before paying CSPR
probe = sluice.predicate.validate({"and": [
    {"field": "amount", "op": "gte", "value": "100000000000000"}
]})
print(f"would match {probe['matches']}/{probe['total_scanned']}  (~{probe['estimated_per_day']}/day)")

# 3. why didn't this match?, per-condition trace
why = sluice.predicate.explain(predicate, event)
for step in why["trace"]:
    print("✓" if step["pass"] else "✗", step["reason"])

# 4. fire synthetic webhooks at your receiver, no CSPR spent
sluice.sandbox.dispatch("https://my.app/webhook", count=5)

# 5. live stream of every delivery the matcher fans out  (requires `pip install websockets`)
for env in sluice.stream.subscribe(sub_id=42):
    print(env["type"], env["data"])
```

## Receiver-side HMAC verify

```python
from sluice_client import verify_hmac_signature

if not verify_hmac_signature(raw_body, request.headers["X-Sluice-Signature"], SECRET):
    return Response(status=401)
```

Works in FastAPI / Flask / Django, wherever you have access to the raw bytes (FastAPI: `raw = await request.body()`; Flask: `request.get_data(cache=True, as_text=False)`).

## Self-host

```python
sluice = SluiceClient(base_url="http://localhost:8080/api")
```

## Reference

| Namespace            | Method                                         |
|----------------------|------------------------------------------------|
| `sluice`             | `health()`, `snapshot()`, `metrics_text()`, `badge_url(metric)`, `openapi_url()` |
| `sluice.subs`        | `list()`, `get(id)`, `replay_last(id, n=10)`, `ics(id)`, `og(id)` |
| `sluice.predicate`   | `validate(predicate)`, `explain(predicate, event)` |
| `sluice.sandbox`     | `dispatch(webhook, predicate=None, count=3)`    |
| `sluice.chain`       | `head()`                                       |
| `sluice.stream`      | `subscribe(sub_id=None)`, yields envelope dicts |
| `sluice.tx`          | `test_webhook(sub_id)`, `replay(event_hash)`    |

Errors raise `SluiceApiError` with `.status` and `.body` attributes.

## License

MIT
