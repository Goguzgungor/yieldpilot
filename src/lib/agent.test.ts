import { describe, it, expect } from "vitest";
import { decide } from "./agent";
import type { ScoredPool, Position } from "./types";

const pool = (over: Partial<ScoredPool>): ScoredPool => ({
  protocol: "blend", poolId: "C_X", name: "X", asset: "USDC", apyBps: 500, tvlUsdc: 100_000_0000000n,
  utilizationBps: 5000, oracleHealthy: true, riskScore: 35, eligible: true, ...over,
});

const fixed = pool({ poolId: "C_FIXED", name: "Fixed", apyBps: 842, riskScore: 45 });
const orbit = pool({ poolId: "C_ORBIT", name: "Orbit", apyBps: 510, riskScore: 29 });
const yieldblox = pool({
  poolId: "C_YBX", name: "YieldBlox", apyBps: 1160, riskScore: 67, eligible: false,
  reason: "risk 67 > 65 (high utilization 96%)",
});
const pools = [orbit, fixed, yieldblox];

const idle: Position = { poolId: null, amountUsdc: 0n };

describe("decide (deterministic, no LLM)", () => {
  it("routes idle funds to the highest-APY eligible pool", () => {
    const d = decide({ pools, position: idle, tolerance: "balanced" });
    expect(d.action).toBe("rebalance");
    expect(d.toPool).toBe("C_FIXED");
    // amount is left to the orchestrator (current position, then the per-tx cap)
    expect(d.amountUsdc).toBeUndefined();
  });

  it("never picks an ineligible pool, however high its APY", () => {
    const d = decide({ pools, position: { poolId: "C_ORBIT", amountUsdc: 10n }, tolerance: "balanced" });
    expect(d.toPool).toBe("C_FIXED");
    expect(d.toPool).not.toBe("C_YBX");
  });

  it("holds when the position is already in the best eligible pool", () => {
    const d = decide({ pools, position: { poolId: "C_FIXED", amountUsdc: 10n }, tolerance: "balanced" });
    expect(d.action).toBe("hold");
    expect(d.toPool).toBeUndefined();
    expect(d.rationale).toContain("Fixed");
  });

  it("holds when no pool is eligible", () => {
    const d = decide({ pools: [yieldblox], position: idle, tolerance: "conservative" });
    expect(d.action).toBe("hold");
    expect(d.rationale).toMatch(/no pool is eligible/i);
    expect(d.rationale).toContain("conservative");
  });

  it("explains the choice with the numbers and the best excluded alternative", () => {
    const d = decide({ pools, position: idle, tolerance: "balanced" });
    expect(d.rationale).toContain("Fixed");
    expect(d.rationale).toContain("8.42%");
    expect(d.rationale).toContain("risk 45");
    // the higher-yield pool it passed over, and why
    expect(d.rationale).toContain("YieldBlox");
    expect(d.rationale).toContain("11.60%");
    expect(d.rationale).toContain("risk 67 > 65");
  });

  it("does not mention an excluded pool that pays less than the choice", () => {
    const low = pool({ poolId: "C_LOW", name: "LowBlox", apyBps: 300, eligible: false, reason: "oracle unhealthy / flagged" });
    const d = decide({ pools: [fixed, low], position: idle, tolerance: "balanced" });
    expect(d.rationale).not.toContain("LowBlox");
  });
});
