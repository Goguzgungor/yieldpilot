/**
 * Live (mainnet, read-only) wiring of the Vigil engine, shared by
 * scripts/vigil-ratings.ts and the /api/ratings route. A full run reads every
 * Blend V2 pool + the configured DeFindex strategies (~90 s), so callers cache
 * the result (see runtime.ts `getRatings`).
 */
import { createBlendOnchainPoolSource } from "../discovery";
import { functionSource, stellarExpertDeploySource } from "./discovery";
import { runVigil, toRatingsJson, type DefindexStrategyRef, type EngineResult } from "./engine";
import { createLiveReaders } from "./live";

export interface LiveRatingsConfig {
  rpcUrl: string;
  passphrase: string;
  factoryId: string;
  backstopId: string;
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
    backstopId: cfg.backstopId,
    factoryId: cfg.factoryId,
    callDelayMs: cfg.callDelayMs ?? 120,
  });
  const rpcSource = createBlendOnchainPoolSource({
    rpcUrl: cfg.rpcUrl,
    networkPassphrase: cfg.passphrase,
    backstopId: cfg.backstopId,
    factoryId: cfg.factoryId,
  });
  return runVigil(
    {
      sources: [
        stellarExpertDeploySource({ factoryId: cfg.factoryId, fetchJson: live.fetchJson }),
        functionSource("rpc:backstop-reward-zone+recent-deploy-events", () => rpcSource.listPools()),
      ],
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
