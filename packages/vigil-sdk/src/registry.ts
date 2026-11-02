/**
 * RiskRegistry (contracts/vigil-registry) client: read ratings via simulation,
 * build publish operations for publishers.
 */
import { Address, BASE_FEE, Contract, TransactionBuilder, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { Account, Transaction } from "@stellar/stellar-sdk";

/** M-of-N aggregate: median score of fresh submissions, oldest timestamp used. */
export interface Rating {
  score: number;
  publishers: number;
  /** Unix seconds — the OLDEST submission used (conservative freshness). */
  timestamp: bigint;
}

/** One publisher's latest entry for a pool. */
export interface Submission {
  score: number;
  timestamp: bigint;
  /** hex */
  reasonsHash: string;
}

export interface RatingInput {
  pool: string;
  score: number;
  /** Unix seconds; must be <= ledger time and within the registry's max age. */
  timestamp: bigint;
  /** 32-byte sha256 of the published reasons (hex). */
  reasonsHash: string;
}

/** The subset of rpc.Server the client needs (a real rpc.Server satisfies it). */
export interface ReadServer {
  getAccount(address: string): Promise<Account>;
  simulateTransaction(tx: Transaction): Promise<rpc.Api.SimulateTransactionResponse>;
}

const addr = (a: string) => Address.fromString(a).toScVal();
const u64 = (n: bigint) => xdr.ScVal.scvU64(xdr.Uint64.fromString(n.toString()));

function ratingInputScVal(r: RatingInput): xdr.ScVal {
  if (!/^[0-9a-f]{64}$/i.test(r.reasonsHash)) throw new Error("reasonsHash must be 32 bytes of hex");
  if (!Number.isInteger(r.score) || r.score < 0 || r.score > 100) throw new Error("score must be an integer 0..100");
  const e = (k: string, v: xdr.ScVal) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: v });
  return xdr.ScVal.scvMap([
    e("pool", addr(r.pool)),
    e("reasons_hash", xdr.ScVal.scvBytes(Buffer.from(r.reasonsHash, "hex"))),
    e("score", xdr.ScVal.scvU32(r.score)),
    e("timestamp", u64(r.timestamp)),
  ]);
}

export class RegistryClient {
  constructor(
    readonly registryId: string,
    private readonly server: ReadServer,
    private readonly networkPassphrase: string,
    /** Any funded account, used only as the simulation source. */
    private readonly readerSource: string,
  ) {}

  private async read(fn: string, ...args: xdr.ScVal[]): Promise<unknown> {
    const tx = new TransactionBuilder(await this.server.getAccount(this.readerSource), {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(new Contract(this.registryId).call(fn, ...args))
      .setTimeout(30)
      .build();
    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw new Error(`${fn}: ${sim.error.split("\n")[0]}`);
    const ret = (sim as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    return ret ? scValToNative(ret) : undefined;
  }

  /** The aggregate rating, or null when fewer than `threshold` fresh submissions exist. */
  async getRating(pool: string): Promise<Rating | null> {
    const r = (await this.read("get_rating", addr(pool))) as { score: number; publishers: number; timestamp: bigint } | null | undefined;
    return r ? { score: Number(r.score), publishers: Number(r.publishers), timestamp: BigInt(r.timestamp) } : null;
  }

  /** `publisher`'s latest submission for `pool`, or null. */
  async getSubmission(pool: string, publisher: string): Promise<Submission | null> {
    const r = (await this.read("get_submission", addr(pool), addr(publisher))) as { score: number; timestamp: bigint; reasons_hash: Uint8Array } | null | undefined;
    return r ? { score: Number(r.score), timestamp: BigInt(r.timestamp), reasonsHash: Buffer.from(r.reasons_hash).toString("hex") } : null;
  }

  async publishers(): Promise<string[]> {
    return (await this.read("publishers")) as string[];
  }

  async threshold(): Promise<number> {
    return Number(await this.read("threshold"));
  }

  /** Would RiskGate let a deposit into `pool` through for these params, right now? */
  async depositAllowed(pool: string, minScore: number, maxAgeSecs: bigint, nowSecs = BigInt(Math.floor(Date.now() / 1000))) {
    const r = await this.getRating(pool);
    if (!r) return { allowed: false, reason: "no rating (4114)" } as const;
    if (r.timestamp > nowSecs || nowSecs - r.timestamp > maxAgeSecs) return { allowed: false, reason: "rating stale (4116)", rating: r } as const;
    if (r.score < minScore) return { allowed: false, reason: `score ${r.score} < ${minScore} (4115)`, rating: r } as const;
    return { allowed: true, rating: r } as const;
  }

  /** `publish(publisher, pool, score, timestamp, reasons_hash)` — the publisher signs. */
  publishOp(publisher: string, r: RatingInput): xdr.Operation {
    const v = ratingInputScVal(r).map()!;
    const get = (k: string) => v.find((e) => e.key().sym().toString() === k)!.val();
    return new Contract(this.registryId).call("publish", addr(publisher), get("pool"), get("score"), get("timestamp"), get("reasons_hash"));
  }

  /** `publish_batch(publisher, Vec<RatingInput>)` — all-or-nothing, at most 32 entries. */
  publishBatchOp(publisher: string, ratings: RatingInput[]): xdr.Operation {
    if (ratings.length === 0 || ratings.length > 32) throw new Error("publish_batch takes 1..32 ratings");
    return new Contract(this.registryId).call("publish_batch", addr(publisher), xdr.ScVal.scvVec(ratings.map(ratingInputScVal)));
  }
}
