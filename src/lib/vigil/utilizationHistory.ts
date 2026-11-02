/**
 * HR10's window (v2.5): every live run stores each reserve's supply and
 * borrows, and the next runs keep a pool locked while any read of the last
 * THRESHOLDS.lockWindowSec had a reserve at or past its max_util. Pure
 * helpers; the caller owns the storage (DB KV on the server, a JSON file for
 * the CLI), as for the depth history.
 */
import { THRESHOLDS } from "./score";
import type { PoolSnapshot, UtilizationSample } from "./types";

/** poolId → assetId → reads, oldest first. */
export type UtilizationHistory = Record<string, Record<string, UtilizationSample[]>>;

export interface UtilizationHistoryStore {
  load(): Promise<UtilizationHistory>;
  save(history: UtilizationHistory): Promise<void>;
}

/** This snapshot's read of each reserve, keyed by assetId. */
export function utilizationSamplesOf(s: PoolSnapshot): Record<string, UtilizationSample> {
  return Object.fromEntries(
    s.reserves.map((r) => [r.assetId, { sampledAt: s.asOf.timestamp, supplied: r.supplied, borrowed: r.borrowed, maxUtil: r.maxUtil, priceUsd: r.priceUsd }]),
  );
}

/** Keep the window, and add each snapshot's reads unless that read is already stored. */
export function mergeUtilizationHistory(
  past: UtilizationHistory,
  snapshots: PoolSnapshot[],
  nowSec: number,
  windowSec: number = THRESHOLDS.lockWindowSec,
): UtilizationHistory {
  const out: UtilizationHistory = {};
  for (const [poolId, byAsset] of Object.entries(past)) {
    for (const [assetId, xs] of Object.entries(byAsset)) {
      const kept = xs.filter((x) => x.sampledAt >= nowSec - windowSec && x.sampledAt <= nowSec);
      if (kept.length) (out[poolId] ??= {})[assetId] = kept.sort((a, b) => a.sampledAt - b.sampledAt);
    }
  }
  for (const s of snapshots) {
    for (const [assetId, x] of Object.entries(utilizationSamplesOf(s))) {
      const xs = ((out[s.poolId] ??= {})[assetId] ??= []);
      if (!xs.some((y) => y.sampledAt === x.sampledAt)) xs.push(x);
    }
  }
  return out;
}

/** The pool's part of the history. */
export function utilizationHistoryFor(s: PoolSnapshot, history: UtilizationHistory): Record<string, UtilizationSample[]> | undefined {
  const own = history[s.poolId];
  return own && Object.keys(own).length ? own : undefined;
}

/** The reads of a run's archived inputs: each pool's reserves at its snapshot's chain time. */
interface ArchivedReads {
  inputs?: Record<string, { asOf: { timestamp: number }; reserves: ({ assetId: string } & Omit<UtilizationSample, "sampledAt">)[] }>;
}

/**
 * The window rebuilt from archived runs, for a store that is empty (a first
 * deploy, or a lost KV entry): every published run's inputs carry the reads.
 */
export function utilizationHistoryFromRuns(runs: ArchivedReads[], nowSec: number, windowSec: number = THRESHOLDS.lockWindowSec): UtilizationHistory {
  const out: UtilizationHistory = {};
  for (const run of runs) {
    for (const [poolId, s] of Object.entries(run.inputs ?? {})) {
      const at = s.asOf.timestamp;
      for (const r of s.reserves) {
        const xs = ((out[poolId] ??= {})[r.assetId] ??= []);
        if (!xs.some((y) => y.sampledAt === at)) xs.push({ sampledAt: at, supplied: r.supplied, borrowed: r.borrowed, maxUtil: r.maxUtil, priceUsd: r.priceUsd });
      }
    }
  }
  return mergeUtilizationHistory(out, [], nowSec, windowSec);
}
