import { describe, expect, it } from "vitest";
import { ENGINE_VERSION, HARD_CAPS, ratePool, THRESHOLDS } from "./score";
import { cid, healthyPool, reserve, src, T0 } from "./testkit";
import type { PoolSnapshot, UtilizationSample } from "./types";
import { mergeUtilizationHistory, utilizationHistoryFor, utilizationHistoryFromRuns, utilizationSamplesOf } from "./utilizationHistory";
import { pathsToGrades } from "./whatif";

// v2.5 (after the v6 reviews of 2026-11-02): HR10 flipped run by run. Fixed
// v2.1's USDC was 96.1% borrowed at 13:50 UTC (C 64, not eligible) and 89.94%
// at 14:32 after a ~$3K deposit (B 75, eligible). A reserve that reached its
// max_util in any read of the last 6 h now keeps the pool locked.
const usdc = (borrowed: number, o: Partial<Parameters<typeof reserve>[1]> = {}) =>
  reserve("USDC", { source: src("base"), supplied: 46_636, borrowed, cFactor: 0.95, lFactor: 0.95, maxUtil: 0.9, ...o });
const pool = (o: Partial<PoolSnapshot> = {}): PoolSnapshot =>
  healthyPool({
    poolId: cid("hovering"),
    reserves: [usdc(41_944), reserve("XLM", { priceUsd: 0.2, supplied: 10_000_000, borrowed: 1_000_000, cFactor: 0.75, lFactor: 0.75, maxUtil: 0.7 })],
    ...o,
  });
const usdcId = pool().reserves[0].assetId;
const sample = (hoursAgo: number, supplied: number, borrowed: number, o: Partial<UtilizationSample> = {}): UtilizationSample => ({
  sampledAt: T0 - hoursAgo * 3600,
  supplied,
  borrowed,
  maxUtil: 0.9,
  priceUsd: 1,
  ...o,
});

describe("v2.5 scoring", () => {
  it("is versioned", () => {
    expect(ENGINE_VERSION).toBe("vigil-risk-v2.5.0");
  });
});

describe("v2.5 HR10 over a 6 h window", () => {
  it("under max_util now (89.94%) with no history: no HR10", () => {
    const r = ratePool(pool());
    expect(r.hardRules.some((h) => h.startsWith("HR10"))).toBe(false);
    expect(r.eligibleForDeposit).toBe(true);
  });

  it("past max_util 40 minutes ago keeps the pool locked, and says when", () => {
    const r = ratePool(pool({ utilizationHistory: { [usdcId]: [sample(0.7, 43_626, 41_939)] } }));
    expect(r.eligibleForDeposit).toBe(false);
    expect(r.score).toBeLessThanOrEqual(HARD_CAPS.lendersLockedIn);
    const hr = r.hardRules.find((h) => h.startsWith("HR10"))!;
    expect(hr).toMatch(/^HR10 USDC is 89\.9% borrowed, under its 90\.0% max_util now, but was 96\.1% borrowed at \d\d:\d\d UTC, within 6 h: \$4\.7K of \$46\.6K can be withdrawn ⇒ not eligible, grade ≤ C$/);
  });

  it("a read older than 6 h no longer counts", () => {
    const r = ratePool(pool({ utilizationHistory: { [usdcId]: [sample(6.1, 43_626, 41_939)] } }));
    expect(r.hardRules.some((h) => h.startsWith("HR10"))).toBe(false);
    expect(THRESHOLDS.lockWindowSec).toBe(6 * 3600);
  });

  it("dust in the history does not count", () => {
    const r = ratePool(pool({ utilizationHistory: { [usdcId]: [sample(1, 900, 899)] } }));
    expect(r.hardRules.some((h) => h.startsWith("HR10"))).toBe(false);
  });

  it("the history is part of the inputs hash", () => {
    const a = ratePool(pool());
    const b = ratePool(pool({ utilizationHistory: { [usdcId]: [sample(1, 46_000, 10_000)] } }));
    expect(a.score).toBe(b.score);
    expect(a.reasonsHash).not.toBe(b.reasonsHash);
  });

  it("the grade path names the wait", () => {
    const p = pathsToGrades(pool({ utilizationHistory: { [usdcId]: [sample(0.7, 43_626, 41_939)] } }));
    expect(p.B.reachable).toBe(false);
    expect(p.B.blocker).toMatch(/within 6 h/);
  });
});

describe("utilization history store helpers", () => {
  const s = pool();
  it("samplesOf takes every reserve's read at the snapshot's chain time", () => {
    const xs = utilizationSamplesOf(s);
    expect(xs[usdcId]).toEqual({ sampledAt: T0, supplied: 46_636, borrowed: 41_944, maxUtil: 0.9, priceUsd: 1 });
  });

  it("merge keeps 6 h per pool and asset, adds this run, and drops a duplicate read", () => {
    const old = sample(7, 1, 1);
    const recent = sample(2, 2, 1);
    const merged = mergeUtilizationHistory({ [s.poolId]: { [usdcId]: [old, recent] } }, [s], T0);
    expect(merged[s.poolId][usdcId].map((x) => x.sampledAt)).toEqual([recent.sampledAt, T0]);
    expect(mergeUtilizationHistory(merged, [s], T0)[s.poolId][usdcId]).toHaveLength(2);
  });

  it("historyFor returns the pool's own part, or nothing", () => {
    const h = { [s.poolId]: { [usdcId]: [sample(1, 1, 1)] }, other: { x: [sample(1, 1, 1)] } };
    expect(utilizationHistoryFor(s, h)).toEqual(h[s.poolId]);
    expect(utilizationHistoryFor(s, {})).toBeUndefined();
  });

  it("is rebuilt from archived runs when the store is empty, keeping only the window", () => {
    const run = (at: number, borrowed: number) => ({
      inputs: { [s.poolId]: { asOf: { timestamp: at }, reserves: [{ assetId: usdcId, supplied: 43_626, borrowed, maxUtil: 0.9, priceUsd: 1 }] } },
    });
    const h = utilizationHistoryFromRuns([run(T0 - 8 * 3600, 1), run(T0 - 3600, 41_939), run(T0 - 1800, 40_000)], T0);
    expect(h[s.poolId][usdcId].map((x) => [x.sampledAt, x.borrowed])).toEqual([
      [T0 - 3600, 41_939],
      [T0 - 1800, 40_000],
    ]);
  });
});
