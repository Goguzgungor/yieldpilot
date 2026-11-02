/**
 * Live (mainnet, read-only) wiring of the Vigil engine, shared by
 * scripts/vigil-ratings.ts and the /api/ratings route. A full run reads every
 * pool of every Blend deployment + the configured DeFindex strategies (~90 s),
 * so callers cache the result (see runtime.ts `getRatings`).
 */
import { createBlendOnchainPoolSource } from "../discovery";
import { historyFor, mergeDepthHistory, samplesOf, type DepthHistory, type DepthHistoryStore } from "./depthHistory";
import { functionSource, stellarExpertDeploySource } from "./discovery";
import { runVigil, toRatingsJson, type DefindexStrategyRef, type EngineResult } from "./engine";
import { createLiveReaders, type BlendDeployment } from "./live";
import { mergeUtilizationHistory, utilizationHistoryFor, type UtilizationHistory, type UtilizationHistoryStore } from "./utilizationHistory";

export type { BlendDeployment, DepthHistoryStore, UtilizationHistoryStore };

export interface LiveRatingsConfig {
  rpcUrl: string;
  passphrase: string;
  /** Every Blend deployment to enumerate (pool factory + its backstop). */
  deployments: BlendDeployment[];
  /** Curated pool ids, used if discovery finds nothing. */
  curatedPoolIds: string[];
  defindexStrategies: DefindexStrategyRef[];
  /** Delay between RPC calls (rate-limit friendliness). */
  callDelayMs?: number;
  /**
   * Where earlier order books are kept for the rolling-window depth. Without
   * one, each run rates manipulation on the book it reads (v2.2 behaviour).
   */
  depthHistory?: DepthHistoryStore;
  /** Where earlier reserve reads are kept for HR10's window. Without one, HR10 sees the current read only (v2.4 behaviour). */
  utilizationHistory?: UtilizationHistoryStore;
  log?(msg: string): void;
}

export type RatingsJson = ReturnType<typeof toRatingsJson>;

export async function runLiveVigil(cfg: LiveRatingsConfig): Promise<EngineResult> {
  const live = createLiveReaders({
    rpcUrl: cfg.rpcUrl,
    passphrase: cfg.passphrase,
    deployments: cfg.deployments,
    callDelayMs: cfg.callDelayMs ?? 120,
  });
  // Per deployment: the factory's full deploy history (authoritative) plus its
  // backstop reward zone and recent deploy events.
  const sources = cfg.deployments.flatMap((dep) => {
    const rpcSource = createBlendOnchainPoolSource({
      rpcUrl: cfg.rpcUrl,
      networkPassphrase: cfg.passphrase,
      backstopId: dep.backstopId,
      factoryId: dep.factoryId,
    });
    const deploys = stellarExpertDeploySource({ factoryId: dep.factoryId, fetchJson: live.fetchJson });
    return [
      { ...deploys, name: `${deploys.name}:${dep.name}` },
      functionSource(`rpc:backstop-reward-zone+recent-deploy-events:${dep.name}`, () => rpcSource.listPools()),
    ];
  });
  // Books from earlier runs are attached to each snapshot; this run's books are
  // added to the store afterwards, so a pool is never compared with itself.
  let past: DepthHistory = {};
  if (cfg.depthHistory) {
    try {
      past = await cfg.depthHistory.load();
    } catch (e) {
      cfg.log?.(`depth history unavailable, rating on single reads: ${(e as Error).message}`);
    }
  }
  let pastUtil: UtilizationHistory = {};
  if (cfg.utilizationHistory) {
    try {
      pastUtil = await cfg.utilizationHistory.load();
    } catch (e) {
      cfg.log?.(`utilization history unavailable, HR10 on the current read only: ${(e as Error).message}`);
    }
  }
  const result = await runVigil(
    {
      sources,
      verifier: live.verifier,
      fallbackPoolIds: cfg.curatedPoolIds,
      snapshot: async (poolId) => {
        const s = await live.snapshot(poolId);
        const dexDepthHistory = historyFor(s, past);
        const utilizationHistory = utilizationHistoryFor(s, pastUtil);
        return { ...s, ...(dexDepthHistory ? { dexDepthHistory } : {}), ...(utilizationHistory ? { utilizationHistory } : {}) };
      },
      readStrategy: live.readStrategy,
      log: cfg.log,
    },
    { defindexStrategies: cfg.defindexStrategies },
  );
  if (cfg.depthHistory) {
    const fresh = Object.values(result.snapshots).flatMap(samplesOf);
    try {
      await cfg.depthHistory.save(mergeDepthHistory(past, fresh, result.computedAt));
    } catch (e) {
      cfg.log?.(`depth history not saved: ${(e as Error).message}`);
    }
  }
  if (cfg.utilizationHistory) {
    try {
      await cfg.utilizationHistory.save(mergeUtilizationHistory(pastUtil, Object.values(result.snapshots), result.computedAt));
    } catch (e) {
      cfg.log?.(`utilization history not saved: ${(e as Error).message}`);
    }
  }
  return result;
}

export async function computeLiveRatings(cfg: LiveRatingsConfig): Promise<RatingsJson> {
  return toRatingsJson(await runLiveVigil(cfg));
}
