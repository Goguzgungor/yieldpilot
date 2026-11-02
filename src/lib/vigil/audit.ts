/**
 * The run archive, and checking it.
 *
 * A run's ratings JSON (engine.ts `toRatingsJson`) carries each pool's full
 * snapshot with every SDEX order book replaced by its sha256 (`asksHash`, the
 * value `hashInputs` hashes), and the books once each in `books`. The server
 * archive stores each book once by that hash, however many pools and runs it
 * appears in. {@link verifyRun} recomputes every published reasonsHash from the
 * archived input, then re-rates every pool with this checkout's engine.
 */
import { sha256Canonical } from "./canonical";
import { rateDefindexStrategy, type DefindexStrategyInput } from "./defindex";
import { ENGINE_VERSION, hashInputs, ratePool } from "./score";
import type { AskLevel, DexDepth, DexDepthSample, PoolRating, PoolSnapshot } from "./types";

/** Order books by their sha256Canonical. */
export type Books = Record<string, AskLevel[]>;

/** A book as archived: the asks are in {@link Books} under `asksHash`. */
export type ArchivedBook<T extends DexDepth = DexDepth> = Omit<T, "asks"> & { asksHash: string; levels: number; bestAsk: number | null };

export type ArchivedSnapshot = Omit<PoolSnapshot, "dexDepth" | "dexDepthHistory"> & {
  dexDepth: Record<string, ArchivedBook>;
  dexDepthHistory?: Record<string, ArchivedBook<DexDepthSample>[]>;
};

/** The parts of a run's ratings JSON the archive and the check read. */
export interface ArchivedRun {
  engineVersion: string;
  computedAt: number;
  ratings: PoolRating[];
  inputs?: Record<string, ArchivedSnapshot>;
  strategies?: DefindexStrategyInput[];
  books?: Books;
}

const mapValues = <A, B>(o: Record<string, A>, f: (a: A) => B): Record<string, B> =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v)]));

/** `s` with its books moved into `books`. */
export function archiveSnapshot(s: PoolSnapshot, books: Books): ArchivedSnapshot {
  const book = <T extends DexDepth>({ asks, ...rest }: T): ArchivedBook<T> => {
    const asksHash = sha256Canonical(asks);
    books[asksHash] = asks;
    return { ...rest, asksHash, levels: asks.length, bestAsk: asks[0]?.price ?? null };
  };
  const { dexDepthHistory, ...rest } = s;
  return {
    ...rest,
    dexDepth: mapValues(s.dexDepth, book),
    ...(dexDepthHistory ? { dexDepthHistory: mapValues(dexDepthHistory, (xs) => xs.map(book)) } : {}),
  };
}

/** The snapshot an archived one was made from. Throws when a book is missing. */
export function restoreSnapshot(a: ArchivedSnapshot, books: Books): PoolSnapshot {
  const book = <T extends DexDepth>({ asksHash, levels: _levels, bestAsk: _bestAsk, ...rest }: ArchivedBook<T>): T => {
    const asks = books[asksHash];
    if (!asks) throw new Error(`book ${asksHash.slice(0, 12)}… is not in the archive`);
    return { ...rest, asks } as unknown as T;
  };
  const { dexDepthHistory, ...rest } = a;
  return {
    ...rest,
    dexDepth: mapValues(a.dexDepth, (x) => book<DexDepth>(x)),
    ...(dexDepthHistory ? { dexDepthHistory: mapValues(dexDepthHistory, (xs) => xs.map((x) => book<DexDepthSample>(x))) } : {}),
  };
}

/** A run without its books (stored on their own), and the books. */
export function splitBooks<R extends ArchivedRun>(run: R): { run: Omit<R, "books">; books: Books } {
  const { books, ...lean } = run;
  return { run: lean, books: books ?? {} };
}

export interface RatingCheck {
  poolId: string;
  name: string;
  protocol: "blend" | "defindex";
  reasonsHash: string;
  /** The published reasonsHash, recomputed from the archived input and the rating's own factors, rules and score. */
  inputsHash: boolean;
  /** This checkout's engine, run on the archived input, gives the same reasonsHash (null: not run). */
  rerun: boolean | null;
  note: string;
}

export interface RunCheck {
  engineVersion: string;
  computedAt: number;
  ok: boolean;
  /** Why nothing could be checked. */
  error?: string;
  results: RatingCheck[];
}

/** What differs between a published rating and the re-rated one. */
function diff(published: PoolRating, fresh: PoolRating): string {
  const out: string[] = [];
  for (const k of ["score", "grade", "eligibleForDeposit"] as const) {
    if (published[k] !== fresh[k]) out.push(`${k} ${published[k]} → ${fresh[k]}`);
  }
  for (const f of fresh.factors) {
    const p = published.factors.find((x) => x.key === f.key);
    if (!p || sha256Canonical(p) !== sha256Canonical(f)) out.push(`${f.key} ${p?.value ?? "—"} → ${f.value}`);
  }
  if (sha256Canonical(published.hardRules) !== sha256Canonical(fresh.hardRules)) out.push(`hard rules: ${fresh.hardRules.join("; ") || "none"}`);
  return out.length ? `re-rate differs: ${out.join("; ")}` : "re-rate differs in its inputs only";
}

function noteFor(inputsHash: boolean, rerun: boolean, published: PoolRating, fresh: PoolRating): string {
  if (inputsHash && rerun) return "";
  // Same hash on a re-rate but not from the published fields: the fields were changed after hashing.
  return `${rerun ? "the published rating does not match its own reasonsHash; " : ""}${diff(published, fresh)}`;
}

export function verifyRun(run: ArchivedRun): RunCheck {
  const head = { engineVersion: run.engineVersion, computedAt: run.computedAt };
  if (!run.books || !run.inputs) {
    return { ...head, ok: false, results: [], error: "this run predates the full archive (2026-11-02): its order books were not kept, so its hashes cannot be recomputed" };
  }
  const books = run.books;
  const sameEngine = run.engineVersion === ENGINE_VERSION;
  const otherEngine = `rated by ${run.engineVersion}; this checkout runs ${ENGINE_VERSION}, so the re-rate was skipped (check out the commit that ships ${run.engineVersion})`;
  const snapshots: Record<string, PoolSnapshot> = {};
  const fresh: Record<string, PoolRating> = {};
  const blend = Object.fromEntries(run.ratings.filter((r) => r.protocol === "blend").map((r) => [r.poolId, r]));

  const results = run.ratings.map((r): RatingCheck => {
    const base = { poolId: r.poolId, name: r.name, protocol: r.protocol, reasonsHash: r.reasonsHash };
    if (r.protocol === "blend") {
      const archived = run.inputs![r.poolId];
      if (!archived) return { ...base, inputsHash: false, rerun: null, note: "no archived input for this pool" };
      let s: PoolSnapshot;
      try {
        s = restoreSnapshot(archived, books);
      } catch (e) {
        return { ...base, inputsHash: false, rerun: null, note: (e as Error).message };
      }
      snapshots[r.poolId] = s;
      const inputsHash =
        sha256Canonical({
          engineVersion: run.engineVersion,
          inputs: hashInputs(s),
          factors: r.factors,
          hardRules: r.hardRules,
          score: r.score,
          uncappedScore: r.uncappedScore ?? null,
          grade: r.grade,
          eligibleForDeposit: r.eligibleForDeposit,
        }) === r.reasonsHash;
      if (!sameEngine) return { ...base, inputsHash, rerun: null, note: otherEngine };
      const again = ratePool(s, { now: r.computedAt });
      fresh[r.poolId] = again;
      const rerun = again.reasonsHash === r.reasonsHash;
      return { ...base, inputsHash, rerun, note: noteFor(inputsHash, rerun, r, again) };
    }

    const input = run.strategies?.find((x) => x.strategyId === r.poolId);
    if (!input) return { ...base, inputsHash: false, rerun: null, note: "no archived input for this strategy" };
    const poolId = input.onchainPoolId || input.blendPoolId;
    const underlying = blend[poolId];
    const inputsHash =
      sha256Canonical({
        engineVersion: run.engineVersion,
        inputs: { strategyId: input.strategyId, poolId, asset: input.onchainAssetId || input.assetContractId, underlyingHashes: underlying ? [underlying.reasonsHash] : [] },
        factors: r.factors,
        hardRules: r.hardRules,
        score: r.score,
        grade: r.grade,
        eligibleForDeposit: r.eligibleForDeposit,
      }) === r.reasonsHash;
    if (!sameEngine) return { ...base, inputsHash, rerun: null, note: otherEngine };
    if (underlying && !fresh[poolId]) return { ...base, inputsHash, rerun: null, note: "the underlying pool could not be re-rated" };
    const again = rateDefindexStrategy(input, fresh, snapshots, r.computedAt);
    const rerun = again.reasonsHash === r.reasonsHash;
    return { ...base, inputsHash, rerun, note: noteFor(inputsHash, rerun, r, again) };
  });
  return { ...head, ok: results.length > 0 && results.every((x) => x.inputsHash && x.rerun !== false), results };
}
