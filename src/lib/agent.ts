import { bestPool } from "./risk";
import { explainRoute } from "./rationale";
import type { ScoredPool, Position, Decision, RiskTolerance } from "./types";

// The agent's decision is deterministic: the highest-APY pool among those the
// risk model marked eligible. This used to be an LLM tool call, but the LLM was
// only ever asked to apply that same rule — and every tick paid for a model call
// to do it. The rationale is composed from the scan (rationale.ts, shared with
// the dashboard) so every decision still carries a plain-language reason.

export interface DecisionContext { pools: ScoredPool[]; position: Position; tolerance: RiskTolerance; }

export function decide(ctx: DecisionContext): Decision {
  const best = bestPool(ctx.pools);
  if (!best) {
    return { action: "hold", rationale: `No pool is eligible under the ${ctx.tolerance} risk tolerance, so the agent holds.` };
  }
  if (ctx.position.poolId === best.poolId) {
    return { action: "hold", rationale: explainRoute(best, ctx.pools, true) };
  }
  // amountUsdc is left unset: the orchestrator moves the current position,
  // bounded by the per-tx and daily caps.
  return { action: "rebalance", toPool: best.poolId, rationale: explainRoute(best, ctx.pools, false) };
}
