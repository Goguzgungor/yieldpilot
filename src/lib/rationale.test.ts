import { describe, it, expect } from "vitest";
import { routeRationale, bestEligible } from "./rationale";

// Shaped like the dashboard's /api/scan rows (tvl as a string), which is the point:
// the client derives the same sentence the agent logs, from the live scan.
const scan = [
  { poolId: "C_ETH", name: "Etherfuse", apyBps: 5, riskScore: 39, eligible: true, tvlUsdc: "54750000000" },
  { poolId: "C_FIX", name: "Fixed", apyBps: 666, riskScore: 55, eligible: true, tvlUsdc: "551000000000000" },
  { poolId: "C_DFX", name: "DeFindex USDC Fixed", apyBps: 666, riskScore: 55, eligible: true, tvlUsdc: "2000000000000" },
  { poolId: "C_YBX", name: "YieldBlox", apyBps: 806, riskScore: 76, eligible: false, reason: "risk 76 > 65 (high utilization 84%, low TVL)", tvlUsdc: "432380000000" },
];

describe("routeRationale", () => {
  it("explains the live route in one plain sentence", () => {
    expect(routeRationale(scan)).toBe(
      "Fixed offers the highest APY among eligible pools (6.66%) at risk 55. YieldBlox pays 8.06% but is excluded: risk 76 > 65 (high utilization 84%, low TVL).",
    );
  });

  it("breaks an APY tie the way the agent does: first pool in scan order", () => {
    expect(bestEligible(scan)?.poolId).toBe("C_FIX");
  });

  it("is null when nothing is eligible", () => {
    expect(routeRationale(scan.filter((p) => !p.eligible))).toBeNull();
  });
});
