import { describe, it, expect } from "vitest";
import { freeLiquidityStroops, scorePools } from "./risk";
import type { PoolYield } from "./types";

const base: PoolYield = {
  protocol: "blend",
  poolId: "P", name: "x", asset: "USDC",
  apyBps: 800, tvlUsdc: 100_000_0000000n, utilizationBps: 5000, oracleHealthy: true,
};

describe("scorePools", () => {
  it("flags unhealthy-oracle pools ineligible regardless of tolerance", () => {
    const out = scorePools([{ ...base, oracleHealthy: false }], "aggressive");
    expect(out[0].eligible).toBe(false);
    expect(out[0].reason).toMatch(/oracle/i);
  });

  it("conservative rejects low-TVL pools, balanced accepts them", () => {
    const lowTvl = { ...base, tvlUsdc: 1_000_0000000n }; // 1k USDC
    expect(scorePools([lowTvl], "conservative")[0].eligible).toBe(false);
    expect(scorePools([lowTvl], "balanced")[0].eligible).toBe(true);
  });

  it("higher utilization and lower TVL increase risk score", () => {
    const safe = scorePools([base], "balanced")[0];
    const risky = scorePools([{ ...base, utilizationBps: 9500, tvlUsdc: 5_000_0000000n }], "balanced")[0];
    expect(risky.riskScore).toBeGreaterThan(safe.riskScore);
  });

  it("explains WHY an over-tolerance pool is ineligible (score + dominant driver)", () => {
    const risky = scorePools([{ ...base, utilizationBps: 9500, tvlUsdc: 5_000_0000000n }], "balanced")[0];
    expect(risky.eligible).toBe(false);
    // names the threshold breach and the utilization driver, not a bare label
    expect(risky.reason).toMatch(/risk \d+ > 65/);
    expect(risky.reason).toMatch(/thin liquidity \$250 withdrawable \(95% borrowed\)/);
  });

  it("marks frozen and unlaunched Blend pools ineligible even when the numbers look fine", () => {
    // 4 = Admin_Frozen, 5 = Frozen (deposits disabled), 6 = Setup (never launched)
    const frozen = scorePools([{ ...base, poolStatus: 4 }], "aggressive")[0];
    expect(frozen.eligible).toBe(false);
    expect(frozen.reason).toMatch(/frozen/i);
    expect(scorePools([{ ...base, poolStatus: 5 }], "aggressive")[0].eligible).toBe(false);
    expect(scorePools([{ ...base, poolStatus: 6 }], "aggressive")[0].reason).toMatch(/not active/);
  });

  it("keeps on-ice pools (status 2/3) eligible, like Vigil: Blend still takes deposits there", () => {
    expect(scorePools([{ ...base, poolStatus: 2 }], "aggressive")[0].eligible).toBe(true);
    expect(scorePools([{ ...base, poolStatus: 3 }], "aggressive")[0].eligible).toBe(true);
  });

  it("keeps active pools (status 0/1) and pools with unknown status eligible", () => {
    expect(scorePools([{ ...base, poolStatus: 0 }], "balanced")[0].eligible).toBe(true);
    expect(scorePools([{ ...base, poolStatus: 1 }], "balanced")[0].eligible).toBe(true);
    expect(scorePools([base], "balanced")[0].eligible).toBe(true);
  });

  // Liquidity is read in dollars as well as a ratio (2026-11-04): Fixed held
  // $51M of USDC at 77% borrowed, ~$11.7M of it withdrawable.
  it("a deep pool 99% borrowed is not excluded: $150M with $1.5M withdrawable carries no liquidity risk", () => {
    const deep = scorePools([{ ...base, tvlUsdc: 150_000_000_0000000n, utilizationBps: 9900 }], "conservative")[0];
    expect(deep.riskScore).toBe(0);
    expect(deep.eligible).toBe(true);
  });

  it("the liquidity penalty is the lower of the ratio's and the dollars' (none at $1M+, full at $10K-)", () => {
    // 95% borrowed of $2M: the ratio says 67, $100K withdrawable says 35
    expect(scorePools([{ ...base, tvlUsdc: 2_000_000_0000000n, utilizationBps: 9500 }], "balanced")[0].riskScore).toBe(35);
    // 95% borrowed of $20M: $1M withdrawable
    expect(scorePools([{ ...base, tvlUsdc: 20_000_000_0000000n, utilizationBps: 9500 }], "balanced")[0].riskScore).toBe(0);
    // a small pool keeps the ratio: 50% of $100K is 35, as before
    expect(scorePools([base], "balanced")[0].riskScore).toBe(35);
  });

  it("a thin pool stays excluded: $42.7K at 80% borrowed, like YieldBlox", () => {
    const thin = scorePools([{ ...base, tvlUsdc: 42_668_2612304n, utilizationBps: 7997 }], "balanced")[0];
    expect(thin.riskScore).toBe(73);
    expect(thin.eligible).toBe(false);
    expect(thin.reason).toMatch(/thin liquidity \$8\.5K withdrawable \(80% borrowed\), low TVL/);
  });

  it("freeLiquidityStroops is the unlent part of the TVL", () => {
    expect(freeLiquidityStroops(150_000_000_0000000n, 9900)).toBe(1_500_000_0000000n);
    expect(freeLiquidityStroops(1_000_0000000n, 0)).toBe(1_000_0000000n);
    expect(freeLiquidityStroops(1_000_0000000n, 10_000)).toBe(0n);
  });
});
