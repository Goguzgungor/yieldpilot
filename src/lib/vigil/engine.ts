/**
 * Vigil engine orchestration: discover → snapshot → rate (Blend) → rate (DeFindex).
 * All I/O is injected so the whole pipeline runs offline in tests.
 */
import { rateDefindexStrategy, type DefindexStrategyInput } from "./defindex";
import { discoverBlendPools, type DiscoveryResult, type PoolIdSource, type PoolVerifier } from "./discovery";
import { ENGINE_VERSION, ratePool, type RateOptions } from "./score";
import { pathsToGrades } from "./whatif";
import type { PoolRating, PoolSnapshot } from "./types";

export interface DefindexStrategyRef {
  strategyId: string;
  name: string;
  asset: string;
  assetContractId: string;
  blendPoolId: string;
}

export interface EngineDeps {
  sources: PoolIdSource[];
  verifier?: PoolVerifier;
  fallbackPoolIds?: string[];
  snapshot(poolId: string): Promise<PoolSnapshot>;
  /** Optional on-chain read of a DeFindex strategy's Config + managed amount (whole tokens). */
  readStrategy?(strategyId: string): Promise<{ pool: string | null; asset: string | null; managedTokens: number | null }>;
  log?(msg: string): void;
}

export interface EngineResult {
  engineVersion: string;
  computedAt: number;
  discovery: DiscoveryResult;
  pools: PoolRating[];
  defindex: PoolRating[];
  failures: { id: string; error: string }[];
  snapshots: Record<string, PoolSnapshot>;
}

export async function runVigil(
  deps: EngineDeps,
  opts: { defindexStrategies?: DefindexStrategyRef[]; rate?: RateOptions; now?: number } = {},
): Promise<EngineResult> {
  const log = deps.log ?? (() => {});
  const discovery = await discoverBlendPools({ sources: deps.sources, verifier: deps.verifier, fallbackIds: deps.fallbackPoolIds });
  log(`discovery: ${discovery.poolIds.length} pools (${discovery.sources.map((s) => `${s.name}=${s.count}${s.error ? "!" : ""}`).join(", ")})`);

  const pools: PoolRating[] = [];
  const failures: EngineResult["failures"] = [];
  const snapshots: Record<string, PoolSnapshot> = {};
  for (const id of discovery.poolIds) {
    try {
      const snap = await deps.snapshot(id);
      snapshots[id] = snap;
      pools.push({ ...ratePool(snap, opts.rate), paths: pathsToGrades(snap, opts.rate) });
      log(`rated ${snap.name} ${id.slice(0, 6)}…`);
    } catch (e) {
      failures.push({ id, error: e instanceof Error ? e.message : String(e) });
      log(`FAILED ${id}: ${e instanceof Error ? e.message : e}`);
    }
  }

  const byId = Object.fromEntries(pools.map((p) => [p.poolId, p]));
  const defindex: PoolRating[] = [];
  for (const s of opts.defindexStrategies ?? []) {
    const onchain = deps.readStrategy ? await deps.readStrategy(s.strategyId).catch(() => null) : null;
    const poolId = onchain?.pool || s.blendPoolId;
    const snap = snapshots[poolId];
    const reserve = snap?.reserves.find((r) => r.assetId === (onchain?.asset || s.assetContractId));
    const tvlUsd = onchain?.managedTokens != null && reserve?.priceUsd ? onchain.managedTokens * reserve.priceUsd : null;
    const input: DefindexStrategyInput = {
      ...s,
      onchainPoolId: onchain?.pool ?? null,
      onchainAssetId: onchain?.asset ?? null,
      tvlUsd: tvlUsd !== null ? Math.round(tvlUsd * 100) / 100 : null,
    };
    defindex.push(rateDefindexStrategy(input, byId, snapshots));
  }

  const computedAt = opts.now ?? Math.max(0, ...Object.values(snapshots).map((s) => s.asOf.timestamp));
  return { engineVersion: ENGINE_VERSION, computedAt, discovery, pools, defindex, failures, snapshots };
}

/** JSON-ready shape written by scripts/vigil-ratings.ts (snapshots omitted). */
export function toRatingsJson(r: EngineResult) {
  return {
    engineVersion: r.engineVersion,
    computedAt: r.computedAt,
    network: "stellar-mainnet",
    coverage: {
      poolsFound: r.discovery.poolIds.length,
      rated: r.pools.length,
      failed: r.failures,
      sources: r.discovery.sources,
      rejected: r.discovery.rejected,
      unverified: r.discovery.candidates.filter((c) => c.verified !== true).map((c) => c.poolId),
      fallbackOnly: r.discovery.fallbackOnly,
    },
    ratings: [...r.pools, ...r.defindex],
    /** Compact per-pool inputs behind each rating (for audit / re-hashing). */
    inputs: Object.fromEntries(
      Object.entries(r.snapshots).map(([id, s]) => [
        id,
        {
          name: s.name,
          status: s.status,
          oracleId: s.oracleId,
          oracleKind: s.oracleKind,
          asOf: s.asOf,
          backstop: s.backstop,
          dataGaps: s.dataGaps,
          reserves: s.reserves.map((x) => ({
            symbol: x.symbol,
            assetId: x.assetId,
            cFactor: x.cFactor,
            lFactor: x.lFactor,
            maxUtil: x.maxUtil,
            supplyCap: x.supplyCap,
            enabled: x.enabled,
            supplied: x.supplied,
            borrowed: x.borrowed,
            priceUsd: x.priceUsd,
            priceTimestamp: x.priceTimestamp,
            source: x.source,
          })),
          dexDepth: Object.fromEntries(
            Object.entries(s.dexDepth).map(([k, v]) => [k, { levels: v.asks.length, truncated: v.truncated, bestAsk: v.asks[0]?.price ?? null, source: v.source }]),
          ),
        },
      ]),
    ),
  };
}
