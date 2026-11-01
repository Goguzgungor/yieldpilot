/**
 * Oracle source attribution (pure — no network).
 *
 * A Blend pool's `oracle` is fixed at deploy time (docs.blend.capital/pool-creators/selecting-an-oracle:
 * "Oracles CANNOT be changed after a pool is created"). It is usually an *aggregator/adapter*
 * (blend-capital/oracle-aggregator or a fork) that routes each asset to a source feed via
 * `asset_configs()` / `oracles()`, or reports a fixed 1.0 for its base and "base-like" assets.
 *
 * The live reader (live.ts) gathers the raw contract facts into {@link ContractInfo} /
 * {@link AggregatorConfig}; the functions here turn those facts into a per-asset
 * {@link AssetPriceSource}. The point is to only treat an asset as SDEX-manipulable when its
 * price really comes from an SDEX-derived feed — a naive "SDEX depth for every collateral"
 * metric false-flags XLM/EURC that are priced from global CEX markets.
 */
import type { AssetKey, AssetPriceSource, OracleSourceKind } from "./types";

/** Facts about an oracle-like contract, as read from chain + Stellar Expert. */
export interface ContractInfo {
  id: string;
  /** Exported function names from the contract WASM spec; null when unreadable. */
  functions: string[] | null;
  creator?: string | null;
  wasmHash?: string | null;
  /** Source repository from Stellar Expert's contract validation, if verified. */
  verifiedRepo?: string | null;
  base?: AssetKey | null;
  admin?: string | null;
  resolutionSec?: number | null;
  /** First few `assets()` entries (used to tell Reflector CEX from FX feeds). */
  assets?: AssetKey[] | null;
  lastTimestamp?: number | null;
}

/** Decoded oracle-aggregator configuration (blend-capital/oracle-aggregator interface). */
export interface AggregatorConfig {
  base: AssetKey;
  maxAgeSec: number;
  decimals: number;
  oracles: { address: string; index: number; resolutionSec: number; decimals: number }[];
  assetConfigs: { asset: AssetKey; sourceAsset: AssetKey; oracleIndex: number; maxDevPct: number }[];
  /** `assets()` = base-like assets ++ configured assets. */
  assets: AssetKey[];
}

export type PoolOracleKind = "blend_aggregator" | "aggregator_compatible" | "direct_feed" | "opaque";

export interface FeedClass {
  kind: OracleSourceKind;
  label: string;
  evidence: string;
}

/** Reflector's mainnet deployer account (creator of both Reflector feeds below, per Stellar Expert). */
export const REFLECTOR_DEPLOYER = "GDLMOS3LF2CRRFCWDJ6TX3YIEYBBTZGAF3BSSEXOXFZWYHSCOHT6DRFX";
/** WASM hash shared by the Reflector mainnet feeds (Stellar Expert contract metadata, 2026-11-01). */
export const REFLECTOR_WASM_HASHES: ReadonlySet<string> = new Set([
  "25fc306065cbb9b05461db78ec259802cb916053ba5b3ab911b0a72dd1a81439",
]);

/** Feeds identified from on-chain reads; see docs/vigil/methodology.md §Data sources. */
export const KNOWN_FEEDS: Readonly<Record<string, FeedClass>> = {
  CALI2BYU2JE6WVRUFYTS6MSBNEHGJ35P4AVCZYF3B6QOE3QKOB2PLE6M: {
    kind: "reflector_dex",
    label: "Reflector Stellar DEX feed",
    evidence:
      "base()=Stellar(USDC SAC CCW67…), assets()=Stellar SAC addresses, resolution()=300, creator GDLMOS3L… (Reflector); the feed BlockSec names in the YieldBlox post-mortem",
  },
  CAFJZQWSED6YAWZU3GWRTOCNPPCGBN32L7QV43XX5LZLFTK6JLN34DLN: {
    kind: "reflector_cex",
    label: "Reflector external CEX/DEX feed",
    evidence: "base()=Other(USD), assets()=Other(BTC,ETH,…,XLM,USDC,EURC), resolution()=300, creator GDLMOS3L… (Reflector)",
  },
};

const FIAT_SYMBOLS: ReadonlySet<string> = new Set([
  "EUR", "GBP", "JPY", "CAD", "CHF", "MXN", "BRL", "ARS", "AUD", "CNY", "KRW", "INR", "TRY", "NGN", "ZAR",
  "SGD", "HKD", "NZD", "SEK", "NOK", "DKK", "PLN", "THB", "IDR", "PHP", "COP", "CLP", "PEN", "UAH", "KES",
]);

export function assetKeyEquals(a: AssetKey | null | undefined, b: AssetKey | null | undefined): boolean {
  if (!a || !b || a.type !== b.type) return false;
  return a.type === "Stellar" ? a.address === (b as { address: string }).address : a.symbol === (b as { symbol: string }).symbol;
}

export function assetKeyLabel(a: AssetKey): string {
  return a.type === "Stellar" ? `Stellar(${a.address.slice(0, 6)}…)` : `Other(${a.symbol})`;
}

export function isAggregatorInterface(fns: string[] | null | undefined): boolean {
  if (!fns) return false;
  return fns.includes("asset_configs") && fns.includes("oracles") && fns.includes("lastprice");
}

/** Classify a price-feed contract (the thing actually producing a price). */
export function classifyFeed(info: ContractInfo): FeedClass {
  const known = KNOWN_FEEDS[info.id];
  if (known) return known;

  const fns = info.functions ?? [];
  const isReflector =
    (info.creator && info.creator === REFLECTOR_DEPLOYER) || (info.wasmHash && REFLECTOR_WASM_HASHES.has(info.wasmHash));
  if (isReflector) {
    if (info.base?.type === "Stellar") {
      return { kind: "reflector_dex", label: "Reflector Stellar DEX feed", evidence: `Reflector deployer/wasm; base()=Stellar(…) ⇒ SDEX-priced` };
    }
    const syms = (info.assets ?? []).filter((a): a is { type: "Other"; symbol: string } => a.type === "Other").map((a) => a.symbol);
    const fiat = syms.filter((s) => FIAT_SYMBOLS.has(s)).length;
    if (syms.length > 0 && fiat / syms.length >= 0.5) {
      return { kind: "reflector_fx", label: "Reflector FX feed", evidence: `Reflector deployer/wasm; base()=Other(USD); assets mostly fiat` };
    }
    return { kind: "reflector_cex", label: "Reflector CEX/DEX feed", evidence: `Reflector deployer/wasm; base()=Other(USD)` };
  }
  if (info.verifiedRepo && /redstone-finance/i.test(info.verifiedRepo)) {
    return { kind: "redstone", label: "RedStone push feed", evidence: `Stellar Expert verified source ${info.verifiedRepo}` };
  }
  if (fns.includes("get_pt") || fns.includes("get_maturity")) {
    return { kind: "protocol_model", label: "PT pricing-model oracle", evidence: "exports get_pt/get_maturity (Spectra-style PT oracle)" };
  }
  if (fns.includes("set_price")) {
    const admin = info.admin ? ` (admin ${info.admin.slice(0, 8)}…)` : "";
    return {
      kind: "issuer_push",
      label: "operator-set push oracle",
      evidence: `non-Reflector deployer${info.creator ? ` ${info.creator.slice(0, 8)}…` : ""}; exports set_price${admin}`,
    };
  }
  return { kind: "opaque", label: "unidentified oracle", evidence: `no known interface${fns.length ? ` (fns: ${fns.slice(0, 6).join(",")}…)` : ""}` };
}

/** Classify the pool's own oracle contract. */
export function classifyPoolOracle(info: ContractInfo): PoolOracleKind {
  if (isAggregatorInterface(info.functions)) {
    return info.verifiedRepo && /oracle-aggregator/i.test(info.verifiedRepo) ? "blend_aggregator" : "aggregator_compatible";
  }
  const c = classifyFeed(info);
  return c.kind === "opaque" ? "opaque" : "direct_feed";
}

export interface AttributionInput {
  poolOracle: ContractInfo;
  oracleKind: PoolOracleKind;
  aggregator?: AggregatorConfig | null;
  /** Facts about the aggregator's source feeds, keyed by contract id. */
  feeds: Record<string, ContractInfo>;
  reserveAssetIds: string[];
  /** assetId → whether the pool oracle returned a usable price. */
  pricePresent: Record<string, boolean>;
  /**
   * For opaque oracles: assetId → known feed whose lastprice matched the opaque oracle's price
   * exactly (same value and timestamp). Produces an `inferred` attribution.
   */
  priceMatches?: Record<string, string | undefined>;
}

/** Attribute every reserve asset of a pool to its price source. */
export function attributeSources(input: AttributionInput): Record<string, AssetPriceSource> {
  const out: Record<string, AssetPriceSource> = {};
  const oracleId = input.poolOracle.id;
  for (const assetId of input.reserveAssetIds) {
    let src = attributeOne(input, assetId, oracleId);
    const fixedByDefinition = src.kind === "base" || src.kind === "fixed_peg";
    if (!input.pricePresent[assetId] && !fixedByDefinition && src.kind !== "missing") {
      src = {
        ...src,
        kind: "missing",
        evidence: `${src.evidence}; but lastprice() on ${short(oracleId)} returned no usable price`,
      };
    }
    out[assetId] = src;
  }
  return out;
}

function attributeOne(input: AttributionInput, assetId: string, oracleId: string): AssetPriceSource {
  const key: AssetKey = { type: "Stellar", address: assetId };
  const agg = input.aggregator;
  if ((input.oracleKind === "blend_aggregator" || input.oracleKind === "aggregator_compatible") && agg) {
    if (assetKeyEquals(agg.base, key)) {
      return { assetId, kind: "base", viaAggregator: true, evidence: `base() of aggregator ${short(oracleId)} — always 1.0` };
    }
    const cfg = agg.assetConfigs.find((c) => assetKeyEquals(c.asset, key));
    if (cfg) {
      const feed = agg.oracles.find((o) => o.index === cfg.oracleIndex);
      if (!feed) {
        return { assetId, kind: "missing", viaAggregator: true, maxDevPct: cfg.maxDevPct, evidence: `asset_configs() oracle_index ${cfg.oracleIndex} not in oracles()` };
      }
      const info = input.feeds[feed.address] ?? { id: feed.address, functions: null };
      const cls = classifyFeed(info);
      return {
        assetId,
        kind: cls.kind,
        sourceOracleId: feed.address,
        viaAggregator: true,
        maxDevPct: cfg.maxDevPct,
        resolutionSec: feed.resolutionSec,
        maxAgeSec: agg.maxAgeSec,
        evidence: `asset_configs() on ${short(oracleId)}: ${assetKeyLabel(cfg.sourceAsset)} via oracle[${cfg.oracleIndex}] ${short(feed.address)} (${cls.label}; ${cls.evidence}), max_dev=${cfg.maxDevPct}%`,
      };
    }
    if (agg.assets.some((a) => assetKeyEquals(a, key))) {
      return {
        assetId,
        kind: "fixed_peg",
        viaAggregator: true,
        maxAgeSec: agg.maxAgeSec,
        evidence: `listed in assets() of ${short(oracleId)} but has no asset_configs() entry ⇒ base-like asset, lastprice() is a fixed 1.0`,
      };
    }
    return { assetId, kind: "missing", viaAggregator: true, evidence: `not configured in aggregator ${short(oracleId)} (lastprice panics AssetNotFound)` };
  }

  if (input.oracleKind === "direct_feed") {
    const cls = classifyFeed(input.poolOracle);
    if (input.poolOracle.base && assetKeyEquals(input.poolOracle.base, key)) {
      return { assetId, kind: "base", viaAggregator: false, sourceOracleId: oracleId, evidence: `base() of ${short(oracleId)}` };
    }
    return {
      assetId,
      kind: cls.kind,
      viaAggregator: false,
      sourceOracleId: oracleId,
      resolutionSec: input.poolOracle.resolutionSec ?? undefined,
      evidence: `pool oracle ${short(oracleId)} is a ${cls.label} (${cls.evidence})`,
    };
  }

  // Opaque adapter: try exact price-match inference.
  const matched = input.priceMatches?.[assetId];
  if (matched) {
    const info = input.feeds[matched] ?? { id: matched, functions: null };
    const cls = classifyFeed(info);
    return {
      assetId,
      kind: cls.kind,
      viaAggregator: true,
      sourceOracleId: matched,
      resolutionSec: info.resolutionSec ?? undefined,
      inferred: true,
      evidence: `opaque adapter ${short(oracleId)} returned exactly the same lastprice (value+timestamp) as ${short(matched)} (${cls.label}) ⇒ inferred source`,
    };
  }
  return { assetId, kind: "opaque", viaAggregator: true, evidence: `pool oracle ${short(oracleId)} exposes no config getters; source unknown` };
}

function short(id: string): string {
  return `${id.slice(0, 6)}…`;
}
