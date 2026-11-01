/**
 * Live (mainnet, read-only) wiring of the Vigil engine, shared by
 * scripts/vigil-ratings.ts and the /api/ratings route. A full run reads every
 * pool of every Blend deployment + the configured DeFindex strategies (~90 s),
 * so callers cache the result (see runtime.ts `getRatings`).
 */
import { createBlendOnchainPoolSource } from "../discovery";
import { functionSource, stellarExpertDeploySource } from "./discovery";
import { runVigil, toRatingsJson, type DefindexStrategyRef, type EngineResult } from "./engine";
import { createLiveReaders, type BlendDeployment } from "./live";

export type { BlendDeployment };

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
  return runVigil(
    {
      sources,
      verifier: live.verifier,
      fallbackPoolIds: cfg.curatedPoolIds,
      snapshot: live.snapshot,
      readStrategy: live.readStrategy,
      log: cfg.log,
    },
    { defindexStrategies: cfg.defindexStrategies },
  );
}

export async function computeLiveRatings(cfg: LiveRatingsConfig): Promise<RatingsJson> {
  return toRatingsJson(await runLiveVigil(cfg));
}
