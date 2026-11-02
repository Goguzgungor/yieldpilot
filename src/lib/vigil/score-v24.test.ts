import { describe, expect, it } from "vitest";
import { ENGINE_VERSION, HARD_CAPS, ratePool } from "./score";
import { cid, healthyPool, reserve, src } from "./testkit";
import type { PoolSnapshot } from "./types";
import { pathsToGrades } from "./whatif";

// v2.4 (after the v5 blind reviews of 2026-11-02): a pool whose lenders cannot
// get out is not a pool to deposit into. Fixed v2.1's USDC was 95.5% borrowed
// against its own 90% max_util ($1,988 withdrawable) and still graded B 74,
// because utilization is one factor of seven.
const locked = (o: Partial<PoolSnapshot> = {}): PoolSnapshot =>
  healthyPool({
    poolId: cid("locked"),
    reserves: [
      reserve("USDC", { source: src("base"), supplied: 43_626, borrowed: 41_939, cFactor: 0.95, lFactor: 0.95, maxUtil: 0.9 }),
      reserve("XLM", { priceUsd: 0.2, supplied: 10_000_000, borrowed: 1_000_000, cFactor: 0.75, lFactor: 0.75, maxUtil: 0.7 }),
    ],
    ...o,
  });

describe("v2.4 scoring", () => {
  it("is versioned", () => {
    expect(ENGINE_VERSION).toMatch(/^vigil-risk-v2\.[45]\./);
  });
});

describe("v2.4 HR10: lenders locked in", () => {
  it("a reserve borrowed past its max_util makes the pool not eligible, grade at most C, and says what can be withdrawn", () => {
    const r = ratePool(locked());
    expect(r.eligibleForDeposit).toBe(false);
    expect(r.score).toBeLessThanOrEqual(HARD_CAPS.lendersLockedIn);
    expect(r.grade).toBe("C");
    expect(r.uncappedScore!).toBeGreaterThan(HARD_CAPS.lendersLockedIn);
    expect(r.hardRules.find((h) => h.startsWith("HR10"))).toMatch(/USDC is 96\.1% borrowed, past its 90\.0% max_util: \$1\.7K of \$43\.6K can be withdrawn ⇒ not eligible, grade ≤ C/);
  });

  it("at exactly max_util the rule holds; under it, it does not", () => {
    const at = (borrowed: number) =>
      ratePool(locked({ reserves: [reserve("USDC", { source: src("base"), supplied: 100_000, borrowed, cFactor: 0.95, lFactor: 0.95, maxUtil: 0.9 })] }));
    expect(at(90_000).hardRules.some((h) => h.startsWith("HR10"))).toBe(true);
    expect(at(89_999).hardRules.some((h) => h.startsWith("HR10"))).toBe(false);
  });

  it("dust does not count: a reserve under $1K supplied is ignored", () => {
    const r = ratePool(
      healthyPool({
        poolId: cid("dust"),
        reserves: [...healthyPool().reserves, reserve("EURC2", { priceUsd: 1.1, supplied: 800, borrowed: 790, maxUtil: 0.9 })],
      }),
    );
    expect(r.hardRules.some((h) => h.startsWith("HR10"))).toBe(false);
    expect(r.eligibleForDeposit).toBe(true);
  });

  it("names every locked reserve it can price, and a lower cap from another rule still wins", () => {
    const r = ratePool(
      locked({
        reserves: [
          reserve("USDC", { source: src("base"), supplied: 50_000, borrowed: 49_000, maxUtil: 0.9 }),
          reserve("XLM", { priceUsd: 0.2, supplied: 100_000, borrowed: 75_000, cFactor: 0.75, maxUtil: 0.7 }),
          reserve("EURC", { supplied: 20_000, borrowed: 19_000, maxUtil: 0.9, priceTimestamp: null, priceUsd: null }),
        ],
      }),
    );
    // EURC has no price, so its supply cannot be measured; HR2 caps the pool at D.
    expect(r.grade).toBe("D");
    expect(r.hardRules.find((h) => h.startsWith("HR10"))).toMatch(/^HR10 USDC is 98\.0% borrowed, .*; XLM is 75\.0% borrowed, past its 70\.0% max_util: \$5\.0K of \$20\.0K can be withdrawn ⇒/);
  });

  it("the grade paths say borrowers have to repay or lenders add supply, not a protocol lever", () => {
    const p = pathsToGrades(locked());
    expect(p.B.reachable).toBe(false);
    expect(p.B.blocker).toMatch(/USDC is 96\.1% borrowed, past its 90\.0% max_util/);
  });
});
