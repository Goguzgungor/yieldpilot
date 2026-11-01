/**
 * DeFindex ratings, derived from the underlying Blend pool ratings (worst-of).
 *
 * A DeFindex Blend strategy supplies one asset into one Blend pool (its instance storage
 * `Config.pool` / `Config.asset`), so its risk is the pool's risk plus a check that the
 * strategy's reserve is actually live in that pool. A vault spreading over several
 * strategies is rated worst-of its strategies (lending risk is not diversifiable to the
 * depositor when any single pool can be drained).
 *
 * Not modelled (stated on every rating): DeFindex contract / keeper / upgrade risk.
 */
import { sha256Canonical } from "./canonical";
import { ENGINE_VERSION, gradeFor, HARD_CAPS, reserveYields, STATUS_LABELS } from "./score";
import type { PoolRating, PoolSnapshot, RatingFactor } from "./types";

export interface DefindexStrategyInput {
  strategyId: string;
  name: string;
  /** Asset symbol, e.g. "USDC". */
  asset: string;
  assetContractId: string;
  /** Pool from configuration (SCAN_DEFINDEX_STRATEGIES). */
  blendPoolId: string;
  /** Pool read from the strategy's on-chain `Config` (preferred when present). */
  onchainPoolId?: string | null;
  onchainAssetId?: string | null;
  tvlUsd?: number | null;
}

const NOT_MODELLED = "DeFindex strategy contract/keeper/upgrade risk is not modelled (rating = underlying pool risk only)";

export function rateDefindexStrategy(
  input: DefindexStrategyInput,
  poolRatings: Record<string, PoolRating>,
  poolSnapshots: Record<string, PoolSnapshot> = {},
  now?: number,
): PoolRating {
  const poolId = input.onchainPoolId || input.blendPoolId;
  const reasons: string[] = [];
  const hardRules: string[] = [];
  if (input.onchainPoolId && input.onchainPoolId !== input.blendPoolId) {
    reasons.push(`config says pool ${input.blendPoolId.slice(0, 6)}… but strategy Config.pool is ${input.onchainPoolId.slice(0, 6)}… — using on-chain value`);
  }
  if (input.onchainAssetId && input.onchainAssetId !== input.assetContractId) {
    reasons.push(`config asset ${input.assetContractId.slice(0, 6)}… differs from on-chain Config.asset ${input.onchainAssetId.slice(0, 6)}…`);
  }

  const pool = poolRatings[poolId];
  if (!pool) {
    const factors: RatingFactor[] = [{ key: "underlying_pool", value: 0, weight: 1, contribution: 0, raw: poolId, note: "underlying pool not rated" }];
    hardRules.push("HR-D1 underlying pool could not be rated ⇒ not eligible, grade E");
    return finish(input, poolId, 0, 6, false, factors, [...hardRules, ...reasons, NOT_MODELLED], hardRules, now, []);
  }

  let score = pool.score;
  let eligible = pool.eligibleForDeposit;
  const snap = poolSnapshots[poolId];
  const assetId = input.onchainAssetId || input.assetContractId;
  const reserve = snap?.reserves.find((r) => r.assetId === assetId);
  const factors: RatingFactor[] = [
    {
      key: "underlying_pool",
      value: pool.score,
      weight: 1,
      contribution: pool.score,
      raw: pool.reasonsHash,
      note: `worst-of underlying Blend pool ${pool.name} (${poolId.slice(0, 6)}…) grade ${pool.grade}`,
    },
  ];
  if (snap && (!reserve || !reserve.enabled)) {
    eligible = false;
    score = Math.min(score, HARD_CAPS.sdexManipulable);
    hardRules.push(`HR-D2 strategy asset ${input.asset} is ${reserve ? "disabled" : "not a reserve"} in the underlying pool ⇒ not eligible`);
  }
  for (const h of pool.hardRules) hardRules.push(`underlying: ${h}`);
  const rating = finish(
    input,
    poolId,
    score,
    pool.status,
    eligible,
    factors,
    [...hardRules, ...reasons, ...pool.reasons.filter((r) => !pool.hardRules.includes(r)).map((r) => `underlying: ${r}`), NOT_MODELLED],
    hardRules,
    now ?? pool.computedAt,
    [pool.reasonsHash],
  );
  const yields = snap ? reserveYields(snap).filter((y) => y.assetId === assetId) : [];
  return { ...rating, uncappedScore: pool.uncappedScore, yields };
}

/** Rate a vault spreading over several strategies: worst-of its strategy ratings. */
export function rateDefindexVault(
  vault: { vaultId: string; name: string; tvlUsd?: number | null },
  strategyRatings: PoolRating[],
  now?: number,
): PoolRating {
  if (!strategyRatings.length) {
    const factors: RatingFactor[] = [{ key: "worst_strategy", value: 0, weight: 1, contribution: 0, raw: null, note: "vault has no rated strategies" }];
    const hr = ["HR-D1 no rated strategies ⇒ not eligible, grade E"];
    return finishVault(vault, 0, 6, false, factors, hr, hr, now ?? 0, [], []);
  }
  let worst = strategyRatings[0];
  for (const s of strategyRatings) if (s.score < worst.score) worst = s;
  const factors: RatingFactor[] = [
    { key: "worst_strategy", value: worst.score, weight: 1, contribution: worst.score, raw: worst.reasonsHash, note: `worst strategy ${worst.name} grade ${worst.grade}` },
  ];
  const eligible = strategyRatings.every((s) => s.eligibleForDeposit);
  const status = Math.max(...strategyRatings.map((s) => s.status));
  const hardRules = strategyRatings.flatMap((s) => s.hardRules.map((h) => `${s.name}: ${h}`));
  return finishVault(
    vault,
    worst.score,
    status,
    eligible,
    factors,
    [...hardRules, NOT_MODELLED],
    hardRules,
    now ?? worst.computedAt,
    strategyRatings.map((s) => s.reasonsHash),
    strategyRatings.map((s) => s.poolId),
  );
}

function finish(
  input: DefindexStrategyInput,
  poolId: string,
  score: number,
  status: number,
  eligible: boolean,
  factors: RatingFactor[],
  reasons: string[],
  hardRules: string[],
  now: number | undefined,
  underlyingHashes: string[],
): PoolRating {
  const grade = gradeFor(score);
  return {
    poolId: input.strategyId,
    name: input.name,
    protocol: "defindex",
    score,
    grade,
    status,
    statusLabel: STATUS_LABELS[status] ?? `unknown(${status})`,
    eligibleForDeposit: eligible,
    factors,
    reasons,
    hardRules,
    tvlUsd: input.tvlUsd ?? 0,
    computedAt: now ?? 0,
    reasonsHash: sha256Canonical({
      engineVersion: ENGINE_VERSION,
      inputs: { strategyId: input.strategyId, poolId, asset: input.onchainAssetId || input.assetContractId, underlyingHashes },
      factors,
      hardRules,
      score,
      grade,
      eligibleForDeposit: eligible,
    }),
    engineVersion: ENGINE_VERSION,
    underlying: [poolId],
  };
}

function finishVault(
  vault: { vaultId: string; name: string; tvlUsd?: number | null },
  score: number,
  status: number,
  eligible: boolean,
  factors: RatingFactor[],
  reasons: string[],
  hardRules: string[],
  now: number,
  underlyingHashes: string[],
  strategyIds: string[],
): PoolRating {
  const grade = gradeFor(score);
  return {
    poolId: vault.vaultId,
    name: vault.name,
    protocol: "defindex",
    score,
    grade,
    status,
    statusLabel: STATUS_LABELS[status] ?? `unknown(${status})`,
    eligibleForDeposit: eligible,
    factors,
    reasons,
    hardRules,
    tvlUsd: vault.tvlUsd ?? 0,
    computedAt: now,
    reasonsHash: sha256Canonical({ engineVersion: ENGINE_VERSION, inputs: { vaultId: vault.vaultId, underlyingHashes }, factors, hardRules, score, grade, eligibleForDeposit: eligible }),
    engineVersion: ENGINE_VERSION,
    underlying: strategyIds,
  };
}
