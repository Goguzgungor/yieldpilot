/**
 * SERVER-ONLY. The publisher's job in the M-of-N model: sign every rated pool's
 * (score, timestamp, reasonsHash) into the RiskRegistry with `publish_batch`,
 * plus YieldPilot's testnet exec-pool stand-in. Shared by scripts/vigil-publish.ts
 * and /api/cron/publish.
 *
 * The signed score is the engine's score when Vigil marks the pool eligible for
 * deposits and 0 when it does not ({@link registryScore}): the registry has no
 * eligibility field, and a pool held back by a hard rule (lenders locked in, a
 * backstop about to freeze) can still score above a RiskGate minimum. The
 * reasonsHash is the rating's either way, so the full score stays verifiable.
 *
 * Testnet stand-in: YieldPilot executes every deposit into one testnet pool,
 * whatever mainnet pool it chose. That pool gets the rating of the mainnet pool
 * YieldPilot holds, so the RiskGate on the testnet wallets checks the rating the
 * agent routed by: its score, or 0 when Vigil marks that pool not eligible.
 * Nothing is published for it when the pool is NR or there is no position, so
 * the gate refuses.
 */
import { gunzipSync, gzipSync } from "node:zlib";
import { Keypair, TransactionBuilder, rpc, type Transaction } from "@stellar/stellar-sdk";
import { decodeVigilError } from "../../../packages/vigil-sdk/src/guard";
import { RegistryClient, type RatingInput } from "../../../packages/vigil-sdk/src/registry";

export interface PublishableRating {
  poolId: string;
  name: string;
  /** null for NR (not rated): nothing is published, so the guard refuses deposits. */
  score: number | null;
  grade: string;
  eligibleForDeposit: boolean;
  reasonsHash: string;
}

export interface PublishOutcome {
  engineVersion: string;
  /** The engine's computedAt (mainnet chain time, unix s): the timestamp signed on-chain. */
  computedAt: number;
  published: number;
  skippedNotRated: number;
  /** What the exec pool got, or why nothing was published for it. */
  execPool: string;
  txs: string[];
  failures: string[];
}

/** What the registry gets for a rating: its score, 0 when not eligible, null for NR. */
export function registryScore(r: Pick<PublishableRating, "score" | "eligibleForDeposit">): number | null {
  if (r.score === null) return null;
  return r.eligibleForDeposit ? r.score : 0;
}

/** The exec pool's stand-in rating (see header), or null with the reason. */
export function execPoolStandIn(
  ratings: PublishableRating[],
  heldPoolId: string | null,
  execPoolId: string,
  timestamp: bigint,
): { input: RatingInput | null; note: string } {
  const r = heldPoolId ? ratings.find((x) => x.poolId === heldPoolId) : undefined;
  if (!r || r.score === null) {
    const why = heldPoolId ? `held pool ${heldPoolId.slice(0, 6)}… is ${r ? "NR" : "unrated"}` : "no position";
    return { input: null, note: `exec pool ${execPoolId.slice(0, 6)}…: no rating published (${why})` };
  }
  const score = registryScore(r) ?? 0;
  return {
    input: { pool: execPoolId, score, timestamp, reasonsHash: r.reasonsHash },
    note: `exec pool ${execPoolId.slice(0, 6)}… stands in for ${r.name}: ${r.grade} ${r.score}${r.eligibleForDeposit ? "" : " (not eligible ⇒ 0)"}`,
  };
}

/** The registry inputs for one run: every rated pool at its {@link registryScore}, then the stand-in. */
export function registryInputs(ratings: PublishableRating[], computedAt: number, standIn: RatingInput | null): RatingInput[] {
  const inputs: RatingInput[] = ratings
    .filter((r): r is PublishableRating & { score: number } => r.score !== null)
    .map((r) => ({ pool: r.poolId, score: registryScore(r)!, timestamp: BigInt(computedAt), reasonsHash: r.reasonsHash }));
  return standIn ? [...inputs, standIn] : inputs;
}

async function send(server: rpc.Server, tx: Transaction): Promise<string> {
  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") throw new Error(`send ERROR ${sent.errorResult?.toXDR("base64")}`);
  let g = await server.getTransaction(sent.hash);
  for (let i = 0; i < 30 && g.status === "NOT_FOUND"; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    g = await server.getTransaction(sent.hash);
  }
  if (g.status !== "SUCCESS") throw new Error(`tx ${sent.hash} ${g.status}`);
  return sent.hash;
}

/**
 * Sign one run into the registry, 8 ratings per `publish_batch`. The registry
 * rejects timestamps in the future and older than its max age; the engine's
 * computedAt is mainnet chain time, which is what is signed.
 */
export async function publishRatings(opts: {
  server: rpc.Server;
  networkPassphrase: string;
  registryId: string;
  publisher: Keypair;
  engineVersion: string;
  computedAt: number;
  ratings: PublishableRating[];
  /** YieldPilot's testnet exec pool and the mainnet pool it holds (see header). */
  execPoolId?: string;
  heldPoolId?: string | null;
  log?: (line: string) => void;
}): Promise<PublishOutcome> {
  const log = opts.log ?? (() => {});
  const client = new RegistryClient(opts.registryId, opts.server, opts.networkPassphrase, opts.publisher.publicKey());
  const standIn = opts.execPoolId
    ? execPoolStandIn(opts.ratings, opts.heldPoolId ?? null, opts.execPoolId, BigInt(opts.computedAt))
    : { input: null, note: "no exec pool configured" };
  log(standIn.note);
  const inputs = registryInputs(opts.ratings, opts.computedAt, standIn.input);
  const out: PublishOutcome = {
    engineVersion: opts.engineVersion,
    computedAt: opts.computedAt,
    published: 0,
    skippedNotRated: opts.ratings.filter((r) => r.score === null).length,
    execPool: standIn.note,
    txs: [],
    failures: [],
  };
  for (let i = 0; i < inputs.length; i += 8) {
    const chunk = inputs.slice(i, i + 8);
    const label = `publish_batch ${i + 1}–${i + chunk.length}`;
    try {
      const tx = new TransactionBuilder(await opts.server.getAccount(opts.publisher.publicKey()), {
        fee: "10000000",
        networkPassphrase: opts.networkPassphrase,
      })
        .addOperation(client.publishBatchOp(opts.publisher.publicKey(), chunk))
        .setTimeout(120)
        .build();
      const prepared = await opts.server.prepareTransaction(tx);
      prepared.sign(opts.publisher);
      const hash = await send(opts.server, prepared);
      out.txs.push(hash);
      out.published += chunk.length;
      log(`  ${label}: ${hash}`);
    } catch (e) {
      const msg = (e as Error).message;
      const v = decodeVigilError(msg);
      const failure = `${label} FAILED: ${v ? `${v.code} ${v.name}` : msg.split("\n")[0]}`;
      out.failures.push(failure);
      log(`  ${failure}`);
    }
  }
  return out;
}

// ── Run archive ───────────────────────────────────────────────────────────────

/** Every published run's input (with what each reasonsHash covers) is kept this long. */
export const RUN_ARCHIVE_DAYS = 90;

/** A run or an order book as stored: gzip + base64 of its JSON. */
export const packRun = (json: string): string => gzipSync(Buffer.from(json)).toString("base64");
export const unpackRun = (packed: string): string => gunzipSync(Buffer.from(packed, "base64")).toString();

/** The archive index after adding `computedAt`: ascending, deduplicated, and what fell out of the window. */
export function nextRunIndex(index: number[], computedAt: number, nowSec: number): { index: number[]; dropped: number[] } {
  const cutoff = nowSec - RUN_ARCHIVE_DAYS * 86_400;
  const all = [...new Set([...index, computedAt])].sort((a, b) => a - b);
  return { index: all.filter((t) => t >= cutoff), dropped: all.filter((t) => t < cutoff) };
}

/**
 * The order-book index after archiving a run at `computedAt` that names `hashes`
 * (book hash → the last run that named it): which books to write (not stored
 * yet) and which to drop (no run from `oldestKept` on names them).
 */
export function nextBookIndex(
  index: Record<string, number>,
  hashes: string[],
  computedAt: number,
  oldestKept: number,
): { index: Record<string, number>; write: string[]; drop: string[] } {
  const out = { ...index };
  const write = hashes.filter((h) => !(h in out));
  for (const h of hashes) out[h] = Math.max(out[h] ?? 0, computedAt);
  const drop = Object.keys(out).filter((h) => out[h] < oldestKept);
  for (const h of drop) delete out[h];
  return { index: out, write, drop };
}
