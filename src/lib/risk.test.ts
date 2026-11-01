import { describe, it, expect } from "vitest";
import { scorePools } from "./risk";
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
    expect(risky.reason).toMatch(/high utilization 95%/);
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
});
