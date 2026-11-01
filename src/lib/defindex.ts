import { PoolV2 } from "@blend-capital/blend-sdk";
import type { Network } from "@blend-capital/blend-sdk";
import type { PoolYield, YieldSource } from "./types";
import type { BlendReader } from "./scanner";
import type { DefindexStrategyConfig } from "./config";

/** Reads a DeFindex strategy's total managed funds on-chain, as USDC stroops. */
export interface StrategyTvlReader {
  readTotalManagedFunds(strategyId: string): Promise<bigint | null>;
}

/**
 * DeFindex as a scan-only YieldSource. Each strategy autocompounds into one
 * reserve (`cfg.asset`) of a Blend pool, so APY / utilization / oracle health are
 * read from that reserve via `readerFor(cfg.assetContractId)` — multi-asset
 * (USDC / EURC / XLM). TVL is read on-chain from the strategy when a
 * StrategyTvlReader is supplied, otherwise the configured fallback is used.
 */
export function createDefindexSource(
  readerFor: (assetContractId: string) => BlendReader,
  strategies: DefindexStrategyConfig[],
  tvlReader?: StrategyTvlReader,
): YieldSource {
  const byId = new Map(strategies.map((s) => [s.strategyId, s]));
  return {
    protocol: "defindex",
    async readPool(strategyId: string): Promise<PoolYield | null> {
      const cfg = byId.get(strategyId);
      if (!cfg) return null;

      const r = await readerFor(cfg.assetContractId).readReserve(cfg.blendPoolId);
      if (!r) return null;

      let tvlUsdc = cfg.fallbackTvlUsdc;
      if (tvlReader) {
        try {
          const live = await tvlReader.readTotalManagedFunds(strategyId);
          if (live !== null) tvlUsdc = live;
        } catch {
          // keep fallback TVL
        }
      }

      return {
        protocol: "defindex",
        poolId: strategyId,
        name: cfg.name,
        asset: cfg.asset,
        apyBps: Math.round(r.supplyApr * 10000),
        tvlUsdc,
        utilizationBps: Math.round(r.utilization * 10000),
        oracleHealthy: !r.oracleStale,
        poolStatus: r.poolStatus,
      };
    },
  };
}

/**
 * Convert a token amount (raw units with `decimals`) to USDC stroops at
 * `priceUsd`. USDC is treated as 1:1 with USD, matching `PoolYield.tvlUsdc`.
 */
export function toUsdcStroops(amount: bigint, decimals: number, priceUsd: number): bigint {
  if (amount <= 0n || !Number.isFinite(priceUsd) || priceUsd <= 0) return 0n;
  const scale = 10 ** (7 - decimals);
  return BigInt(Math.round(Number(amount) * scale * priceUsd));
}

/**
 * Reads a strategy's managed funds from its position in the underlying Blend
 * pool. DeFindex Blend strategies expose no no-arg total getter (see
 * scripts/verify-defindex-strategy.ts), but every unit they manage sits in the
 * pool as the strategy contract's own supply/collateral position, so
 * `pool.loadUser(strategyId)` is the on-chain source of truth. Non-USDC
 * positions are converted with the pool's oracle price. Pool + oracle loads
 * are memoized for `ttlMs` so a scan of several strategies on the same pool
 * costs one load.
 */
export function createBlendPositionTvlReader(
  network: Network,
  strategies: DefindexStrategyConfig[],
  ttlMs = 60_000,
): StrategyTvlReader {
  const byId = new Map(strategies.map((s) => [s.strategyId, s]));
  const cache = new Map<string, { at: number; pool: Promise<PoolV2> }>();
  const loadPool = (poolId: string): Promise<PoolV2> => {
    const hit = cache.get(poolId);
    if (hit && Date.now() - hit.at < ttlMs) return hit.pool;
    const pool = PoolV2.load(network, poolId);
    cache.set(poolId, { at: Date.now(), pool });
    pool.catch(() => cache.delete(poolId));
    return pool;
  };
  return {
    async readTotalManagedFunds(strategyId: string): Promise<bigint | null> {
      const cfg = byId.get(strategyId);
      if (!cfg) return null;
      const pool = await loadPool(cfg.blendPoolId);
      const reserve = pool.reserves.get(cfg.assetContractId);
      if (!reserve) return null;
      const user = await pool.loadUser(strategyId);
      const amount = user.getSupply(reserve) + user.getCollateral(reserve);
      if (cfg.asset === "USDC") return toUsdcStroops(amount, reserve.config.decimals, 1);
      const price = (await pool.loadOracle()).getPriceFloat(cfg.assetContractId);
      return price === undefined ? null : toUsdcStroops(amount, reserve.config.decimals, price);
    },
  };
}
