import { bestPool } from "./risk";
import type { ScoredPool, Position, Decision, RiskTolerance } from "./types";

// The agent's decision is deterministic: the highest-APY pool among those the
// risk model marked eligible. This used to be an LLM tool call, but the LLM was
// only ever asked to apply that same rule — and every tick paid for a model call
// to do it. The rationale is composed from the scan so the UI (and the activity
// log) still get a plain-language reason for every decision, at no cost.

export interface DecisionContext { pools: ScoredPool[]; position: Position; tolerance: RiskTolerance; }

const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;

/** The highest-APY pool the risk model excluded that out-earns `than`, if any. */
function passedOver(pools: ScoredPool[], than: ScoredPool): ScoredPool | null {
  const better = pools.filter((p) => !p.eligible && p.apyBps > than.apyBps);
  return better.length ? better.reduce((a, b) => (b.apyBps > a.apyBps ? b : a)) : null;
}

function explain(best: ScoredPool, pools: ScoredPool[], holding: boolean): string {
  const lead = holding
    ? `${best.name} is still the highest-APY eligible pool (${pct(best.apyBps)}, risk ${best.riskScore}), so the agent holds.`
    : `${best.name} offers the highest APY among eligible pools (${pct(best.apyBps)}) at risk ${best.riskScore}.`;
  const skipped = passedOver(pools, best);
  if (!skipped) return lead;
  return `${lead} ${skipped.name} pays ${pct(skipped.apyBps)} but is excluded: ${skipped.reason ?? "not eligible"}.`;
}

export function decide(ctx: DecisionContext): Decision {
  const best = bestPool(ctx.pools);
  if (!best) {
    return { action: "hold", rationale: `No pool is eligible under the ${ctx.tolerance} risk tolerance, so the agent holds.` };
  }
  if (ctx.position.poolId === best.poolId) {
    return { action: "hold", rationale: explain(best, ctx.pools, true) };
  }
  // amountUsdc is left unset: the orchestrator moves the current position,
  // bounded by the per-tx and daily caps.
  return { action: "rebalance", toPool: best.poolId, rationale: explain(best, ctx.pools, false) };
}
