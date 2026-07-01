"""sluice-client, minimal Python client for the Sluice matcher API.

Mirrors the surface of ``@sluice/client`` (the TypeScript package) so the same
mental model works in both languages. Standard-library only for HTTP; the
WebSocket stream method requires the optional ``websockets`` package.

Quick start::

    from sluice_client import SluiceClient

    sluice = SluiceClient()                           # https://sluice.unitynodes.com/api
    print(sluice.health())
    print(sluice.snapshot()["subscriptions"])

    r = sluice.predicate.validate({"and": [
        {"field": "amount", "op": "gte", "value": "5000000000000"}
    ]})
    print(f"would match {r['matches']}/{r['total_scanned']}  ~{r['estimated_per_day']}/day")

    sluice.sandbox.dispatch("https://my.app/hook", count=3)

    for env in sluice.stream.subscribe(sub_id=42):    # requires `pip install websockets`
        print(env["type"], env["data"])

Receiver-side HMAC verification helper::

    from sluice_client import verify_hmac_signature
    if not verify_hmac_signature(raw_body, request.headers["X-Sluice-Signature"], SECRET):
        return 401
"""

from __future__ import annotations

import hashlib
import hmac
import json
import urllib.error
import urllib.request
from typing import Any, Iterator, Optional

__version__ = "0.1.0"
__all__ = [
    "SluiceClient",
    "SluiceApiError",
    "verify_hmac_signature",
    "compute_signature",
]

DEFAULT_BASE_URL = "https://sluice.unitynodes.com/api"


class SluiceApiError(Exception):
    """HTTP error from the matcher API. ``status`` is the response code."""

    def __init__(self, status: int, message: str, body: Any = None):
        super().__init__(message)
        self.status = status
        self.body = body


# ─────────────────────── HMAC helpers ───────────────────────


def compute_signature(body, secret: str) -> str:
    """Return ``sha256=<hex>``, the format the Sluice matcher writes into
    ``X-Sluice-Signature`` on every webhook POST."""
    if isinstance(body, str):
        body = body.encode("utf-8")
    digest = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return f"sha256={digest}"


def verify_hmac_signature(body, signature: Optional[str], secret: str) -> bool:
    """Constant-time compare a ``sha256=<hex>`` signature against the body."""
    if not signature:
        return False
    expected = compute_signature(body, secret)
    return hmac.compare_digest(expected, signature)


# ─────────────────────── HTTP plumbing ───────────────────────


def _do_request(url: str, method: str = "GET", body: Any = None, timeout: float = 15.0) -> Any:
    data: Optional[bytes] = None
    # Cloudflare blocks the default "Python-urllib/x.y" UA on the Sluice host.
    # Use a stable identifier the matcher (and any front WAF) will accept.
    headers = {
        "accept": "application/json",
        "user-agent": f"sluice-client-python/{__version__}",
    }
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["content-type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            text = raw.decode("utf-8", errors="replace")
            try:
                return json.loads(text)
            except json.JSONDecodeError:
                return text
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        body_parsed: Any = raw
        try:
            body_parsed = json.loads(raw)
        except json.JSONDecodeError:
            pass
        raise SluiceApiError(e.code, f"{method} {url} -> {e.code}", body_parsed) from None


# ─────────────────────── namespaces ───────────────────────


class _Subs:
    def __init__(self, client: "SluiceClient"):
        self._c = client

    def list(self):
        return self._c.snapshot()["subscriptions"]

    def get(self, sub_id: int):
        for s in self.list():
            if s["id"] == sub_id:
                return s
        return None

    def replay_last(self, sub_id: int, n: int = 10):
        return self._c._post(f"/sub/{sub_id}/replay-last", {"n": n})

    def ics(self, sub_id: int) -> str:
        return f"{self._c.base_url}/sub/{sub_id}.ics"

    def og(self, sub_id: int) -> str:
        # /api -> root -> /og/sub/N
        root = self._c.base_url[:-4] if self._c.base_url.endswith("/api") else self._c.base_url
        return f"{root}/og/sub/{sub_id}"


class _Predicate:
    def __init__(self, client: "SluiceClient"):
        self._c = client

    def validate(self, predicate):
        return self._c._post("/predicate/validate", {"predicate": predicate})

    def explain(self, predicate, event):
        return self._c._post("/predicate/explain", {"predicate": predicate, "event": event})


class _Sandbox:
    def __init__(self, client: "SluiceClient"):
        self._c = client

    def dispatch(self, webhook: str, predicate=None, count: int = 3):
        return self._c._post("/sandbox/dispatch", {"webhook": webhook, "predicate": predicate, "count": count})


class _Chain:
    def __init__(self, client: "SluiceClient"):
        self._c = client

    def head(self):
        return self._c._get("/chain/head")


class _Tx:
    def __init__(self, client: "SluiceClient"):
        self._c = client

    def test_webhook(self, subscription_id: int):
        return self._c._post("/tx/test-webhook", {"subscription_id": subscription_id})

    def replay(self, event_hash: str):
        return self._c._post("/tx/replay", {"event_hash": event_hash})


class _Stream:
    def __init__(self, client: "SluiceClient"):
        self._c = client

    def subscribe(self, sub_id: Optional[int] = None) -> Iterator[dict]:
        """Yield envelope dicts from the live stream. Requires ``pip install websockets``."""
        try:
            from websockets.sync.client import connect  # type: ignore
        except ImportError as e:
            raise RuntimeError(
                "the live stream requires the 'websockets' package, run `pip install websockets`"
            ) from e
        url = self._c.base_url.replace("http", "ws", 1) + "/stream"
        if sub_id is not None:
            url += f"?sub={sub_id}"
        with connect(url) as ws:
            for raw in ws:
                try:
                    yield json.loads(raw)
                except json.JSONDecodeError:
                    continue


# ─────────────────────── client ───────────────────────


class SluiceClient:
    """Typed wrapper for the Sluice matcher API."""

    def __init__(self, base_url: str = DEFAULT_BASE_URL, *, timeout_s: float = 15.0):
        self.base_url = base_url.rstrip("/")
        self.timeout_s = timeout_s
        self.subs = _Subs(self)
        self.predicate = _Predicate(self)
        self.sandbox = _Sandbox(self)
        self.chain = _Chain(self)
        self.tx = _Tx(self)
        self.stream = _Stream(self)

    def health(self):
        return self._post("/health", {})

    def snapshot(self):
        return self._get("/snapshot.json")

    def metrics_text(self) -> str:
        req = urllib.request.Request(
            f"{self.base_url}/metrics",
            headers={"user-agent": f"sluice-client-python/{__version__}"},
        )
        with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:
            return resp.read().decode("utf-8")

    def badge_url(self, metric: str) -> str:
        return f"{self.base_url}/badges/{metric}.svg"

    def openapi_url(self) -> str:
        return f"{self.base_url}/openapi.yaml"

    def _get(self, path: str):
        return _do_request(self.base_url + path, "GET", timeout=self.timeout_s)

    def _post(self, path: str, body):
        return _do_request(self.base_url + path, "POST", body, timeout=self.timeout_s)
