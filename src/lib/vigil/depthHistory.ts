/**
 * Rolling-window SDEX depth (v2.3): every live run stores the order books it
 * read, and the next runs rate manipulation on the thinnest book of the last
 * THRESHOLDS.depthWindowSec instead of a single read. Pure helpers; the caller
 * owns the storage (DB KV on the server, a JSON file for the CLI).
 */
import { DEFAULT_MANIPULATION_PARAMS } from "./manipulation";
import { THRESHOLDS } from "./score";
import type { DexDepth, DexDepthSample, PoolSnapshot } from "./types";

export type DepthHistory = Record<string, DexDepthSample[]>;

export interface DepthHistoryStore {
  load(): Promise<DepthHistory>;
  save(history: DepthHistory): Promise<void>;
}

/** At most one stored book per asset per this many seconds (the publisher runs every 30 minutes). */
export const MIN_SAMPLE_SPACING_SEC = 50 * 60;

/**
 * A book as stored: levels past the largest multiplier the model tries are
 * dropped, except the first one, so a sweep to that price still sees the book
 * continue (it is not mistaken for an exhausted book).
 */
export function toSample(depth: DexDepth, sampledAt: number, refPriceUsd: number): DexDepthSample {
  const top = refPriceUsd * Math.max(...DEFAULT_MANIPULATION_PARAMS.multipliers);
  const cut = depth.asks.findIndex((a) => a.price > top);
  const asks = cut < 0 ? depth.asks : depth.asks.slice(0, cut + 1);
  return { ...depth, asks, sampledAt, refPriceUsd };
}

/** The current snapshot's books as samples (one per asset, priced by this pool's oracle). */
export function samplesOf(s: PoolSnapshot): DexDepthSample[] {
  const out: DexDepthSample[] = [];
  for (const [assetId, depth] of Object.entries(s.dexDepth)) {
    const price = s.reserves.find((r) => r.assetId === assetId)?.priceUsd;
    if (price && price > 0) out.push(toSample(depth, s.asOf.timestamp, price));
  }
  return out;
}

/** Keep the window, add each new sample unless the asset was sampled less than the spacing ago. */
export function mergeDepthHistory(
  past: DepthHistory,
  fresh: DexDepthSample[],
  nowSec: number,
  opts: { windowSec?: number; spacingSec?: number } = {},
): DepthHistory {
  const windowSec = opts.windowSec ?? THRESHOLDS.depthWindowSec;
  const spacingSec = opts.spacingSec ?? MIN_SAMPLE_SPACING_SEC;
  const out: DepthHistory = {};
  for (const [assetId, xs] of Object.entries(past)) {
    const kept = xs.filter((x) => x.sampledAt >= nowSec - windowSec && x.sampledAt <= nowSec);
    if (kept.length) out[assetId] = kept.sort((a, b) => a.sampledAt - b.sampledAt);
  }
  for (const x of fresh) {
    const xs = (out[x.assetId] ??= []);
    const last = xs[xs.length - 1];
    if (!last || x.sampledAt - last.sampledAt >= spacingSec) xs.push(x);
  }
  return out;
}

/** The part of the history a snapshot's assets need. */
export function historyFor(s: PoolSnapshot, history: DepthHistory): DepthHistory | undefined {
  const ids = s.reserves.map((r) => r.assetId).filter((id) => history[id]?.length);
  return ids.length ? Object.fromEntries(ids.map((id) => [id, history[id]])) : undefined;
}
