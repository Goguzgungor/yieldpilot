// The one sentence that explains the agent's route, shared by the decision
// (server) and the dashboard (client) so they can never disagree. Pure and
// client-safe: it reads only names, APY, risk and eligibility.

export interface RationalePool {
  poolId: string;
  name: string;
  apyBps: number;
  riskScore: number;
  eligible: boolean;
  reason?: string;
}

const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;

/** Highest-APY eligible pool (first wins a tie — same rule as risk.bestPool). */
export function bestEligible<T extends RationalePool>(pools: T[]): T | null {
  const ok = pools.filter((p) => p.eligible);
  return ok.length ? ok.reduce((a, b) => (b.apyBps > a.apyBps ? b : a)) : null;
}

/** The highest-APY pool the risk model excluded that out-earns `than`, if any. */
function passedOver(pools: RationalePool[], than: RationalePool): RationalePool | null {
  const better = pools.filter((p) => !p.eligible && p.apyBps > than.apyBps);
  return better.length ? better.reduce((a, b) => (b.apyBps > a.apyBps ? b : a)) : null;
}

/** Why `best` is the route; `holding` when the position is already there. */
export function explainRoute(best: RationalePool, pools: RationalePool[], holding: boolean): string {
  const lead = holding
    ? `${best.name} is still the highest-APY eligible pool (${pct(best.apyBps)}, risk ${best.riskScore}), so the agent holds.`
    : `${best.name} offers the highest APY among eligible pools (${pct(best.apyBps)}) at risk ${best.riskScore}.`;
  const skipped = passedOver(pools, best);
  if (!skipped) return lead;
  return `${lead} ${skipped.name} pays ${pct(skipped.apyBps)} but is excluded: ${skipped.reason ?? "not eligible"}.`;
}

/** The route's rationale for a scan, or null when nothing is eligible. */
export function routeRationale(pools: RationalePool[]): string | null {
  const best = bestEligible(pools);
  return best ? explainRoute(best, pools, false) : null;
}
