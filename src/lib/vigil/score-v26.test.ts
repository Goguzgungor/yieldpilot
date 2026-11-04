import { describe, expect, it } from "vitest";
import { derive, ENGINE_VERSION, HARD_CAPS, ratePool, THRESHOLDS, utilizationFactor, WEIGHTS } from "./score";
import { backstop, cid, healthyPool, reserve, src, T0 } from "./testkit";
import type { PoolSnapshot } from "./types";

// v2.6 (2026-11-04): liquidity is read in dollars as well as a ratio, the
// backstop weighs less, and a pool without first-loss capital is at most B.
// Fixed (V2) held $166M with ~$11.7M of its USDC withdrawable, yet stayed
// C 57 under v2.5: no pool passed the RiskGate minimum of 60.
const empty = backstop({ usdc: 0, blnd: 0, meetsThreshold: false });

const usdcOnly = (supplied: number, borrowed: number, maxUtil = 0.95) =>
  derive(healthyPool({ reserves: [reserve("USDC", { source: src("base"), supplied, borrowed, maxUtil })] }));

/** Fixed (V2) as read on 2026-11-03: USDC $51.1M 77.1% borrowed, XLM $114.9M, no backstop, On_Ice. */
const fixedLike = (o: Partial<PoolSnapshot> = {}): PoolSnapshot =>
  healthyPool({
    poolId: cid("fixed-v2"),
    name: "Fixed",
    status: 3,
    backstop: empty,
    reserves: [
      reserve("USDC", { source: src("base"), supplied: 51_122_180, borrowed: 39_415_000, cFactor: 0.95, lFactor: 0.95, maxUtil: 0.95 }),
      reserve("XLM", {
        priceUsd: 0.3,
        supplied: 383_000_000,
        borrowed: 3_000_000,
        cFactor: 0.75,
        lFactor: 0.75,
        maxUtil: 0.7,
        source: src("reflector_cex", { maxDevPct: 60 }),
      }),
      reserve("EURC", { priceUsd: 1.15, supplied: 112_000, borrowed: 50_000 }),
    ],
    ...o,
  });

describe("v2.6 scoring", () => {
  it("is versioned", () => {
    expect(ENGINE_VERSION).toBe("vigil-risk-v2.6.0");
  });

  it("weighs the backstop less and liquidity more", () => {
    expect(WEIGHTS.backstop_coverage).toBe(0.06);
    expect(WEIGHTS.utilization).toBe(0.24);
    expect(Object.values(WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });
});

describe("v2.6 liquidity: the ratio or the dollars, whichever is better", () => {
  it("a deep reserve 99% borrowed still has $1.5M to withdraw: full marks", () => {
    const f = utilizationFactor(usdcOnly(150_000_000, 148_500_000));
    expect(f.value).toBe(100);
    expect(f.note).toMatch(/USDC 99\.0% borrowed, \$1\.50M withdrawable/);
  });

  it("depth scores 0 at $10K withdrawable and 100 at $1M, log-linear between", () => {
    expect(THRESHOLDS.liquidityZeroUsd).toBe(10_000);
    expect(THRESHOLDS.liquidityFullUsd).toBe(1_000_000);
    // 95% borrowed scores 0 on the ratio, so the dollars decide
    expect(utilizationFactor(usdcOnly(200_000, 190_000)).value).toBe(0); // $10K
    expect(utilizationFactor(usdcOnly(2_000_000, 1_900_000)).value).toBeCloseTo(50, 6); // $100K
    expect(utilizationFactor(usdcOnly(20_000_000, 19_000_000)).value).toBe(100); // $1M
  });

  it("a small reserve keeps the ratio rule", () => {
    expect(utilizationFactor(usdcOnly(100_000, 50_000)).value).toBe(100);
    expect(utilizationFactor(usdcOnly(100_000, 77_500)).value).toBeCloseTo(50, 6);
  });

  it("the weakest reserve with material supply sets the pool's liquidity", () => {
    const d = derive(
      healthyPool({
        reserves: [
          reserve("USDC", { source: src("base"), supplied: 150_000_000, borrowed: 148_500_000, maxUtil: 0.99 }),
          reserve("EURC", { priceUsd: 1, supplied: 100_000, borrowed: 95_000 }),
          reserve("DUST", { priceUsd: 1, supplied: 900, borrowed: 899 }),
        ],
      }),
    );
    const f = utilizationFactor(d);
    expect(f.value).toBe(0);
    expect(f.note).toMatch(/^weakest reserve EURC 95\.0% borrowed, \$5\.0K withdrawable/);
  });
});

describe("v2.6 HR10: a reserve at max_util locks lenders in only when little can be withdrawn", () => {
  it("$150M at max_util with $1.5M withdrawable: no HR10, still eligible", () => {
    const r = ratePool(
      healthyPool({
        poolId: cid("deep-at-max"),
        reserves: [
          reserve("USDC", { source: src("base"), supplied: 150_000_000, borrowed: 148_500_000, cFactor: 0.95, lFactor: 0.95, maxUtil: 0.95 }),
          reserve("XLM", { priceUsd: 0.2, supplied: 10_000_000, borrowed: 1_000_000, cFactor: 0.75, lFactor: 0.75, maxUtil: 0.7 }),
        ],
      }),
    );
    expect(THRESHOLDS.lockedInMinWithdrawableUsd).toBe(1_000_000);
    expect(r.hardRules.some((h) => h.startsWith("HR10"))).toBe(false);
    expect(r.eligibleForDeposit).toBe(true);
  });

  it("$10M at max_util with $500K withdrawable: HR10 holds", () => {
    const r = ratePool(
      healthyPool({
        poolId: cid("mid-at-max"),
        reserves: [
          reserve("USDC", { source: src("base"), supplied: 10_000_000, borrowed: 9_500_000, cFactor: 0.95, lFactor: 0.95, maxUtil: 0.9 }),
          reserve("XLM", { priceUsd: 0.2, supplied: 10_000_000, borrowed: 1_000_000, cFactor: 0.75, lFactor: 0.75, maxUtil: 0.7 }),
        ],
      }),
    );
    expect(r.hardRules.find((h) => h.startsWith("HR10"))).toMatch(/\$500\.0K of \$10\.00M can be withdrawn/);
    expect(r.eligibleForDeposit).toBe(false);
  });

  it("a deep read at max_util in the 6 h window does not count either", () => {
    const s = healthyPool({
      poolId: cid("deep-history"),
      reserves: [
        reserve("USDC", { source: src("base"), supplied: 150_000_000, borrowed: 100_000_000, cFactor: 0.95, lFactor: 0.95, maxUtil: 0.95 }),
      ],
    });
    const usdcId = s.reserves[0].assetId;
    s.utilizationHistory = {
      [usdcId]: [{ sampledAt: T0 - 3600, supplied: 150_000_000, borrowed: 148_500_000, maxUtil: 0.95, priceUsd: 1 }],
    };
    expect(ratePool(s).hardRules.some((h) => h.startsWith("HR10"))).toBe(false);
  });
});

describe("v2.6 HR9: no first-loss capital is at most B", () => {
  it("an empty backstop under material borrows compresses 65+ into 65–79, eligible, without HR7", () => {
    expect(HARD_CAPS.noFirstLossCapital).toBe(79);
    const r = ratePool(healthyPool({ poolId: cid("no-backstop"), status: 3, backstop: empty }));
    expect(r.grade).toBe("B");
    expect(r.score).toBeLessThanOrEqual(79);
    expect(r.hardRules.find((h) => h.startsWith("HR9"))).toMatch(/lenders carry the first loss ⇒ at most B \(65\+ compressed into 65–79\)$/);
    expect(r.hardRules.some((h) => h.startsWith("HR7"))).toBe(false);
    expect(r.eligibleForDeposit).toBe(true);
  });

  it("Fixed (V2) passes the RiskGate minimum of 60 with room to spare", () => {
    const r = ratePool(fixedLike());
    expect(r.factors.find((f) => f.key === "utilization")!.value).toBe(100);
    expect(r.factors.find((f) => f.key === "backstop_coverage")!.value).toBe(0);
    expect(r.grade).toBe("B");
    expect(r.score!).toBeGreaterThanOrEqual(70);
    expect(r.eligibleForDeposit).toBe(true);
  });
});
