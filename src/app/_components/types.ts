// Client-side mirrors of the API JSON shapes (BigInts already rendered as
// strings by the route serializers). Kept local to the UI so the client bundle
// never imports server-only lib modules.

export interface ApiScoredPool {
  protocol: string; // yield source, e.g. "blend" | "defindex"
  poolId: string;
  name: string;
  asset: string;
  apyBps: number;
  tvlUsdc: string; // stroops, decimal string
  utilizationBps: number;
  oracleHealthy: boolean;
  riskScore: number; // 0..100
  eligible: boolean;
  reason?: string;
}

/** Shape returned by /api/scan */
export interface ApiScanResponse {
  pools: ApiScoredPool[];
  /** Epoch-ms timestamp of the last persisted scan; null on a true cold start. */
  updatedAt: number | null;
  /** Epoch-ms when the next agent tick is due; null if unknown. */
  nextTickAt: number | null;
  /** Max risk score an eligible pool may have under the configured tolerance. */
  riskCap: number;
}

export interface ApiPosition {
  poolId: string | null;
  amountUsdc: string; // stroops, decimal string
  chosenPoolId: string | null;
  rationale: string;
  action: "hold" | "rebalance";
}

export interface ApiDecision {
  action: "hold" | "rebalance";
  chosenPoolId: string | null;
  rationale: string;
}

export interface ActivityEntry {
  ts: number;
  kind: string;
  message: string;
  meta: string | null;
}

export interface SsePayload {
  position: { poolId: string | null; amountUsdc: string };
  decision: ApiDecision;
  log: ActivityEntry[];
}
