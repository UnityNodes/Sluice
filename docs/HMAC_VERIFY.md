# Verifying `X-Sluice-Signature`

When the matcher runs with `SLUICE_WEBHOOK_SECRET` set, every webhook POST carries

```
X-Sluice-Signature: sha256=<hex>
```

where `<hex>` is `HMAC-SHA256(secret, raw_request_body)`.

To verify safely you need:

1. The **raw** body, do not re-serialize parsed JSON (key order and whitespace change the digest).
2. A constant-time comparison, string `==` leaks timing.

The matcher rotates only at restart; one shared secret per receiver in v0.1. Document this in your runbook and rotate by restarting the matcher with a new `SLUICE_WEBHOOK_SECRET`.

## Reference verifier, Node / Express

`examples/discord-bridge/server.js` and `examples/telegram-bridge/server.js` are full working receivers; the verify routine is the same in both:

```js
const crypto = require('node:crypto');

function verify(rawBody, header, secret) {
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret)
    .update(rawBody)               // Buffer or string, match the bytes the matcher signed
    .digest('hex');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Express, keep the raw body for verification, parse JSON yourself
app.use('/sluice', express.raw({ type: 'application/json', limit: '256kb' }));
app.post('/sluice', (req, res) => {
  if (!verify(req.body, req.header('x-sluice-signature'), process.env.SLUICE_WEBHOOK_SECRET)) {
    return res.status(401).end();
  }
  const body = JSON.parse(req.body.toString('utf8'));
  // … your handler …
  res.status(200).end();
});
```

## Reference verifier, Python / Flask

```python
import hmac, hashlib, os
from flask import Flask, request, abort

app = Flask(__name__)
SECRET = os.environ['SLUICE_WEBHOOK_SECRET'].encode()

@app.post('/sluice')
def sluice():
    sig = request.headers.get('x-sluice-signature', '')
    if not sig.startswith('sha256='):
        abort(401)
    expected = 'sha256=' + hmac.new(SECRET, request.get_data(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, sig):
        abort(401)
    body = request.get_json(force=True)
    # … your handler …
    return ('', 200)
```

## Reference verifier, Go / net/http

```go
package main

import (
    "crypto/hmac"
    "crypto/sha256"
    "encoding/hex"
    "io"
    "net/http"
    "os"
    "strings"
)

var secret = []byte(os.Getenv("SLUICE_WEBHOOK_SECRET"))

func sluiceHandler(w http.ResponseWriter, r *http.Request) {
    sig := r.Header.Get("X-Sluice-Signature")
    if !strings.HasPrefix(sig, "sha256=") {
        http.Error(w, "no signature", http.StatusUnauthorized); return
    }
    body, err := io.ReadAll(r.Body)
    if err != nil { http.Error(w, "read", 500); return }

    mac := hmac.New(sha256.New, secret); mac.Write(body)
    expected := "sha256=" + hex.EncodeToString(mac.Sum(nil))
    if !hmac.Equal([]byte(sig), []byte(expected)) {
        http.Error(w, "bad signature", http.StatusUnauthorized); return
    }
    // … your handler with `body` …
    w.WriteHeader(200)
}

func main() {
    http.HandleFunc("/sluice", sluiceHandler)
    http.ListenAndServe(":8787", nil)
}
```

## Reference verifier, shell / curl test loop

You can sanity-check a known-good payload from the command line without writing any server code:

```bash
# Compute the expected sig for a payload you saved.
SECRET='your-shared-secret'
BODY="$(cat captured-body.json)"
echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -r | awk '{print "sha256=" $1}'

# Round-trip, pipe the matcher's exact bytes back to the demo receiver:
curl -s -X POST http://localhost:8787/sluice \
  -H "content-type: application/json" \
  -H "x-sluice-signature: $(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -r | awk '{print "sha256=" $1}')" \
  --data "$BODY"
```

## Common mistakes

- **Parsing then re-serialising the body before verifying.** The digest is over the raw bytes the matcher signed, JSON parsers re-order keys, normalise whitespace, and break the comparison.
- **Using `==` instead of constant-time compare.** Timing-attackable. Always use `crypto.timingSafeEqual` / `hmac.compare_digest` / `hmac.Equal`.
- **Ignoring the `sha256=` prefix.** It's part of the header value, strip it (or include it in `expected`) before comparing.
- **Mismatched secret encoding.** The matcher uses the secret as raw bytes from the env var. Don't base64-decode it.
