/** Offline fixture builders shared by the vigil unit tests (no network, deterministic). */
import type { AssetPriceSource, BackstopSnapshot, DexDepth, OracleSourceKind, PoolSnapshot, ReserveSnapshot } from "./types";

export const T0 = 1_790_000_000;

/** Deterministic fake C-address: "C" + 55 base32 chars derived from `seed`. */
export function cid(seed: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let h = 2166136261;
  let out = "C";
  for (let i = 0; i < 55; i++) {
    h ^= seed.charCodeAt(i % seed.length) + i;
    h = Math.imul(h, 16777619) >>> 0;
    out += alphabet[h % 32];
  }
  return out;
}

export function src(kind: OracleSourceKind, extra: Partial<AssetPriceSource> = {}): AssetPriceSource {
  return { assetId: "", kind, viaAggregator: true, evidence: "fixture", resolutionSec: 300, ...extra };
}

export function reserve(symbol: string, o: Partial<ReserveSnapshot> = {}): ReserveSnapshot {
  const assetId = o.assetId ?? cid(symbol);
  const r: ReserveSnapshot = {
    assetId,
    symbol,
    decimals: 7,
    cFactor: 0.9,
    lFactor: 0.9,
    maxUtil: 0.9,
    supplyCap: null,
    enabled: true,
    supplied: 1_000_000,
    borrowed: 400_000,
    priceUsd: 1,
    priceTimestamp: T0 - 60,
    source: src("reflector_cex"),
    ...o,
  };
  r.source = { ...r.source, assetId };
  return r;
}

export function backstop(o: Partial<BackstopSnapshot> = {}): BackstopSnapshot {
  return { tokens: 1_000_000, shares: 1_000_000, q4wPct: 0, blnd: 4_000_000, usdc: 200_000, meetsThreshold: true, ...o };
}

export function depth(assetId: string, asks: [number, number][], truncated = false): DexDepth {
  return { assetId, quote: "USDC", asks: asks.map(([price, amount]) => ({ price, amount })), truncated, source: "fixture" };
}

/** A healthy, active, CEX-priced pool (should grade A and be eligible). */
export function healthyPool(o: Partial<PoolSnapshot> = {}): PoolSnapshot {
  return {
    poolId: cid("healthy-pool"),
    name: "Healthy",
    protocol: "blend",
    status: 1,
    admin: "GADMIN",
    oracleId: cid("oracle"),
    oracleKind: "blend_aggregator",
    backstopRate: 0.2,
    reserves: [
      reserve("USDC", { source: src("base"), supplied: 2_000_000, borrowed: 900_000, cFactor: 0.95, lFactor: 0.95 }),
      reserve("XLM", { priceUsd: 0.2, supplied: 10_000_000, borrowed: 1_000_000, cFactor: 0.75, lFactor: 0.75, maxUtil: 0.7 }),
      reserve("EURC", { priceUsd: 1.1, supplied: 1_000_000, borrowed: 300_000 }),
    ],
    backstop: backstop(),
    dexDepth: {},
    asOf: { timestamp: T0 },
    dataGaps: [],
    ...o,
  };
}
