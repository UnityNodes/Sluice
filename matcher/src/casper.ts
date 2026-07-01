/**
 * SHIP-STOPPER FILE.
 *
 * Off-chain → on-chain bridge: builds, signs, and submits a TransactionV1
 * calling `record_delivery(id, event_hash)` on the deployed SubscriptionRegistry,
 * then polls the RPC for confirmation.
 *
 * casper-js-sdk: 5.0.0-rc6.
 * RPC endpoint: https://node.testnet.cspr.cloud/rpc (auth header required).
 */

import { readFileSync } from 'node:fs';
import axios from 'axios';
import {
  Args,
  ByPackageHashInvocationTarget,
  CLValueString,
  CLValueUInt32,
  Duration,
  Hash,
  HttpHandler,
  InitiatorAddr,
  KeyAlgorithm,
  PaymentLimitedMode,
  PricingMode,
  PrivateKey,
  RpcClient,
  StoredTarget,
  Timestamp,
  TransactionEntryPoint,
  TransactionEntryPointEnum,
  TransactionInvocationTarget,
  TransactionScheduling,
  TransactionTarget,
  TransactionV1,
  TransactionV1Payload,
} from 'casper-js-sdk';

export interface CasperClientConfig {
  nodeRpcUrl: string;                  // e.g. https://node.testnet.casper.network/rpc
  chainName: 'casper-test' | 'casper'; // testnet vs mainnet
  csprCloudToken?: string;             // sent as `authorization` header when endpoint is cspr.cloud
  paymentMotes?: number;               // gas budget in motes; default 5 CSPR (5e9 motes, safe in JS Number)
  gasPriceTolerance?: number;          // default 1
  ttlMs?: number;                      // default 30 min
}

export interface SubmissionResult {
  txHash: string;
  initiator: string;
  submittedAt: string;
}

export interface ConfirmedResult extends SubmissionResult {
  blockHash?: string;
  finalisedAt: string;
}

function buildHttpHandler(cfg: CasperClientConfig): HttpHandler {
  const handler = new HttpHandler(cfg.nodeRpcUrl);
  if (cfg.csprCloudToken) {
    handler.setCustomHeaders({ authorization: cfg.csprCloudToken });
  }
  return handler;
}

export class CasperClient {
  readonly rpc: RpcClient;

  constructor(private readonly cfg: CasperClientConfig) {
    const handler = buildHttpHandler(cfg);
    this.rpc = new RpcClient(handler);
  }

  /**
   * Loads a private key from a PEM file (casper-client keygen format).
   * Auto-detects ED25519 vs SECP256K1 from the PEM header; defaults to ED25519.
   */
  static async loadKey(pemPath: string, algorithm?: KeyAlgorithm): Promise<PrivateKey> {
    const pem = readFileSync(pemPath, 'utf8');
    const algo = algorithm ?? detectAlgorithm(pem);
    return await PrivateKey.fromPem(pem, algo);
  }

  /**
   * Builds and submits a `record_delivery(id, event_hash)` transaction.
   *
   * Returns immediately once the node accepts the tx; use {@link waitForConfirmation}
   * to wait for inclusion in a block.
   */
  async submitRecordDelivery(args: {
    contractHashHex: string;       // 64-hex package hash, no "contract-package-" prefix
    subscriptionId: number;
    eventHashHex: string;
    signer: PrivateKey;
  }): Promise<SubmissionResult> {
    const tx = await this.buildRecordDeliveryTx(args);
    const txHash = await this.submitTransaction(tx);
    return {
      txHash,
      initiator: args.signer.publicKey.toHex(),
      submittedAt: new Date().toISOString(),
    };
  }

  /**
   * Submits a TransactionV1 via JSON-RPC.
   *
   * KNOWN ISSUE (casper-js-sdk@5.0.0-rc6, 2026-06-29): the SDK serializes
   * Stored targets flat, `{ id, runtime, transferred_value }`, and includes
   * `transferred_value` in the hashed payload bytes. The on-chain decoder
   * expects `{ "Stored": { id, runtime } }` without `transferred_value` (for
   * non-payable entrypoints). Reshaping just the JSON makes the hash mismatch
   * the rebuilt struct, so the node returns "invalid hash".
   *
   * Workaround in v0.1: matcher's record_delivery is submitted via the
   * `casper-client` subprocess from `index.ts` (which speaks the chain's
   * exact serialization). This method is retained for the day a future SDK
   * release fixes the encoding; until then, prefer
   * `record_delivery_via_casper_client()` (see scripts/record-delivery.sh).
   *
   * Tracked in HONEST_LIMITS.md §9.
   */
  private async submitTransaction(tx: TransactionV1): Promise<string> {
    const json = TransactionV1.toJson(tx) as {
      hash: string;
      payload: {
        fields: {
          target: {
            id?: unknown;
            runtime?: string;
            transferred_value?: number;
            native?: unknown;
            session?: unknown;
            Stored?: unknown;
            Native?: unknown;
            Session?: unknown;
          };
        };
      };
    };

    const target = json.payload.fields.target;
    if (target.id && target.runtime && !target.Stored) {
      json.payload.fields.target = {
        Stored: {
          id: target.id,
          runtime: target.runtime,
        },
      };
    }

    const body = {
      jsonrpc: '2.0',
      method: 'account_put_transaction',
      params: { transaction: { Version1: json } },
      id: 1,
    };

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.cfg.csprCloudToken) headers.authorization = this.cfg.csprCloudToken;

    const resp = await axios.post(this.cfg.nodeRpcUrl, body, { headers, timeout: 15_000, validateStatus: () => true });
    if (resp.status !== 200) {
      throw new Error(`RPC HTTP ${resp.status}: ${JSON.stringify(resp.data).slice(0, 200)}`);
    }
    if (resp.data?.error) {
      throw new Error(`RPC error: ${JSON.stringify(resp.data.error)}`);
    }
    const v1 = resp.data?.result?.transaction_hash?.Version1;
    if (!v1) {
      throw new Error(`unexpected RPC response: ${JSON.stringify(resp.data).slice(0, 200)}`);
    }
    return v1;
  }

  async buildRecordDeliveryTx(opts: {
    contractHashHex: string;
    subscriptionId: number;
    eventHashHex: string;
    signer: PrivateKey;
  }): Promise<TransactionV1> {
    const { contractHashHex, subscriptionId, eventHashHex, signer } = opts;
    // Odra deploys contracts as Casper *packages*, so we invoke by-package-hash
    // (latest version when `version` is 0/undefined).
    const packageHashBytes = hexToBytes(stripHashPrefix(contractHashHex));

    const byPkg = new ByPackageHashInvocationTarget();
    byPkg.addr = new Hash(packageHashBytes);
    // `version` is optional: omitting it (== null) means "latest version".
    // Setting it to 0 is a real version number and may be rejected by the node.
    (byPkg as { version?: number }).version = undefined;

    const invocation = new TransactionInvocationTarget();
    invocation.byPackageHash = byPkg;

    const stored = new StoredTarget();
    stored.runtime = 'VmCasperV1';
    stored.id = invocation;
    stored.transferredValue = 0; // record_delivery is non-payable
    const transactionTarget = new TransactionTarget(undefined, stored);

    const entryPoint = new TransactionEntryPoint(
      TransactionEntryPointEnum.Custom,
      'record_delivery',
    );

    const callArgs = Args.fromMap({
      // newCLUInt32 declares BigNumber but the runtime accepts a plain JS number.
      id: CLValueUInt32.newCLUInt32(subscriptionId as unknown as never),
      event_hash: CLValueString.newCLString(eventHashHex),
    });

    // Casper testnet chainspec sets pricing_handling = payment_limited (classic),
    // which the SDK calls PaymentLimitedMode. FixedMode is rejected by the node.
    const payLimited = new PaymentLimitedMode();
    payLimited.paymentAmount = this.cfg.paymentMotes ?? 5_000_000_000;
    payLimited.gasPriceTolerance = this.cfg.gasPriceTolerance ?? 1;
    payLimited.standardPayment = true;
    const pricingMode = new PricingMode();
    pricingMode.paymentLimited = payLimited;

    const payload = TransactionV1Payload.build({
      initiatorAddr: new InitiatorAddr(signer.publicKey),
      ttl: new Duration(this.cfg.ttlMs ?? 30 * 60 * 1000),
      args: callArgs,
      timestamp: new Timestamp(new Date()),
      entryPoint,
      scheduling: new TransactionScheduling({}),
      transactionTarget,
      chainName: this.cfg.chainName,
      pricingMode,
    });

    const tx = TransactionV1.makeTransactionV1(payload);
    await tx.sign(signer);
    return tx;
  }

  /**
   * Polls `getTransactionByTransactionHash` until the tx is included or the timeout fires.
   * Backoff: 2s × N, max ~120s default.
   */
  async waitForConfirmation(txHashHex: string, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<ConfirmedResult> {
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const intervalMs = opts.intervalMs ?? 2_000;
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      try {
        const res = await this.rpc.getTransactionByTransactionHash(txHashHex);
        // res shape: { transaction, execution_info?, ... }
        const exec = (res as { executionInfo?: { blockHash?: string } }).executionInfo;
        if (exec && exec.blockHash) {
          return {
            txHash: txHashHex,
            initiator: '',
            submittedAt: '',
            blockHash: exec.blockHash,
            finalisedAt: new Date().toISOString(),
          };
        }
      } catch {
        // not yet visible; keep polling
      }
      await sleep(intervalMs);
    }
    throw new Error(`tx ${txHashHex} not confirmed within ${timeoutMs}ms`);
  }
}

// ---- helpers ----

function detectAlgorithm(pem: string): KeyAlgorithm {
  // casper-client keygen writes:
  //   ed25519: BEGIN PRIVATE KEY (PKCS8 with ED25519 OID)
  //   secp256k1: BEGIN EC PRIVATE KEY
  if (pem.includes('BEGIN EC PRIVATE KEY')) return KeyAlgorithm.SECP256K1;
  return KeyAlgorithm.ED25519;
}

function stripHashPrefix(s: string): string {
  if (s.startsWith('hash-')) return s.slice(5);
  if (s.startsWith('contract-')) return s.slice(9);
  if (s.startsWith('0x')) return s.slice(2);
  return s;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = stripHashPrefix(hex);
  if (clean.length % 2 !== 0) throw new Error(`bad hex length: ${clean.length}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    out[i / 2] = parseInt(clean.substr(i, 2), 16);
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
