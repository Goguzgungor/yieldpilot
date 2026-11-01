/**
 * Client for the public ratings API (`GET /api/ratings` on a Vigil deployment).
 * The shape mirrors the engine's `PoolRating` (src/lib/vigil in the app).
 */
export interface RatingFactor {
  key: string;
  value: number | string | null;
  weight: number;
  contribution: number;
  note: string;
}

export interface PoolRating {
  poolId: string;
  name: string;
  protocol: string;
  /** 0..100, higher = safer. */
  score: number;
  grade: "A" | "B" | "C" | "D" | "E";
  status: number | null;
  eligibleForDeposit: boolean;
  factors: RatingFactor[];
  reasons: string[];
  tvlUsd: number | null;
  computedAt: string;
  /** sha256 hex of the canonical inputs+factors — the value published on-chain. */
  reasonsHash: string;
}

export interface RatingsResponse {
  ratings: PoolRating[];
  computedAt: string;
  methodology: string;
}

export async function fetchRatings(baseUrl: string, init?: RequestInit): Promise<RatingsResponse> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/ratings`, init);
  if (!res.ok) throw new Error(`ratings API HTTP ${res.status}`);
  return (await res.json()) as RatingsResponse;
}
