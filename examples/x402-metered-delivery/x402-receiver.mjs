// Sluice x402 receiver: a delivery endpoint gated behind a real x402 paywall,
// settled by the LIVE hosted Casper facilitator (x402-facilitator.cspr.cloud).
import cors from "cors";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactCasperScheme } from "@make-software/casper-x402/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";

const {
  PORT = "4021",
  PAYEE_ADDRESS,
  FACILITATOR_URL = "https://x402-facilitator.cspr.cloud",
  FACILITATOR_API_KEY,
  CAIP2_CHAIN_ID = "casper:casper-test",
  ASSET_PACKAGE,
  ASSET_NAME = "Sluice X402 Token",
  ASSET_SYMBOL = "SLX",
  PRICE_AMOUNT = "100000000", // 0.1 token @ 9 decimals
} = process.env;

for (const [k, v] of Object.entries({ PAYEE_ADDRESS, FACILITATOR_API_KEY, ASSET_PACKAGE })) {
  if (!v) { console.error(`missing env ${k}`); process.exit(1); }
}

const assetPackage = ASSET_PACKAGE.replace(/^hash-/, "");
const chainID = CAIP2_CHAIN_ID;

const facilitatorConfig = {
  url: FACILITATOR_URL,
  createAuthHeaders: async () => {
    const auth = { Authorization: FACILITATOR_API_KEY };
    return { verify: auth, settle: auth, supported: auth, bazaar: auth };
  },
};
const facilitatorClient = new HTTPFacilitatorClient(facilitatorConfig);

const assetAmount = {
  asset: assetPackage,
  amount: PRICE_AMOUNT,
  extra: { name: ASSET_NAME, symbol: ASSET_SYMBOL, version: "1", decimals: "9" },
};
const casperScheme = new ExactCasperScheme()
  .registerAsset(chainID, assetPackage, 9)
  .registerMoneyParser(() => Promise.resolve(assetAmount));

const app = express();
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Accept", "Authorization", "Content-Type", "Origin", "Payment-Signature"],
  exposedHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE"],
  maxAge: 24 * 60 * 60,
}));

app.use(paymentMiddleware(
  {
    "GET /event": {
      accepts: [{ scheme: "exact", price: "$0.001", network: chainID, payTo: PAYEE_ADDRESS }],
      description: "One premium on-chain event delivery from Sluice",
      mimeType: "application/json",
    },
  },
  new x402ResourceServer(facilitatorClient).register(chainID, casperScheme),
));

// The paid resource: a Sluice-shaped matched-event delivery.
app.get("/event", (_req, res) => {
  res.json({
    subscription_id: 42,
    event: { event_type: "contract", name: "Swap", contract_package_hash: "65bedddde0…", data: { amount_in: "150000000000000" } },
    matched_at: new Date().toISOString(),
    note: "delivered because the x402 micropayment settled on-chain",
  });
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.listen(Number(PORT), () => console.log(`Sluice x402 receiver on http://localhost:${PORT} -> facilitator ${FACILITATOR_URL}`));
