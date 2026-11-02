/**
 * YieldPilot follows its own RiskGate. With a Vigil registry configured, the
 * agent routes only to pools the on-chain guard would accept: a fresh Vigil
 * rating, eligible for deposits, at or above the wallet's minimum score. Pure;
 * the tick passes the cached ratings (it never recomputes them, a run takes
 * ~90 s).
 */
import type { ScoredPool } from "./types";

/** The fields of a Vigil PoolRating the gate reads. */
export interface VigilVerdict {
  poolId: string;
  name: string;
  protocol: string;
  score: number | null;
  grade: string;
  eligibleForDeposit: boolean;
  notRated?: string;
  hardRules: string[];
}

/** The first rule that closes deposits, shortened for a reason line. */
function blockingRule(v: VigilVerdict): string {
  const rule = v.hardRules.find((h) => h.includes("not eligible")) ?? "a hard rule";
  return rule.length > 90 ? `${rule.slice(0, 89)}…` : rule;
}

/**
 * Mark every pool the guard would refuse as not eligible, with the reason.
 * `ratings` null means no fresh Vigil ratings: the guard refuses everything
 * then (RatingUnavailable / RatingStale), so the agent does too.
 */
export function gateByVigil(pools: ScoredPool[], ratings: VigilVerdict[] | null, minScore: number): ScoredPool[] {
  const byId = new Map((ratings ?? []).map((r) => [r.poolId, r]));
  return pools.map((p) => {
    if (!p.eligible) return p;
    const no = (reason: string): ScoredPool => ({ ...p, eligible: false, reason });
    if (!ratings) return no("no fresh Vigil rating (RiskGate refuses deposits)");
    const v = byId.get(p.poolId);
    if (!v) return no("not rated by Vigil");
    if (v.score === null) return no(`Vigil NR: ${v.notRated ?? "not rated"}`);
    if (!v.eligibleForDeposit) return no(`Vigil ${v.grade} ${v.score}, not eligible: ${blockingRule(v)}`);
    if (v.score < minScore) return no(`Vigil ${v.grade} ${v.score} < ${minScore}, the RiskGate minimum`);
    return p;
  });
}

/**
 * Blend pools Vigil rates as depositable, for the agent to scan next to its
 * own discovery (Vigil also covers Blend v2.1, which the agent's discovery
 * does not enumerate).
 */
export function vigilCandidatePools(ratings: VigilVerdict[] | null, minScore: number): string[] {
  return (ratings ?? [])
    .filter((r) => r.protocol === "blend" && r.score !== null && r.eligibleForDeposit && r.score >= minScore)
    .map((r) => r.poolId);
}
