/**
 * Live (mainnet, read-only) wiring of the Vigil engine, shared by
 * scripts/vigil-ratings.ts and the /api/ratings route. A full run reads every
 * pool of every Blend deployment + the configured DeFindex strategies (~90 s),
 * so callers cache the result (see runtime.ts `getRatings`).
 */
import { scanFactoryDeploys } from "../discovery";
import { createRpcServer } from "../rpcServer";
import { historyFor, mergeDepthHistory, samplesOf, type DepthHistory, type DepthHistoryStore } from "./depthHistory";
import {
  deployEventsSource,
  functionSource,
  knownPoolsSource,
  mergeKnownPools,
  nextKnownPools,
  stellarExpertDeploySource,
  type KnownPoolsStore,
} from "./discovery";
import { runVigil, toRatingsJson, type DefindexStrategyRef, type EngineResult } from "./engine";
import { createLiveReaders, type BlendDeployment } from "./live";
import { mergeUtilizationHistory, utilizationHistoryFor, type UtilizationHistory, type UtilizationHistoryStore } from "./utilizationHistory";

export type { BlendDeployment, DepthHistoryStore, KnownPoolsStore, UtilizationHistoryStore };

export interface LiveRatingsConfig {
  rpcUrl: string;
  passphrase: string;
  /** Every Blend deployment to enumerate (pool factory + its backstop). */
  deployments: BlendDeployment[];
  /** Curated pool ids, added to whatever discovery finds. */
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
  /**
   * Where the pools found so far are kept, with the ledger that list is
   * complete to. Without one, every run starts from the built-in list
   * (KNOWN_BLEND_POOLS) and can only add what the RPC's 7 days of events show.
   */
  knownPools?: KnownPoolsStore;
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
  // The pools known so far, and the ledger that list is complete to.
  let stored = null;
  if (cfg.knownPools) {
    try {
      stored = await cfg.knownPools.load();
    } catch (e) {
      cfg.log?.(`known pools unavailable, starting from the built-in list: ${(e as Error).message}`);
    }
  }
  const known = mergeKnownPools(stored);
  // Per deployment: the factory's deploy events since that ledger (RPC), its
  // backstop reward zone, and its whole deploy history from the indexer when
  // the indexer answers. Then the known pools themselves.
  const rpcServer = createRpcServer(cfg.rpcUrl);
  const sources = [
    ...cfg.deployments.flatMap((dep) => {
      const deploys = stellarExpertDeploySource({ factoryId: dep.factoryId, fetchJson: live.indexerJson });
      return [
        deployEventsSource({
          scope: dep.name,
          known,
          scan: (fromLedger) => scanFactoryDeploys(rpcServer, dep.factoryId, { fromLedger }),
        }),
        { ...deploys, name: `${deploys.name}:${dep.name}`, scope: dep.name },
        functionSource(`rpc:backstop-reward-zone:${dep.name}`, () => live.rewardZone(dep.backstopId)),
      ];
    }),
    knownPoolsSource(known),
  ];
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
  const startedAt = Date.now();
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
  cfg.log?.(`run done in ${Math.round((Date.now() - startedAt) / 1000)} s: ${result.pools.length} pools, ${result.failures.length} failed`);
  if (cfg.knownPools) {
    const next = nextKnownPools(known, result.discovery);
    const changed = next.syncedLedger !== stored?.syncedLedger || next.ids.length !== stored?.ids.length;
    if (changed) {
      try {
        await cfg.knownPools.save(next);
      } catch (e) {
        cfg.log?.(`known pools not saved: ${(e as Error).message}`);
      }
    }
  }
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
