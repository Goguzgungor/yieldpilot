/**
 * The code another project's AI copies. Each snippet is self-contained (no
 * Vigil SDK: it is not on npm) and carries the rule the reader chose.
 *
 * integrate.test.ts parses the TypeScript ones. When they were written
 * (2026-11-05) the TypeScript also passed `tsc --strict` against
 * @stellar/stellar-sdk 15.1, the reads ran against the live API and the
 * testnet registry, the RiskGate params and add_policy op encoded byte for
 * byte like packages/vigil-sdk's, and the Rust check compiled against
 * soroban-sdk 28 and passed allowed / missing / low / stale tests against a
 * mock registry. Re-run those checks after changing a snippet.
 */
import { VIGIL } from "./facts";

export type SnippetId = "api" | "registry-ts" | "registry-rust" | "riskgate";

export interface SnippetOptions {
  minScore: number;
  maxAgeSecs: number;
}

export interface Snippet {
  lang: "ts" | "rust";
  /** Where the file goes, for the reader. */
  file: string;
  code: string;
}

const api = ({ minScore, maxAgeSecs }: SnippetOptions): Snippet => ({
  lang: "ts",
  file: "vigil.ts (server or browser)",
  code: `// Vigil pool ratings from the public API. Cache the response for 5 minutes or more:
// ratings are recomputed every ${VIGIL.publishEveryMin} minutes.
export type VigilRating = {
  poolId: string;               // Blend pool or DeFindex strategy contract id (mainnet)
  name: string;
  grade: "A" | "B" | "C" | "D" | "E" | "NR";
  score: number | null;         // 0..100, higher is safer; null when not rated
  eligibleForDeposit: boolean;  // false when a hard rule holds the pool back
  reasons: string[];
  hardRules: string[];
};

export const MIN_SCORE = ${minScore};
export const MAX_AGE_SECS = ${maxAgeSecs};

export async function fetchVigilRatings(): Promise<{ computedAt: number; ratings: Map<string, VigilRating> }> {
  const res = await fetch("${VIGIL.apiRatings}");
  if (!res.ok) throw new Error(\`Vigil API HTTP \${res.status}\`);
  const body = (await res.json()) as { computedAt: number; ratings: VigilRating[] };
  return { computedAt: body.computedAt, ratings: new Map(body.ratings.map((r) => [r.poolId, r])) };
}

// The same rule RiskGate enforces on-chain. Anything unknown, unrated, held back,
// under the minimum or too old is refused: fail closed.
export function depositAllowed(r: VigilRating | undefined, computedAt: number, nowSecs = Date.now() / 1000): boolean {
  if (!r || r.score === null || !r.eligibleForDeposit) return false;
  if (nowSecs - computedAt > MAX_AGE_SECS) return false;
  return r.score >= MIN_SCORE;
}
`,
});

const registryTs = ({ minScore, maxAgeSecs }: SnippetOptions): Snippet => ({
  lang: "ts",
  file: "vigil-registry.ts (server; checked with @stellar/stellar-sdk 15.1)",
  code: `import { Account, Address, BASE_FEE, Contract, Keypair, Networks, TransactionBuilder, rpc, scValToNative } from "@stellar/stellar-sdk";

const RPC_URL = "${VIGIL.rpcUrl}";
const REGISTRY = "${VIGIL.registryId}"; // Vigil RiskRegistry (${VIGIL.network})
export const MIN_SCORE = ${minScore};
export const MAX_AGE_SECS = ${maxAgeSecs};

const server = new rpc.Server(RPC_URL);

export type Rating = { score: number; publishers: number; timestamp: bigint };

// get_rating is a read: the transaction is simulated, never sent, so any
// account (even an unfunded random one) works as the source.
export async function getRating(pool: string): Promise<Rating | null> {
  const source = new Account(Keypair.random().publicKey(), "0");
  const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(new Contract(REGISTRY).call("get_rating", new Address(pool).toScVal()))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(\`get_rating failed: \${sim.error}\`);
  const v = sim.result?.retval ? scValToNative(sim.result.retval) : null;
  return v ? { score: Number(v.score), publishers: Number(v.publishers), timestamp: BigInt(v.timestamp) } : null;
}

// RiskGate's rule, in order: a rating exists (4114), it is fresh (4116), it meets
// the minimum (4115). Call it before every deposit; a thrown error means no deposit.
export async function depositAllowed(pool: string, nowSecs = BigInt(Math.floor(Date.now() / 1000))): Promise<{ allowed: boolean; reason: string }> {
  const r = await getRating(pool);
  if (!r) return { allowed: false, reason: "no rating (4114)" };
  if (r.timestamp > nowSecs || nowSecs - r.timestamp > BigInt(MAX_AGE_SECS)) return { allowed: false, reason: "rating too old (4116)" };
  if (r.score < MIN_SCORE) return { allowed: false, reason: \`score \${r.score} < \${MIN_SCORE} (4115)\` };
  return { allowed: true, reason: \`score \${r.score}\` };
}
`,
});

const registryRust = ({ minScore, maxAgeSecs }: SnippetOptions): Snippet => ({
  lang: "rust",
  file: "src/vigil.rs (your Soroban contract; checked with soroban-sdk 28)",
  code: `use soroban_sdk::{contractclient, contracterror, contracttype, panic_with_error, Address, Env};

/// Vigil RiskRegistry (${VIGIL.network}): ${VIGIL.registryId}
/// Store it in your contract's config rather than hard-coding it.

/// Copied from Vigil's vigil-interface crate. Field names and types must match exactly.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Rating {
    pub score: u32,      // median of the fresh submissions, 0..=100, higher is safer
    pub publishers: u32, // how many publishers' submissions were counted
    pub timestamp: u64,  // the oldest counted submission, unix seconds
}

#[contractclient(name = "RiskRegistryClient")]
pub trait RiskRegistry {
    fn get_rating(env: Env, pool: Address) -> Option<Rating>;
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum RiskError {
    RatingUnavailable = 1,
    RatingStale = 2,
    ScoreTooLow = 3,
}

pub const MIN_SCORE: u32 = ${minScore};
pub const MAX_AGE_SECS: u64 = ${maxAgeSecs};

/// Call before your contract moves funds into \`pool\`; withdrawals should not call it.
/// A failed registry call reverts the deposit too: fail closed.
pub fn require_rated(env: &Env, registry: &Address, pool: &Address) {
    let rating = RiskRegistryClient::new(env, registry)
        .get_rating(pool)
        .unwrap_or_else(|| panic_with_error!(env, RiskError::RatingUnavailable));
    let now = env.ledger().timestamp();
    if rating.timestamp > now || now - rating.timestamp > MAX_AGE_SECS {
        panic_with_error!(env, RiskError::RatingStale);
    }
    if rating.score < MIN_SCORE {
        panic_with_error!(env, RiskError::ScoreTooLow);
    }
}
`,
});

const riskgate = ({ minScore, maxAgeSecs }: SnippetOptions): Snippet => ({
  lang: "ts",
  file: "riskgate.ts (where you build smart-account transactions; checked with @stellar/stellar-sdk 15.1)",
  code: `import { Address, Contract, xdr } from "@stellar/stellar-sdk";

const RISKGATE = "${VIGIL.guardId}"; // Vigil RiskGate policy (${VIGIL.network}), shared, no admin
const REGISTRY = "${VIGIL.registryId}"; // Vigil RiskRegistry (${VIGIL.network})
export const MIN_SCORE = ${minScore};
export const MAX_AGE_SECS = ${maxAgeSecs};

const entry = (key: string, val: xdr.ScVal) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val });
const u64 = (n: number) => xdr.ScVal.scvU64(xdr.Uint64.fromString(String(n)));

// RiskGateParams is a contract struct: an ScMap whose keys MUST stay in this sorted order.
// Pool rule (CallContract(pool)): deposits need a fresh rating >= MIN_SCORE.
export function poolRuleParams(): xdr.ScVal {
  return xdr.ScVal.scvMap([
    entry("allowed_recipients", xdr.ScVal.scvVec([])),
    entry("max_age_secs", u64(MAX_AGE_SECS)),
    entry("min_score", xdr.ScVal.scvU32(MIN_SCORE)),
    entry("registry", new Address(REGISTRY).toScVal()),
  ]);
}

// Token rule (CallContract(USDC)): transfer may only pay these contracts, e.g. your pools.
export function tokenRuleParams(allowedRecipients: string[]): xdr.ScVal {
  return xdr.ScVal.scvMap([
    entry("allowed_recipients", xdr.ScVal.scvVec(allowedRecipients.map((a) => new Address(a).toScVal()))),
    entry("max_age_secs", u64(0)),
    entry("min_score", xdr.ScVal.scvU32(0)),
    entry("registry", xdr.ScVal.scvVoid()),
  ]);
}

// add_policy(context_rule_id, policy, install_param) on the user's OpenZeppelin smart account.
// contextRuleId is the rule your agent signs under. The account's owner must authorize this call.
export function installRiskGateOp(smartAccount: string, contextRuleId: number, params: xdr.ScVal): xdr.Operation {
  return new Contract(smartAccount).call("add_policy", xdr.ScVal.scvU32(contextRuleId), new Address(RISKGATE).toScVal(), params);
}

// Find a RiskGate refusal in a simulation or submit error, e.g. "Error(Contract, #4115)".
export function riskGateError(message: string): number | null {
  const m = message.match(/Error\\(Contract, #(41\\d\\d)\\)/);
  return m ? Number(m[1]) : null;
}
`,
});

const BUILDERS: Record<SnippetId, (o: SnippetOptions) => Snippet> = {
  api,
  "registry-ts": registryTs,
  "registry-rust": registryRust,
  riskgate,
};

export function snippet(id: SnippetId, opts: SnippetOptions): Snippet {
  return BUILDERS[id](opts);
}
