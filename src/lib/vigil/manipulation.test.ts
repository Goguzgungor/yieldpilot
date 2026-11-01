import { describe, expect, it } from "vitest";
import { assessManipulation, roundsToHold, sweepCost, type ManipulationInput } from "./manipulation";
import { depth } from "./testkit";

const base = (o: Partial<ManipulationInput> = {}): ManipulationInput => ({
  priceUsd: 1,
  cFactor: 0.9,
  capHeadroomTokens: null,
  availableUsd: 10_000_000,
  avgLFactor: 0.9,
  depth: depth("A", [[1.01, 5]]),
  maxDevPct: 10,
  resolutionSec: 300,
  ...o,
});

describe("sweepCost", () => {
  it("sums asks at or below the target and reports whether the visible book ran out", () => {
    const asks = [
      { price: 1, amount: 10 },
      { price: 2, amount: 5 },
      { price: 5, amount: 1 },
    ];
    expect(sweepCost(asks, 2)).toEqual({ costUsd: 20, tokens: 15, exhausted: false });
    expect(sweepCost(asks, 10)).toEqual({ costUsd: 25, tokens: 16, exhausted: true });
    expect(sweepCost(asks, 0.5)).toEqual({ costUsd: 0, tokens: 0, exhausted: false });
    expect(sweepCost([], 1).exhausted).toBe(true);
  });
});

describe("roundsToHold (aggregator max_dev semantics)", () => {
  it("needs two consecutive rounds when 0 < max_dev < 100, else one", () => {
    expect(roundsToHold(10)).toBe(2);
    expect(roundsToHold(1)).toBe(2);
    expect(roundsToHold(0)).toBe(1);
    expect(roundsToHold(100)).toBe(1);
    expect(roundsToHold(undefined)).toBe(1);
  });
});

describe("assessManipulation", () => {
  it("flags a thin book that can be pumped for pennies (YieldBlox shape)", () => {
    const r = assessManipulation(base());
    expect(r.profitable).toBe(true);
    expect(r.multiplier).toBe(100);
    expect(r.rho).toBeLessThan(0.02);
    expect(r.extractableUsd).toBe(10_000_000);
    expect(r.roundsToHold).toBe(2);
    expect(r.minHoldSeconds).toBe(600);
  });

  it("does not flag a book whose depth dwarfs the borrowable liquidity", () => {
    // $50M of asks at +5%, nothing visible above (book not truncated ⇒ exact)
    const r = assessManipulation(base({ availableUsd: 1_000_000, depth: depth("A", [[1.05, 50_000_000]]) }));
    expect(r.profitable).toBe(false);
    expect(r.rho).toBeGreaterThan(1);
  });

  it("supply-cap headroom bounds what can be extracted", () => {
    const r = assessManipulation(base({ capHeadroomTokens: 1_000 }));
    // 1,000 tokens × $1 × 100 × 0.9 × 0.9 = $81,000
    expect(r.extractableUsd).toBeCloseTo(81_000, 6);
  });

  it("returns null rho when nothing is extractable or leverage can never exceed 1", () => {
    expect(assessManipulation(base({ availableUsd: 0 })).rho).toBeNull();
    expect(assessManipulation(base({ cFactor: 0 })).rho).toBeNull();
    expect(assessManipulation(base({ cFactor: 0.001, avgLFactor: 0.5 })).rho).toBeNull(); // 100×0.001×0.5 < 1
  });

  it("marks the cost as a lower bound when a truncated book runs out below target", () => {
    const r = assessManipulation(base({ depth: depth("A", [[1.01, 5]], true) }));
    expect(r.costIsLowerBound).toBe(true);
  });

  it("prefers a certain profitable attack over a cheaper-looking lower-bound one", () => {
    // Exact at ×1.5 (an ask above it exists); at ×100 the truncated book runs out (lower bound).
    const d = depth("A", [[1.01, 1], [2, 1]], true);
    const r = assessManipulation(base({ depth: d }));
    expect(r.costIsLowerBound).toBe(false);
    expect(r.profitable).toBe(true);
  });

  it("book replenishment raises cost only when max_dev forces a second round", () => {
    const d = depth("A", [[1.01, 1_000_000]]);
    const p = { multipliers: [2], replenishmentPerRound: 1 };
    const withDev = assessManipulation(base({ depth: d, maxDevPct: 10 }), p);
    const noDev = assessManipulation(base({ depth: d, maxDevPct: 0 }), p);
    expect(withDev.manipulationCostUsd).toBeCloseTo(2 * noDev.manipulationCostUsd, 6);
  });
});
