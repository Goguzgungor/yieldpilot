/**
 * SDEX price-manipulation model (pure).
 *
 * Applied ONLY to collateral whose oracle price is derived from Stellar DEX trading
 * (`reflector_dex` / `sdex_other`). Assets priced from CEX/FX feeds, fixed pegs or
 * issuer push oracles cannot be moved by SDEX trades and are not run through this.
 *
 * Attack being modelled (the YieldBlox pattern, 22 Feb 2026): buy out the ask side of the
 * SDEX book up to a target price P·M, print trades at that level so the feed reports it,
 * keep it there for as many oracle rounds as the aggregator needs, post collateral at the
 * inflated price, borrow the pool's liquidity and walk away.
 *
 * max_dev: both deployed aggregator versions (blend-capital/oracle-aggregator@b97e0a8 and the
 * yieldblox fork @2307a9b, src/price_data.rs) compare ONLY the newest price with the one
 * immediately before it. So max_dev blocks a one-round spike but does NOT cap cumulative
 * movement: a price held for two consecutive rounds passes (diff = 0). That is exactly how the
 * YieldBlox exploit passed USTRY's max_dev=10 (two poisoned rounds, 00:15 and 00:20 UTC — rekt.news).
 * We therefore model `roundsToHold` = 2 when max_dev is active (0 < max_dev < 100), else 1, and a
 * per-round book replenishment fraction (default 0 = attacker-friendly; thin books have no active MM).
 */
import type { AskLevel, DexDepth } from "./types";

export interface ManipulationParams {
  /** Price multipliers the attacker may target. */
  multipliers: number[];
  /** Fraction of the swept ask depth that market makers re-post each extra round the price must be held. */
  replenishmentPerRound: number;
}

export const DEFAULT_MANIPULATION_PARAMS: ManipulationParams = {
  multipliers: [1.1, 1.25, 1.5, 2, 3, 5, 10, 25, 100],
  replenishmentPerRound: 0,
};

export interface ManipulationInput {
  priceUsd: number;
  cFactor: number;
  /** Remaining supply-cap room for this collateral, whole tokens. null = uncapped. */
  capHeadroomTokens: number | null;
  /** Borrowable liquidity in the pool's OTHER reserves (respecting max_util), USD. */
  availableUsd: number;
  /** Availability-weighted l_factor of those reserves (0..1). */
  avgLFactor: number;
  depth: DexDepth;
  maxDevPct?: number;
  resolutionSec?: number;
}

export interface ManipulationResult {
  /**
   * Cheapest attacker capital per USD extracted:
   *   rho = (collateral at true value + SDEX sweep cost) / extractable borrow value.
   * rho < 1 ⇒ a profitable manipulation exists. null ⇒ nothing extractable (no liquidity / c too low).
   */
  rho: number | null;
  multiplier: number | null;
  extractableUsd: number;
  collateralCostUsd: number;
  manipulationCostUsd: number;
  /** The ask book ran out below the target AND the venue truncated it: true cost may be higher. */
  costIsLowerBound: boolean;
  roundsToHold: number;
  /** Minimum seconds the manipulated price must be sustained (roundsToHold × resolution). */
  minHoldSeconds: number | null;
  profitable: boolean;
}

/** Rounds the manipulated price must be sustained before the aggregator returns it. */
export function roundsToHold(maxDevPct: number | undefined): number {
  return maxDevPct !== undefined && maxDevPct > 0 && maxDevPct < 100 ? 2 : 1;
}

/**
 * USDC needed to buy every ask priced at or below `targetPrice`.
 * `exhausted` = every observed level is below the target (the visible book ran out).
 */
export function sweepCost(asks: AskLevel[], targetPrice: number): { costUsd: number; tokens: number; exhausted: boolean } {
  let costUsd = 0;
  let tokens = 0;
  let exhausted = true;
  for (const a of asks) {
    if (a.price > targetPrice) {
      exhausted = false;
      break;
    }
    costUsd += a.amount * a.price;
    tokens += a.amount;
  }
  return { costUsd, tokens, exhausted };
}

export function assessManipulation(
  input: ManipulationInput,
  params: ManipulationParams = DEFAULT_MANIPULATION_PARAMS,
): ManipulationResult {
  const hold = roundsToHold(input.maxDevPct);
  const minHoldSeconds = input.resolutionSec ? hold * input.resolutionSec : null;
  const none: ManipulationResult = {
    rho: null,
    multiplier: null,
    extractableUsd: 0,
    collateralCostUsd: 0,
    manipulationCostUsd: 0,
    costIsLowerBound: false,
    roundsToHold: hold,
    minHoldSeconds,
    profitable: false,
  };
  const P = input.priceUsd;
  if (!(P > 0) || !(input.cFactor > 0) || !(input.avgLFactor > 0) || !(input.availableUsd > 0)) return none;

  let best: ManipulationResult | null = null; // lowest rho overall
  let bestExact: ManipulationResult | null = null; // lowest rho whose sweep cost is exact (book fully observed)
  for (const M of params.multipliers) {
    const leverage = M * input.cFactor * input.avgLFactor; // USD borrowable per USD of true collateral value
    if (leverage <= 1) continue; // cannot borrow more than the collateral is worth
    const capPowerUsd = input.capHeadroomTokens === null ? Infinity : input.capHeadroomTokens * P * leverage;
    const extractableUsd = Math.min(input.availableUsd, capPowerUsd);
    if (!(extractableUsd > 0)) continue;
    const collateralCostUsd = extractableUsd / leverage;
    const sweep = sweepCost(input.depth.asks, P * M);
    const manipulationCostUsd = sweep.costUsd * (1 + params.replenishmentPerRound * (hold - 1));
    const rho = (collateralCostUsd + manipulationCostUsd) / extractableUsd;
    const r: ManipulationResult = {
      rho,
      multiplier: M,
      extractableUsd,
      collateralCostUsd,
      manipulationCostUsd,
      costIsLowerBound: sweep.exhausted && input.depth.truncated,
      roundsToHold: hold,
      minHoldSeconds,
      profitable: rho < 1,
    };
    if (!best || rho < (best.rho as number)) best = r;
    if (!r.costIsLowerBound && (!bestExact || rho < (bestExact.rho as number))) bestExact = r;
  }
  // A certain profitable attack outranks a cheaper-looking one whose cost is only a lower bound.
  if (bestExact && bestExact.profitable) return bestExact;
  return best ?? none;
}