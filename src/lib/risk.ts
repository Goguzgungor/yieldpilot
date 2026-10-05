import type { PoolYield, ScoredPool, RiskTolerance } from "./types";

const MIN_TVL: Record<RiskTolerance, bigint> = {
  conservative: 50_000_0000000n, // 50k USDC (conservative floor)
  balanced: 0n,                  // no hard TVL floor; risk score governs
  aggressive: 0n,
};
export const MAX_RISK: Record<RiskTolerance, number> = {
  conservative: 35, balanced: 65, aggressive: 100,
};

export function scorePools(pools: PoolYield[], tolerance: RiskTolerance): ScoredPool[] {
  return pools.map((p) => {
    const utilRisk = Math.round((p.utilizationBps / 10000) * 70);
    const tvlRef = 100_000_0000000n; // 100k USDC reference
    const tvlRatio = p.tvlUsdc >= tvlRef ? 1 : Number(p.tvlUsdc) / Number(tvlRef);
    const tvlRisk = Math.round((1 - tvlRatio) * 30);
    const riskScore = Math.min(100, utilRisk + tvlRisk);

    let eligible = true;
    let reason: string | undefined;
    if (!p.oracleHealthy) { eligible = false; reason = "oracle unhealthy / flagged"; }
    else if (p.tvlUsdc < MIN_TVL[tolerance]) { eligible = false; reason = "TVL below tolerance floor"; }
    else if (riskScore > MAX_RISK[tolerance]) {
      eligible = false;
      // Surface WHY: the score vs. the tolerance cap, plus the dominant driver(s)
      // so the UI can explain a high risk score instead of just stating it.
      const utilPct = Math.round(p.utilizationBps / 100);
      const drivers: string[] = [];
      if (utilRisk >= tvlRisk) drivers.push(`high utilization ${utilPct}%`);
      if (tvlRisk >= 10) drivers.push("low TVL");
      if (drivers.length === 0) drivers.push(`utilization ${utilPct}%`);
      reason = `risk ${riskScore} > ${MAX_RISK[tolerance]} (${drivers.join(", ")})`;
    }

    return { ...p, riskScore, eligible, reason };
  });
}

/** Best eligible pool by APY, or null. */
export function bestPool(scored: ScoredPool[]): ScoredPool | null {
  const eligible = scored.filter((p) => p.eligible);
  if (eligible.length === 0) return null;
  return eligible.reduce((a, b) => (b.apyBps > a.apyBps ? b : a));
}
