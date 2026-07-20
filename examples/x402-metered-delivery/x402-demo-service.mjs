// Self-contained x402 demo service for the Sluice site: it hosts the x402-gated
// delivery endpoint AND a POST /pay that fires one real payment (server-side
// paying agent) against the live hosted Casper facilitator, returning the
// on-chain settlement tx. Powers the "Fire a live x402 payment" button so a
// judge can trigger a real on-chain micropayment from the browser.
import cors from "cors";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactCasperScheme as ServerScheme } from "@make-software/casper-x402/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { x402Client, x402HTTPClient, wrapFetchWithPayment } from "@x402/fetch";
import { createClientCasperSigner } from "@make-software/casper-x402";
import { ExactCasperScheme as ClientScheme } from "@make-software/casper-x402/exact/client";
import casperSdk from "casper-js-sdk";

const { KeyAlgorithm } = casperSdk;
const {
  PORT = "7788",
  PAYEE_ADDRESS,
  FACILITATOR_URL = "https://x402-facilitator.cspr.cloud",
  FACILITATOR_API_KEY,
  CAIP2_CHAIN_ID = "casper:casper-test",
  ASSET_PACKAGE,
  ASSET_NAME = "Wrapped CSPR",
  ASSET_SYMBOL = "WCSPR",
  PRICE_AMOUNT = "100000000",
  CLIENT_PRIVATE_KEY_PATH,
  CLIENT_KEY_ALGO = "ed25519",
  MATCHER_URL = "http://localhost:7799",
  X402_SUB_ID = "200",
} = process.env;

for (const [k, v] of Object.entries({ PAYEE_ADDRESS, FACILITATOR_API_KEY, ASSET_PACKAGE, CLIENT_PRIVATE_KEY_PATH })) {
  if (!v) { console.error(`missing env ${k}`); process.exit(1); }
}

const assetPackage = ASSET_PACKAGE.replace(/^hash-/, "");
const chainID = CAIP2_CHAIN_ID;
const selfBase = `http://localhost:${PORT}`;

// ---- Receiver (x402 paywall on GET /event) ----
const facilitatorClient = new HTTPFacilitatorClient({
  url: FACILITATOR_URL,
  createAuthHeaders: async () => {
    const auth = { Authorization: FACILITATOR_API_KEY };
    return { verify: auth, settle: auth, supported: auth, bazaar: auth };
  },
});
const assetAmount = { asset: assetPackage, amount: PRICE_AMOUNT, extra: { name: ASSET_NAME, symbol: ASSET_SYMBOL, version: "1", decimals: "9" } };
const serverScheme = new ServerScheme().registerAsset(chainID, assetPackage, 9).registerMoneyParser(() => Promise.resolve(assetAmount));

// ---- Payer (server-side agent), initialised lazily on first /pay ----
const algorithm = CLIENT_KEY_ALGO === "secp256k1" ? KeyAlgorithm.SECP256K1 : KeyAlgorithm.ED25519;
let payClient, fetchWithPayment;
async function ensurePayer() {
  if (fetchWithPayment) return;
  const signer = await createClientCasperSigner(CLIENT_PRIVATE_KEY_PATH, algorithm);
  payClient = new x402Client((_v, o) => o.find(x => x.network.startsWith("casper:")) || o[0]).register("casper:*", new ClientScheme(signer));
  fetchWithPayment = wrapFetchWithPayment(fetch, payClient);
}

// Simple per-IP rate limit: one live payment per 8s per client.
const lastPay = new Map();

const app = express();
app.use(cors({ origin: ["https://sluice.unitynodes.com", "http://localhost:4021", "http://localhost:7788"], methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Accept", "Authorization", "Content-Type", "Origin", "Payment-Signature"], exposedHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE"] }));

app.use(paymentMiddleware(
  { "GET /event": { accepts: [{ scheme: "exact", price: "$0.001", network: chainID, payTo: PAYEE_ADDRESS }], description: "One premium Sluice event delivery", mimeType: "application/json" } },
  new x402ResourceServer(facilitatorClient).register(chainID, serverScheme),
));

// The paid resource: a REAL event that Sluice matched for the x402-billed
// subscription, pulled from the live matcher's queue once the payment settled.
app.get("/event", async (_req, res) => {
  try {
    const r = await fetch(`${MATCHER_URL}/x402/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subscription_id: Number(X402_SUB_ID) }),
    });
    if (r.ok) { res.json(await r.json()); return; }
  } catch { /* fall through */ }
  res.json({ subscription_id: Number(X402_SUB_ID), pending: false, note: "no matched event queued yet; this subscription watches live DemoDex swaps", matched_at: new Date().toISOString() });
});

// The button target: fire ONE real x402 payment and return the settlement tx.
app.post("/pay", async (req, res) => {
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
  const now = Date.now();
  if (lastPay.get(ip) && now - lastPay.get(ip) < 8000) { res.status(429).json({ ok: false, error: "one payment every 8s, try again shortly" }); return; }
  lastPay.set(ip, now);
  try {
    // Settlement is on-chain and final, so refuse to charge for a delivery the
    // matcher cannot serve yet. Happens right after a matcher restart, before
    // the watched contract has emitted anything.
    try {
      const probe = await fetch(`${MATCHER_URL}/x402/available`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subscription_id: Number(X402_SUB_ID) }),
      });
      if (probe.ok && (await probe.json()).available === false) {
        res.status(503).json({
          ok: false,
          charged: false,
          error: "no matched event available yet, so nothing was charged",
          detail: `subscription ${X402_SUB_ID} watches live DemoDex swaps; it will have one shortly`,
        });
        return;
      }
    } catch { /* probe is best effort; fall through to the paid path */ }

    await ensurePayer();
    const r = await fetchWithPayment(`${selfBase}/event`, { method: "GET" });
    const event = await r.json();
    const settle = new x402HTTPClient(payClient).getPaymentSettleResponse(n => r.headers.get(n));
    const tx = settle && settle.transaction;
    res.json({
      ok: !!tx,
      tx: tx || null,
      explorer: tx ? `https://testnet.cspr.live/transaction/${tx}` : null,
      payer: (settle && settle.payer) || null,
      network: (settle && settle.network) || chainID,
      amount: `0.1 ${ASSET_SYMBOL}`,
      event,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e && e.message) || String(e) });
  }
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Every other Sluice API route answers in JSON, and Express' default HTML error
// page also leaks the internally rewritten path. Keep the contract uniform.
app.use((req, res) => {
  res.status(404).json({
    error: `unknown route ${req.method} ${req.path}`,
    routes: ["GET /event (x402 gated)", "POST /pay", "GET /health"],
  });
});
app.listen(Number(PORT), () => console.log(`x402 demo service on ${selfBase} -> facilitator ${FACILITATOR_URL}`));
