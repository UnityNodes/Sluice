// Sluice x402 payer: an agent that pays a real x402 micropayment (settled by the
// live hosted Casper facilitator) to receive one premium event delivery.
import { x402Client, x402HTTPClient, wrapFetchWithPayment } from "@x402/fetch";
import { createClientCasperSigner } from "@make-software/casper-x402";
import { ExactCasperScheme } from "@make-software/casper-x402/exact/client";
import casperSdk from "casper-js-sdk";

const { KeyAlgorithm } = casperSdk;
const {
  CLIENT_PRIVATE_KEY_PATH,
  CLIENT_KEY_ALGO = "ed25519",
  SERVER_URL = "http://localhost:4021",
} = process.env;

if (!CLIENT_PRIVATE_KEY_PATH) { console.error("missing CLIENT_PRIVATE_KEY_PATH"); process.exit(1); }

const url = `${SERVER_URL}/event`;

async function main() {
  const algorithm = CLIENT_KEY_ALGO === "secp256k1" ? KeyAlgorithm.SECP256K1 : KeyAlgorithm.ED25519;
  const signer = await createClientCasperSigner(CLIENT_PRIVATE_KEY_PATH, algorithm);

  const selector = (_v, options) => options.find(o => o.network.startsWith("casper:")) || options[0];
  const client = new x402Client(selector).register("casper:*", new ExactCasperScheme(signer));
  const fetchWithPayment = wrapFetchWithPayment(fetch, client);

  console.log(`agent requesting paid delivery: ${url}`);
  const response = await fetchWithPayment(url, { method: "GET" });
  const body = await response.json();
  console.log("delivery received:", JSON.stringify(body));

  const settle = new x402HTTPClient(client).getPaymentSettleResponse(n => response.headers.get(n));
  if (settle) console.log("SETTLEMENT:", JSON.stringify(settle));
}
main().catch(e => { console.error("payer error:", e?.response?.data?.error ?? e?.message ?? e); process.exit(1); });
