import { describe, expect, it } from "vitest";
import { ENGINE_VERSION, HARD_CAPS, ratePool, softCeiling, WEIGHTS } from "./score";
import { backstop, cid, healthyPool, reserve, src } from "./testkit";

// v2.1: the grade answers "how safe is it to supply here?"; Blend's pool state
// is reported next to it (and decides whether deposits are possible) instead of
// flattening every non-active pool to the same 49. Since v2.3 a backstop that
// covers under 1% of the borrows is HR9 (at most C, score-v23.test.ts); these
// cases keep a backstop under Blend's threshold that still covers ~17%, so
// HR7's "at most B" is the ceiling that applies.
const uninsured = backstop({ usdc: 50_000, blnd: 100_000, meetsThreshold: false });

describe("v2.1 scoring", () => {
  it("weights still sum to 1, with no pool_status factor", () => {
    expect(ENGINE_VERSION).toMatch(/^vigil-risk-v2\.[1234]\./);
    expect("pool_status" in WEIGHTS).toBe(false);
    expect(Object.values(WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it("an on-ice pool keeps its own grade (no flattening) and still accepts deposits", () => {
    const r = ratePool(healthyPool({ poolId: cid("onice"), status: 3, backstop: uninsured }));
    expect(r.factors.some((f) => f.key === "pool_status")).toBe(false);
    expect(r.grade).toBe("B");
    expect(r.score).toBeLessThanOrEqual(HARD_CAPS.uninsured);
    expect(r.hardRules.some((h) => h.startsWith("HR7"))).toBe(true);
    expect(r.hardRules.some((h) => h.startsWith("HR1"))).toBe(false);
    expect(r.eligibleForDeposit).toBe(true);
  });

  it("an uninsured pool can be B but never A", () => {
    const r = ratePool(healthyPool({ poolId: cid("noins"), backstop: uninsured }));
    expect(r.score).toBeLessThanOrEqual(HARD_CAPS.uninsured);
    expect(r.grade).toBe("B");
  });

  it("frozen pools are graded on their merits but marked as not accepting deposits", () => {
    for (const status of [4, 5]) {
      const r = ratePool(healthyPool({ poolId: cid(`closed${status}`), status }));
      expect(r.grade).toBe("A"); // insured, robust prices: the setup itself is sound
      expect(r.eligibleForDeposit).toBe(false);
      expect(r.hardRules.some((h) => h.startsWith("HR1"))).toBe(true);
    }
  });

  it("different pools in the same state no longer collapse to the same score", () => {
    const good = ratePool(healthyPool({ poolId: cid("g"), status: 3, backstop: uninsured }));
    const weak = ratePool(
      healthyPool({
        poolId: cid("w"),
        status: 3,
        backstop: uninsured,
        reserves: [
          reserve("USDC", { source: src("base"), supplied: 2_000_000, borrowed: 900_000 }),
          reserve("CETES", { priceUsd: 0.06, supplied: 5_000_000, borrowed: 0, cFactor: 0.8, lFactor: 0, source: src("issuer_push") }),
        ],
      }),
    );
    expect(good.score!).toBeGreaterThan(weak.score!);
  });

  it("the uninsured / weak-feed ceiling is soft: it squeezes B..A into B instead of flattening everyone to 79", () => {
    const strong = ratePool(healthyPool({ poolId: cid("s1"), backstop: uninsured }));
    const weaker = ratePool(
      healthyPool({
        poolId: cid("s2"),
        backstop: uninsured,
        reserves: [
          // ~78% pool utilization: same setup, more borrowing pressure (USDC under its max_util, so HR10 stays out of it)
          reserve("USDC", { source: src("base"), supplied: 2_000_000, borrowed: 1_900_000, cFactor: 0.95, lFactor: 0.95, maxUtil: 0.97 }),
          reserve("XLM", { priceUsd: 0.2, supplied: 10_000_000, borrowed: 6_000_000, cFactor: 0.75, lFactor: 0.75, maxUtil: 0.7 }),
        ],
      }),
    );
    expect(strong.grade).toBe("B");
    expect(weaker.grade).toBe("B");
    expect(strong.score).toBeLessThanOrEqual(79);
    expect(strong.score!).toBeGreaterThan(weaker.score!); // order survives the ceiling
    expect(strong.uncappedScore! - weaker.uncappedScore!).toBeGreaterThan(0);
  });

  it("the squeeze is monotone and leaves scores at or below 65 alone", () => {
    for (const [u, want] of [[100, 79], [65, 65], [60, 60]] as const) {
      expect(softCeiling(u)).toBe(want);
    }
    let prev = -1;
    for (let u = 0; u <= 100; u++) {
      const v = softCeiling(u);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});
