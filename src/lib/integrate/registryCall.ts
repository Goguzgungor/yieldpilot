/**
 * The live registry read behind /integrate step 03: the visitor's browser
 * builds an unsigned transaction calling a RiskRegistry read function and
 * POSTs it to the testnet RPC's simulateTransaction itself (the RPC allows
 * any origin), so what the page shows is exactly what was sent. Nothing is
 * signed or submitted. The Stellar SDK is loaded only when a call is made.
 */
import { VIGIL } from "./facts";
import type { OnchainRating } from "./callFlow";

/** Any account works as the source of a simulated read; this one is fixed so the request is reproducible. */
export const READ_SOURCE = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";

export type RegistryRead =
  | { fn: "get_rating"; pool: string }
  | { fn: "publishers" }
  | { fn: "threshold" }
  | { fn: "max_age" };

export interface RegistryCall<T> {
  /** e.g. `get_rating(Address(CAJJ…BXBD))`. */
  signature: string;
  url: string;
  /** The JSON-RPC body, as sent. */
  body: string;
  value: T;
  latestLedger: number;
  ms: number;
}

type Sdk = typeof import("@stellar/stellar-sdk");
let sdkPromise: Promise<Sdk> | null = null;
const loadSdk = () => (sdkPromise ??= import("@stellar/stellar-sdk"));

export const short = (id: string) => `${id.slice(0, 4)}…${id.slice(-4)}`;

/** The unsigned transaction a read simulates, as base64 XDR. */
export async function buildReadTx(read: RegistryRead, sdk?: Sdk): Promise<string> {
  const { Account, Address, Contract, TransactionBuilder } = sdk ?? (await loadSdk());
  const args = read.fn === "get_rating" ? [new Address(read.pool).toScVal()] : [];
  return new TransactionBuilder(new Account(READ_SOURCE, "0"), { fee: "100", networkPassphrase: VIGIL.networkPassphrase })
    .addOperation(new Contract(VIGIL.registryId).call(read.fn, ...args))
    .setTimeout(0)
    .build()
    .toXDR();
}

/** The decoded answer: `get_rating` → OnchainRating | null, publishers → addresses, threshold / max_age → numbers. */
export type ReadValue<R extends RegistryRead> = R["fn"] extends "get_rating"
  ? OnchainRating | null
  : R["fn"] extends "publishers"
    ? string[]
    : number;

function decode(read: RegistryRead, native: unknown): unknown {
  if (read.fn === "get_rating") {
    if (native === null || native === undefined) return null;
    const r = native as { score: number | bigint; publishers: number | bigint; timestamp: number | bigint };
    return { score: Number(r.score), publishers: Number(r.publishers), timestamp: Number(r.timestamp) };
  }
  if (read.fn === "publishers") return (native as string[]).map(String);
  return Number(native as number | bigint);
}

/** Simulate one registry read against the testnet RPC from wherever this runs. */
export async function callRegistry<R extends RegistryRead>(
  read: R,
  deps: { fetchImpl?: typeof fetch; now?: () => number; sdk?: Sdk } = {},
): Promise<RegistryCall<ReadValue<R>>> {
  const sdk = deps.sdk ?? (await loadSdk());
  const now = deps.now ?? (() => performance.now());
  const doFetch = deps.fetchImpl ?? fetch;
  const transaction = await buildReadTx(read, sdk);
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "simulateTransaction", params: { transaction } });
  const signature = read.fn === "get_rating" ? `get_rating(Address(${short(read.pool)}))` : `${read.fn}()`;

  const t0 = now();
  const res = await doFetch(VIGIL.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body });
  if (!res.ok) throw new Error(`RPC answered HTTP ${res.status}`);
  const json = (await res.json()) as {
    error?: { message?: string };
    result?: { latestLedger?: number; error?: string; results?: Array<{ xdr: string }> };
  };
  const ms = Math.round(now() - t0);
  if (json.error) throw new Error(`RPC error: ${json.error.message ?? "unknown"}`);
  if (json.result?.error) throw new Error(`simulation failed: ${json.result.error.split("\n")[0]}`);
  const xdr = json.result?.results?.[0]?.xdr;
  if (!xdr) throw new Error("simulation returned no value");
  const native = sdk.scValToNative(sdk.xdr.ScVal.fromXDR(xdr, "base64"));
  return {
    signature,
    url: VIGIL.rpcUrl,
    body,
    value: decode(read, native) as ReadValue<R>,
    latestLedger: Number(json.result?.latestLedger ?? 0),
    ms,
  };
}
