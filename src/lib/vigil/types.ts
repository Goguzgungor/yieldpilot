/**
 * Vigil risk engine v2 — shared data shapes.
 *
 * Everything the scorer consumes is a plain, JSON-serialisable snapshot so that
 * (a) tests can build fixtures without any network access and (b) the exact
 * inputs behind a rating can be hashed (`reasonsHash`) and re-checked later.
 *
 * Units: token amounts are whole tokens (float, already divided by 10^decimals);
 * prices and values are USD floats (USDC is treated as 1 USD-equivalent quote);
 * times are unix seconds.
 */

/** SEP-40 / oracle-aggregator asset key. */
export type AssetKey = { type: "Stellar"; address: string } | { type: "Other"; symbol: string };

/**
 * Where a collateral/reserve asset's price actually comes from.
 *
 * Only `reflector_dex` and `sdex_other` are priced from Stellar DEX trading, so
 * only those are run through the SDEX manipulation model.
 */
export type OracleSourceKind =
  | "base" // the aggregator's own base asset: price is 1 by definition
  | "fixed_peg" // aggregator "base-like" asset: always reports 1.0, ignores the market
  | "reflector_cex" // Reflector external CEX/DEX aggregate feed (Other(symbol) assets, USD base)
  | "reflector_fx" // Reflector fiat FX feed
  | "reflector_dex" // Reflector Stellar-DEX feed (Stellar(address) assets, USDC base) — SDEX-derived
  | "sdex_other" // some other feed known to derive prices from SDEX trades
  | "redstone" // RedStone push feed
  | "issuer_push" // push oracle whose price is set by an operator key (issuer / pool admin)
  | "protocol_model" // a pricing model contract (e.g. Spectra PT accretion oracle)
  | "opaque" // could not determine the source
  | "missing"; // oracle returned no usable price

export const SDEX_PRICED_KINDS: ReadonlySet<OracleSourceKind> = new Set(["reflector_dex", "sdex_other"]);

export interface AssetPriceSource {
  assetId: string;
  kind: OracleSourceKind;
  /** The feed contract the price ultimately comes from (aggregator's source oracle, or the pool oracle itself). */
  sourceOracleId?: string;
  /** True when the pool oracle is an aggregator/adapter in front of `sourceOracleId`. */
  viaAggregator: boolean;
  /** Aggregator `max_dev` (percent, 0 = no deviation check). Undefined when not applicable / unknown. */
  maxDevPct?: number;
  /** Source feed resolution (seconds between rounds), when known. */
  resolutionSec?: number;
  /** Aggregator `max_age` (seconds), when known. */
  maxAgeSec?: number;
  /** True when the attribution was inferred (e.g. by exact price match) rather than read from config. */
  inferred?: boolean;
  /** Human-readable provenance of the attribution (which call / which config entry). */
  evidence: string;
}

export interface ReserveSnapshot {
  assetId: string;
  symbol: string;
  /** Classic asset behind the SAC, used for Horizon order-book lookups. */
  classic?: { code: string; issuer: string } | { native: true };
  decimals: number;
  cFactor: number; // 0..1
  lFactor: number; // 0..1
  maxUtil: number; // 0..1
  /** Supply cap in whole tokens. `null` = effectively uncapped. */
  supplyCap: number | null;
  enabled: boolean;
  supplied: number; // whole tokens
  borrowed: number; // whole tokens
  priceUsd: number | null;
  /** Oracle price timestamp (unix seconds), null when no price. */
  priceTimestamp: number | null;
  source: AssetPriceSource;
  /**
   * Current supply / borrow APR (0..1) from the Blend SDK. Informational: not a
   * risk input and not hashed into reasonsHash.
   */
  supplyApr?: number | null;
  borrowApr?: number | null;
}

export interface BackstopSnapshot {
  /** Backstop LP tokens credited to this pool. */
  tokens: number;
  shares: number;
  /** Fraction of shares queued for withdrawal, 0..1. */
  q4wPct: number;
  /** Underlying BLND / USDC behind this pool's backstop tokens (backstop `pool_data`). */
  blnd: number;
  usdc: number;
  /** Blend v2 backstop threshold: blnd^4 * usdc >= (100k)^5 (pool/src/pool/status.rs). */
  meetsThreshold: boolean;
}

/** One ask level: `amount` units of the asset offered at `price` USDC each. */
export interface AskLevel {
  price: number;
  amount: number;
}

export interface DexDepth {
  assetId: string;
  quote: "USDC";
  /** Asks sorted ascending by price. */
  asks: AskLevel[];
  /** True when the venue returned its max page of levels — deeper liquidity was not observed. */
  truncated: boolean;
  source: string; // e.g. "horizon /order_book"
}

export interface PoolSnapshot {
  poolId: string;
  name: string;
  protocol: "blend";
  status: number;
  admin: string;
  oracleId: string;
  /** What kind of contract the pool oracle is. */
  oracleKind: "blend_aggregator" | "aggregator_compatible" | "direct_feed" | "opaque";
  backstopRate: number; // 0..1
  reserves: ReserveSnapshot[];
  backstop: BackstopSnapshot | null;
  /** SDEX depth, only fetched for SDEX-priced collateral assets (keyed by assetId). */
  dexDepth: Record<string, DexDepth>;
  /** Chain time the snapshot was taken at. */
  asOf: { timestamp: number; ledger?: number };
  /** Inputs that could not be read; each becomes a reason on the rating. */
  dataGaps: string[];
  /** Free-form provenance label, e.g. "live mainnet" or "RECONSTRUCTION". */
  provenance?: string;
}

export interface RatingFactor {
  key: string;
  /** Factor sub-score, 0..100 (higher = safer). */
  value: number;
  weight: number;
  /** value * weight (points out of 100). */
  contribution: number;
  /** The measured quantity behind the sub-score (e.g. coverage ratio, rho). */
  raw?: number | string | null;
  note: string;
}

export type Grade = "A" | "B" | "C" | "D" | "E";

/** What a reserve pays right now — shown next to the rating, never part of it. */
export interface ReserveYield {
  assetId: string;
  symbol: string;
  /** 0..1 */
  supplyApr: number;
  /** 0..1, null when unknown */
  borrowApr: number | null;
  /** Supplied value in USD, null when the reserve has no price. */
  suppliedUsd: number | null;
}

export interface PoolRating {
  poolId: string;
  name: string;
  protocol: "blend" | "defindex";
  /** 0..100, HIGHER = SAFER. */
  score: number;
  /** Weighted factor score before hard-rule caps (same scale). */
  uncappedScore?: number;
  grade: Grade;
  /** Blend pool status code (0..6). For DeFindex: worst status of the underlying pools. */
  status: number;
  statusLabel: string;
  eligibleForDeposit: boolean;
  factors: RatingFactor[];
  reasons: string[];
  /** Hard rules that capped the score / blocked eligibility. */
  hardRules: string[];
  tvlUsd: number;
  /** Unix seconds. Not part of reasonsHash. */
  computedAt: number;
  /** sha256 hex of canonical JSON of {engineVersion, inputs, factors, hardRules, score, grade, eligible}. */
  reasonsHash: string;
  engineVersion: string;
  /** DeFindex: underlying Blend pool ids the rating was derived from. */
  underlying?: string[];
  /** Current rates of the enabled reserves (DeFindex: the strategy's asset), highest supply rate first. */
  yields?: ReserveYield[];
}
