import type { Position, ScoredPool } from "./types";

/**
 * JSON-safe shape of a {@link Position}: the BigInt `amountUsdc` (stroops) is
 * rendered as a decimal string so it survives `JSON.stringify` (BigInt is not
 * natively serializable). Preserves the behaviour of the old Fastify
 * `GET /position` handler.
 */
export interface SerializedPosition {
  poolId: string | null;
  amountUsdc: string;
}

export function serializePosition(p: Position): SerializedPosition {
  return { poolId: p.poolId, amountUsdc: p.amountUsdc.toString() };
}

/**
 * JSON-safe shape of a {@link ScoredPool}: identical to {@link ScoredPool}
 * except the BigInt `tvlUsdc` (stroops) is rendered as a decimal string. The UI
 * reads APY/TVL/utilisation/risk/eligibility straight off these objects.
 */
export interface SerializedScoredPool {
  protocol: string;
  poolId: string;
  name: string;
  asset: string;
  apyBps: number;
  tvlUsdc: string;
  utilizationBps: number;
  oracleHealthy: boolean;
  poolStatus?: number;
  riskScore: number;
  eligible: boolean;
  reason?: string;
}

export function serializeScoredPool(p: ScoredPool): SerializedScoredPool {
  return { ...p, tvlUsdc: p.tvlUsdc.toString() };
}

export function serializeScoredPools(pools: ScoredPool[]): SerializedScoredPool[] {
  return pools.map(serializeScoredPool);
}
