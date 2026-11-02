/**
 * Vigil risk engine — pool scoring (pure, deterministic). Version history: docs/vigil/methodology.md.
 *
 * score: 0..100, HIGHER = SAFER. Weighted sum of factor sub-scores (each 0..100), then hard
 * rules cap the score and/or block deposit eligibility. All weights live in {@link WEIGHTS};
 * the rationale for each lives in {@link WEIGHT_RATIONALE} and docs/vigil/methodology.md.
 */
import { sha256Canonical } from "./canonical";
import { assessManipulation, DEFAULT_MANIPULATION_PARAMS, type ManipulationParams, type ManipulationResult } from "./manipulation";
import {
  SDEX_PRICED_KINDS,
  type Grade,
  type OracleSourceKind,
  type RatingGrade,
  type PoolRating,
  type PoolSnapshot,
  type RatingFactor,
  type ReserveSnapshot,
  type ReserveYield,
  type DexDepth,
  type DexDepthSample,
} from "./types";

export const ENGINE_VERSION = "vigil-risk-v2.5.0";

/**
 * Factor weights (sum = 1). v2.1 dropped the pool_status factor: Blend's
 * On_Ice / Frozen status is its reaction to the backstop and withdrawal queue,
 * which backstop_coverage already measures. Status is reported next to the
 * grade and decides whether deposits are possible (HR1), not the grade itself.
 */
export const WEIGHTS = {
  oracle_source: 0.18,
  oracle_freshness: 0.12,
  sdex_manipulation: 0.23,
  backstop_coverage: 0.18,
  utilization: 0.12,
  supply_caps: 0.12,
  collateral_concentration: 0.05,
} as const;

export type FactorKey = keyof typeof WEIGHTS;

export const WEIGHT_RATIONALE: Record<FactorKey, string> = {
  oracle_source:
    "Every borrow is valued by the oracle; a lending pool is only as sound as its weakest collateral price (YieldBlox lost ~$10M to one mispriced collateral).",
  oracle_freshness:
    "A stale/missing collateral price blocks liquidations, letting bad debt accrue silently.",
  sdex_manipulation:
    "The one failure mode that has actually drained a Blend pool on Stellar: SDEX-priced collateral cheap to pump relative to what it can borrow.",
  backstop_coverage:
    "The backstop is the first-loss capital that absorbs bad debt before lenders do.",
  utilization: "High utilization means lenders may not be able to withdraw and bad debt hits a larger share of supply.",
  supply_caps: "Caps bound how much borrow power a weakly-priced collateral can create.",
  collateral_concentration: "Collateral concentrated in one asset concentrates tail risk; kept small to avoid double-counting oracle factors.",
};

/** Oracle source quality, 0..100. */
export const SOURCE_QUALITY: Record<OracleSourceKind, number> = {
  base: 100,
  reflector_cex: 95,
  reflector_fx: 95,
  redstone: 85,
  fixed_peg: 60,
  reflector_dex: 60,
  sdex_other: 50,
  protocol_model: 50,
  issuer_push: 45,
  opaque: 25,
  missing: 0,
};
/** Extra deductions applied to the source-quality sub-score. */
export const SOURCE_DEDUCTIONS = { noMaxDevOnMarketFeed: 10, inferredAttribution: 10 } as const;

/** Sources that cannot be moved by SDEX trading and whose caps we do not penalise. */
export const ROBUST_KINDS: ReadonlySet<OracleSourceKind> = new Set(["base", "reflector_cex", "reflector_fx", "redstone"]);

export const STATUS_LABELS: Record<number, string> = {
  0: "Admin_Active",
  1: "Active",
  2: "Admin_On_Ice",
  3: "On_Ice",
  4: "Admin_Frozen",
  5: "Frozen",
  6: "Setup",
};

export const GRADE_BANDS: ReadonlyArray<readonly [number, Grade]> = [
  [80, "A"],
  [65, "B"],
  [50, "C"],
  [35, "D"],
  [0, "E"],
];

export const HARD_CAPS = {
  /** backstop below Blend's threshold, or ≥30% of it queued to leave ⇒ grade ≤ B */
  uninsured: 79,
  /** borrowed against with under THRESHOLDS.minFirstLossCoverage of first-loss capital ⇒ grade ≤ C */
  noFirstLossCapital: 64,
  /** collateral with stale/missing price ⇒ grade ≤ D */
  collateralPriceUnavailable: 49,
  /** SDEX-priced collateral with a profitable manipulation (rho < 1) ⇒ grade E */
  sdexManipulable: 34,
  /** collateral whose price source cannot be identified ⇒ grade ≤ C, not eligible */
  unverifiableCollateralSource: 64,
  /** any collateral priced below THRESHOLDS.robustSourceQuality ⇒ grade ≤ B (an A needs robust feeds) */
  weakCollateralSource: 79,
  /** a reserve borrowed to or past its own max_util, so its lenders can withdraw only what is not borrowed ⇒ grade ≤ C, not eligible */
  lendersLockedIn: 64,
} as const;

export const THRESHOLDS = {
  /** Reserves with c_factor below this are not treated as collateral (e.g. Forex pool's 1e-7). */
  minCollateralFactor: 0.01,
  /** Price older than max(this, 2×resolution) is stale... */
  staleFloorSec: 3600,
  /** ...capped at Blend's own hard limit (pool.rs load_price: timestamp + 24h). */
  blendMaxPriceAgeSec: 86_400,
  utilizationFull: 0.6,
  utilizationZero: 0.95,
  /** Effective backstop / liabilities giving full marks. */
  backstopFullCoverage: 0.1,
  /**
   * Share of the backstop queued for withdrawal at which Blend's update_status
   * puts an Active pool On_Ice (pool/src/pool/status.rs). Past it the backstop
   * is leaving, so it is not counted as reliable first-loss capital (HR7).
   */
  backstopQueueOnIce: 0.3,
  /**
   * Queue share at which update_status FREEZES a pool (status.rs): 60% for an
   * Active or On_Ice pool, 75% for an Admin_On_Ice one. Anyone can make that
   * call, so such a pool is one transaction from refusing deposits (HR8).
   */
  backstopQueueFrozen: 0.6,
  adminOnIceQueueFrozen: 0.75,
  /**
   * Effective backstop / liabilities under which lenders have no first-loss
   * capital in front of them: a bad debt of 1% of the borrows already exceeds
   * the backstop (HR9).
   */
  minFirstLossCoverage: 0.01,
  /** sourceQuality at or above this is a robust price source (RedStone = 85, Reflector CEX/FX = 95). */
  robustSourceQuality: 85,
  /** Below this many USD of liabilities the pool has nothing at risk. */
  minLiabilitiesUsd: 1_000,
  /** Below this much borrowable liquidity there is nothing to drain. */
  minLiquidityUsd: 1_000,
  /**
   * Below this much supplied (USD) a pool is not rated (NR): its utilization,
   * backstop cover and manipulation economics are set by a few dust positions,
   * and a high score would only say that nothing is there.
   */
  minRatedTvlUsd: 10_000,
  /**
   * The manipulation factor uses the thinnest SDEX book seen over this window,
   * not one read, so a rating does not flip as asks come and go (v2.3).
   */
  depthWindowSec: 86_400,
  /**
   * HR10 holds while any read of a reserve in this window was at or past its
   * max_util, so a pool hovering at the line does not flip run by run (v2.5).
   */
  lockWindowSec: 6 * 3600,
  /** Comet backstop token is 80/20 BLND/USDC ⇒ spot value = 5 × USDC (backstop/src/backstop/pool.rs). */
  cometUsdcMultiplier: 5,
} as const;

export interface RateOptions {
  /** Unix seconds used as computedAt (defaults to snapshot.asOf.timestamp). */
  now?: number;
  manipulation?: ManipulationParams;
}

export function gradeFor(score: number): Grade {
  for (const [min, g] of GRADE_BANDS) if (score >= min) return g;
  return "E";
}

const clamp = (x: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, x));
const fmtUsd = (n: number) =>
  !Number.isFinite(n) ? "∞" : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(2)}`;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export interface Derived {
  r: ReserveSnapshot;
  priced: boolean;
  suppliedUsd: number;
  borrowedUsd: number;
  availableUsd: number;
  isCollateral: boolean;
  isBorrowable: boolean;
}

export function derive(s: PoolSnapshot): Derived[] {
  return s.reserves.map((r) => {
    const priced = r.priceUsd !== null && Number.isFinite(r.priceUsd) && r.priceUsd > 0;
    const p = priced ? (r.priceUsd as number) : 0;
    const isBorrowable = r.enabled && r.lFactor > 0;
    return {
      r,
      priced,
      suppliedUsd: r.supplied * p,
      borrowedUsd: r.borrowed * p,
      availableUsd: isBorrowable && priced ? Math.max(0, r.supplied * r.maxUtil - r.borrowed) * p : 0,
      isCollateral: r.enabled && r.cFactor >= THRESHOLDS.minCollateralFactor,
      isBorrowable,
    };
  });
}

type FactorCalc = { value: number; raw?: number | string | null; note: string };

function factor(key: FactorKey, c: FactorCalc): RatingFactor {
  const value = Math.round(clamp(c.value) * 10) / 10;
  const weight = WEIGHTS[key];
  return { key, value, weight, contribution: Math.round(value * weight * 100) / 100, raw: c.raw ?? null, note: c.note };
}

// ── individual factors (exported for unit tests) ─────────────────────────────

export function sourceQuality(r: ReserveSnapshot): number {
  let q = SOURCE_QUALITY[r.source.kind];
  const marketFeed = r.source.kind === "reflector_dex" || r.source.kind === "reflector_cex" || r.source.kind === "sdex_other";
  if (marketFeed && r.source.viaAggregator && r.source.maxDevPct === 0) q -= SOURCE_DEDUCTIONS.noMaxDevOnMarketFeed;
  if (r.source.inferred) q -= SOURCE_DEDUCTIONS.inferredAttribution;
  return clamp(q);
}

export function oracleSourceFactor(d: Derived[]): FactorCalc {
  const coll = d.filter((x) => x.isCollateral);
  if (!coll.length) return { value: 100, note: "no collateral reserves (nothing can be borrowed against)" };
  let worst = coll[0];
  for (const x of coll) if (sourceQuality(x.r) < sourceQuality(worst.r)) worst = x;
  const q = sourceQuality(worst.r);
  const s = worst.r.source;
  const md = s.maxDevPct === undefined ? "" : `, max_dev=${s.maxDevPct}%`;
  return {
    value: q,
    raw: s.kind,
    note: `weakest collateral price source: ${worst.r.symbol} ← ${s.kind}${s.inferred ? " (inferred)" : ""}${md}`,
  };
}

export function staleAfterSec(r: ReserveSnapshot): number {
  const res = r.source.resolutionSec ?? 0;
  return Math.min(THRESHOLDS.blendMaxPriceAgeSec, Math.max(THRESHOLDS.staleFloorSec, 2 * res));
}

export function priceProblem(r: ReserveSnapshot, nowSec: number): "missing" | "stale" | null {
  if (r.source.kind === "base" || r.source.kind === "fixed_peg") return r.priceUsd === null ? "missing" : null;
  if (r.source.kind === "missing" || r.priceUsd === null || !(r.priceUsd > 0) || r.priceTimestamp === null) return "missing";
  const age = Math.max(0, nowSec - r.priceTimestamp);
  return age > staleAfterSec(r) ? "stale" : null;
}

/**
 * A stale or missing price on collateral, or on an asset someone has borrowed,
 * blocks Blend's health check: the positions holding it can be neither
 * liquidated nor valued, and an unpriced debt also counts as $0 in every USD
 * total (liabilities, utilization), which would make the pool look safer.
 */
export function oracleFreshnessFactor(d: Derived[], nowSec: number): FactorCalc & { priceProblems: string[] } {
  const priceProblems: string[] = [];
  for (const x of d) {
    if (!x.isCollateral && x.r.borrowed <= 0) continue;
    const p = priceProblem(x.r, nowSec);
    if (!p) continue;
    const age = x.r.priceTimestamp !== null ? ` (age ${Math.max(0, nowSec - x.r.priceTimestamp)}s)` : "";
    priceProblems.push(`${x.r.symbol}${x.isCollateral ? "" : " (borrowed)"}: ${p}${age}`);
  }
  if (priceProblems.length) return { value: 0, raw: priceProblems.length, note: `price ${priceProblems.join("; ")}`, priceProblems };
  return { value: 100, raw: 0, note: "all collateral / borrowed-asset prices fresh", priceProblems };
}

export function rhoToScore(rho: number | null, lowerBound: boolean): number {
  if (rho === null) return 100;
  if (lowerBound && rho < 1) return 50;
  return clamp(50 + 50 * Math.log10(Math.max(rho, 1e-12)));
}

export interface ManipulationAssessment {
  assetId: string;
  symbol: string;
  result: ManipulationResult | null;
  score: number;
  note: string;
}

/**
 * A past book rescaled to today's price: each level keeps its USD size and its
 * distance from the price, so pushing the price ×M costs what it would have
 * cost then.
 */
export function rescaleSample(sample: DexDepthSample, priceUsd: number): DexDepth {
  const k = priceUsd / sample.refPriceUsd;
  if (!(k > 0) || !Number.isFinite(k)) return sample;
  return { ...sample, asks: sample.asks.map((a) => ({ price: a.price * k, amount: a.amount / k })) };
}

/** The current book plus the earlier books still inside the window, oldest first. */
function booksInWindow(s: PoolSnapshot, assetId: string, priceUsd: number): { depth: DexDepth; at: number }[] {
  const from = s.asOf.timestamp - THRESHOLDS.depthWindowSec;
  const past = (s.dexDepthHistory?.[assetId] ?? [])
    .filter((x) => x.sampledAt >= from && x.sampledAt < s.asOf.timestamp && x.refPriceUsd > 0)
    .sort((a, b) => a.sampledAt - b.sampledAt)
    .map((x) => ({ depth: rescaleSample(x, priceUsd), at: x.sampledAt }));
  const now = s.dexDepth[assetId];
  return now ? [...past, { depth: now, at: s.asOf.timestamp }] : past;
}

const utcTime = (t: number) => new Date(t * 1000).toISOString().slice(11, 16);

export function assessSdexCollateral(
  s: PoolSnapshot,
  d: Derived[],
  params: ManipulationParams = DEFAULT_MANIPULATION_PARAMS,
): ManipulationAssessment[] {
  const out: ManipulationAssessment[] = [];
  for (const x of d) {
    if (x.isCollateral && x.priced && x.r.source.kind === "opaque") {
      out.push({ assetId: x.r.assetId, symbol: x.r.symbol, result: null, score: 50, note: `${x.r.symbol}: price source unidentified — SDEX manipulation cannot be ruled out` });
      continue;
    }
    if (!x.isCollateral || !SDEX_PRICED_KINDS.has(x.r.source.kind) || !x.priced) continue;
    const books = booksInWindow(s, x.r.assetId, x.r.priceUsd as number);
    if (!books.length) {
      out.push({ assetId: x.r.assetId, symbol: x.r.symbol, result: null, score: 50, note: `${x.r.symbol}: SDEX-priced but order book unavailable` });
      continue;
    }
    const others = d.filter((o) => o !== x && o.isBorrowable && o.availableUsd > 0);
    const availableUsd = others.reduce((a, o) => a + o.availableUsd, 0);
    const avgLFactor = availableUsd > 0 ? others.reduce((a, o) => a + o.availableUsd * o.r.lFactor, 0) / availableUsd : 0;
    // The thinnest book in the window sets the factor; on a tie the latest one.
    let worst: { result: ManipulationResult; score: number; at: number } | null = null;
    for (const b of books) {
      const result = assessManipulation(
        {
          priceUsd: x.r.priceUsd as number,
          cFactor: x.r.cFactor,
          capHeadroomTokens: x.r.supplyCap === null ? null : Math.max(0, x.r.supplyCap - x.r.supplied),
          availableUsd,
          avgLFactor,
          depth: b.depth,
          maxDevPct: x.r.source.maxDevPct,
          resolutionSec: x.r.source.resolutionSec,
        },
        params,
      );
      const score = rhoToScore(result.rho, result.costIsLowerBound);
      const worse =
        !worst ||
        score < worst.score ||
        (score === worst.score && (result.rho ?? Infinity) <= (worst.result.rho ?? Infinity));
      if (worse) worst = { result, score, at: b.at };
    }
    const { result, score, at } = worst!;
    const window =
      books.length > 1
        ? `; thinnest of ${books.length} books in ${THRESHOLDS.depthWindowSec / 3600} h${at === s.asOf.timestamp ? " (the current one)" : `, read ${utcTime(at)} UTC`}`
        : "";
    const note =
      result.rho === null
        ? `${x.r.symbol}: no profitable leverage (nothing borrowable or c_factor too low)`
        : `${x.r.symbol}: pump ×${result.multiplier} costs ${fmtUsd(result.manipulationCostUsd)} on SDEX${
            result.costIsLowerBound ? " (lower bound, book truncated)" : ""
          } + ${fmtUsd(result.collateralCostUsd)} collateral to borrow ${fmtUsd(result.extractableUsd)} (rho=${result.rho.toPrecision(3)}; hold ${result.roundsToHold} round${
            result.roundsToHold > 1 ? "s" : ""
          }${result.minHoldSeconds ? ` ≈${result.minHoldSeconds}s` : ""}, max_dev=${x.r.source.maxDevPct === undefined ? "unknown" : `${x.r.source.maxDevPct}%`}${window})`;
    out.push({ assetId: x.r.assetId, symbol: x.r.symbol, result, score, note });
  }
  return out;
}

export function manipulationFactor(assessments: ManipulationAssessment[]): FactorCalc {
  if (!assessments.length) return { value: 100, raw: null, note: "no SDEX-priced collateral (CEX/FX/peg/push-priced assets are not SDEX-manipulable)" };
  let worst = assessments[0];
  for (const a of assessments) if (a.score < worst.score) worst = a;
  return { value: worst.score, raw: worst.result?.rho ?? null, note: worst.note };
}

export function backstopFactor(s: PoolSnapshot, d: Derived[]): FactorCalc {
  const b = s.backstop;
  if (!b) return { value: 0, raw: null, note: "backstop data unavailable" };
  const insuranceUsd = b.usdc * THRESHOLDS.cometUsdcMultiplier;
  const effective = insuranceUsd * (1 - clamp(b.q4wPct, 0, 1));
  const liabilities = d.reduce((a, x) => a + x.borrowedUsd, 0);
  const thr = b.meetsThreshold ? "meets" : "below";
  if (liabilities < THRESHOLDS.minLiabilitiesUsd) {
    return {
      value: effective > 0 ? 100 : 50,
      raw: effective,
      note: `no material liabilities; backstop ${fmtUsd(effective)} effective (${thr} threshold, q4w ${pct(b.q4wPct)})`,
    };
  }
  const coverage = effective / liabilities;
  return {
    value: clamp((coverage / THRESHOLDS.backstopFullCoverage) * 100),
    raw: coverage,
    note: `backstop ${fmtUsd(effective)} (after q4w ${pct(b.q4wPct)}) covers ${pct(coverage)} of ${fmtUsd(liabilities)} liabilities; ${thr} Blend threshold`,
  };
}

/**
 * Scored on the most-borrowed reserve with material supply, not the pool-wide
 * USD average: a depositor supplies one asset, and a pool's idle XLM does not
 * make its USDC withdrawable.
 */
export function utilizationFactor(d: Derived[]): FactorCalc {
  const sup = d.reduce((a, x) => a + x.suppliedUsd, 0);
  const bor = d.reduce((a, x) => a + x.borrowedUsd, 0);
  if (sup <= 0) return { value: 100, raw: 0, note: "no supply" };
  const pool = bor / sup;
  let maxU = 0;
  let maxSym = "";
  for (const x of d) {
    if (x.suppliedUsd < THRESHOLDS.minLiquidityUsd) continue;
    const ru = x.r.supplied > 0 ? x.r.borrowed / x.r.supplied : 0;
    if (ru > maxU) {
      maxU = ru;
      maxSym = x.r.symbol;
    }
  }
  if (!maxSym) return { value: 100, raw: 0, note: `no reserve with ${fmtUsd(THRESHOLDS.minLiquidityUsd)}+ supplied (pool utilization ${pct(pool)})` };
  const { utilizationFull: lo, utilizationZero: hi } = THRESHOLDS;
  const value = maxU <= lo ? 100 : maxU >= hi ? 0 : (100 * (hi - maxU)) / (hi - lo);
  return { value, raw: maxU, note: `most-borrowed reserve ${maxSym} ${pct(maxU)} (pool-wide ${pct(pool)})` };
}

/**
 * @param depthVerified assetIds of SDEX-priced collateral whose order-book analysis came out
 *   safe (manipulation sub-score ≥ 75) — treated like robust sources so a deep market such as
 *   XLM/USDC is not penalised merely for being SDEX-priced.
 */
export function supplyCapFactor(d: Derived[], depthVerified: ReadonlySet<string> = new Set()): FactorCalc {
  const liquidity = d.reduce((a, x) => a + x.availableUsd, 0);
  const weak = d.filter((x) => x.isCollateral && x.priced && !ROBUST_KINDS.has(x.r.source.kind) && !depthVerified.has(x.r.assetId));
  if (!weak.length) return { value: 100, raw: null, note: "no weakly-priced collateral" };
  if (liquidity < THRESHOLDS.minLiquidityUsd) return { value: 100, raw: null, note: `n/a: only ${fmtUsd(liquidity)} borrowable liquidity` };
  let worst = { score: 101, kappa: 0, sym: "", power: 0 };
  for (const x of weak) {
    const power = x.r.supplyCap === null ? Infinity : x.r.supplyCap * (x.r.priceUsd as number) * x.r.cFactor;
    const kappa = power / liquidity;
    const score = kappa <= 0.1 ? 100 : kappa >= 1 ? 0 : 100 * (1 - Math.log10(kappa / 0.1));
    if (score < worst.score) worst = { score, kappa, sym: x.r.symbol, power };
  }
  return {
    value: worst.score,
    raw: Number.isFinite(worst.kappa) ? worst.kappa : "uncapped",
    note: `${worst.sym}: cap allows ${fmtUsd(worst.power)} borrow power at true price = ${
      Number.isFinite(worst.kappa) ? pct(worst.kappa) : "∞"
    } of ${fmtUsd(liquidity)} liquidity`,
  };
}

export function concentrationFactor(d: Derived[]): FactorCalc {
  const atRisk = d.reduce((a, x) => a + x.availableUsd + x.borrowedUsd, 0);
  if (atRisk < THRESHOLDS.minLiquidityUsd) return { value: 100, raw: null, note: "n/a: nothing borrowable against the collateral" };
  const coll = d.filter((x) => x.isCollateral && x.suppliedUsd > 0);
  const total = coll.reduce((a, x) => a + x.suppliedUsd, 0);
  if (total < 1) return { value: 100, raw: null, note: "n/a: no collateral supplied" };
  const hhi = coll.reduce((a, x) => a + (x.suppliedUsd / total) ** 2, 0);
  let top = coll[0];
  for (const x of coll) if (x.suppliedUsd > top.suppliedUsd) top = x;
  return { value: clamp(200 * (1 - hhi)), raw: hhi, note: `collateral HHI ${hhi.toFixed(2)}; largest ${top.r.symbol} ${pct(top.suppliedUsd / total)}` };
}

// ── main entry ───────────────────────────────────────────────────────────────

/** The B and C bands' floors: a soft ceiling only compresses the part of a score above its floor. */
const B_FLOOR = 65;
const C_FLOOR = 50;

/**
 * The soft "at most B" ceiling used for uninsured pools (HR7) and weak price
 * feeds (HR6): scores above 65 are compressed linearly into 65..79, so the
 * grade tops out at B while pools keep their order (a hard min(score, 79)
 * would flatten every such pool to the same number). HR9's "at most C" is the
 * same with floor 50 and cap 64.
 */
export function softCeiling(score: number, cap: number = HARD_CAPS.uninsured, floor: number = B_FLOOR): number {
  if (score <= floor) return score;
  return floor + ((score - floor) * (cap - floor)) / (100 - floor);
}

/**
 * Collateral whose price source is not robust (quality below
 * THRESHOLDS.robustSourceQuality), excluding SDEX-priced assets whose order
 * book was deep enough to make manipulation unprofitable (manipulation
 * sub-score ≥ 75), which supplyCapFactor also treats as robust.
 */
export function weakCollateral(d: Derived[], manip: ManipulationAssessment[]): Derived[] {
  const depthVerified = new Set(manip.filter((m) => m.score >= 75).map((m) => m.assetId));
  return d.filter((x) => x.isCollateral && x.priced && sourceQuality(x.r) < THRESHOLDS.robustSourceQuality && !depthVerified.has(x.r.assetId));
}

/**
 * Why the backstop does not count as first-loss capital (HR7), or null when it
 * does: below Blend's threshold, or so much of it queued to leave that Blend's
 * own update_status would put the pool On_Ice.
 */
export function backstopUnreliable(s: PoolSnapshot): string | null {
  const b = s.backstop;
  if (!b) return "backstop data unavailable (treated as uninsured)";
  if (!b.meetsThreshold) return "backstop below Blend's threshold: no first-loss capital (uninsured)";
  if (b.q4wPct >= THRESHOLDS.backstopQueueOnIce)
    return `${pct(b.q4wPct)} of the backstop is queued for withdrawal, at or past the ${pct(THRESHOLDS.backstopQueueOnIce)} at which Blend puts a pool On_Ice`;
  return null;
}

/**
 * Why Blend's permissionless update_status would freeze this pool now (HR8),
 * or null: its withdrawal queue is at or past the freeze share for its status.
 * Admin statuses 0, 4 and 6 never move to Frozen this way.
 */
export function pendingFreeze(s: PoolSnapshot): string | null {
  const b = s.backstop;
  if (!b) return null;
  const limit = s.status === 1 || s.status === 3 ? THRESHOLDS.backstopQueueFrozen : s.status === 2 ? THRESHOLDS.adminOnIceQueueFrozen : null;
  if (limit === null || b.q4wPct < limit) return null;
  return `${pct(b.q4wPct)} of the backstop is queued for withdrawal, past the ${pct(limit)} at which Blend's update_status freezes an ${STATUS_LABELS[s.status]} pool; anyone can make that call`;
}

/**
 * Why lenders cannot get out (HR10), or null: a reserve with material supply is
 * borrowed to or past its own max_util now, or was in any read of the last
 * THRESHOLDS.lockWindowSec (v2.5). Blend lends no more of it there, and its
 * lenders can withdraw only what is not borrowed until borrowers repay. A
 * reserve without a price is left out (its supply cannot be measured; HR2
 * already applies).
 */
export function lendersLockedIn(s: PoolSnapshot, d: Derived[]): string | null {
  const now = s.asOf.timestamp;
  const out: string[] = [];
  for (const x of d) {
    const r = x.r;
    if (!x.priced || r.maxUtil <= 0) continue;
    const u = r.supplied > 0 ? r.borrowed / r.supplied : 0;
    const free = `${fmtUsd(x.suppliedUsd - x.borrowedUsd)} of ${fmtUsd(x.suppliedUsd)} can be withdrawn`;
    if (x.suppliedUsd >= THRESHOLDS.minLiquidityUsd && u >= r.maxUtil) {
      out.push(`${r.symbol} is ${pct(u)} borrowed, ${u > r.maxUtil ? "past" : "at"} its ${pct(r.maxUtil)} max_util: ${free}`);
      continue;
    }
    const locked = (s.utilizationHistory?.[r.assetId] ?? []).filter(
      (h) =>
        h.sampledAt >= now - THRESHOLDS.lockWindowSec &&
        h.sampledAt < now &&
        h.maxUtil > 0 &&
        h.supplied * (h.priceUsd ?? 0) >= THRESHOLDS.minLiquidityUsd &&
        h.borrowed / h.supplied >= h.maxUtil,
    );
    if (!locked.length) continue;
    const last = locked.reduce((a, b) => (b.sampledAt > a.sampledAt ? b : a));
    out.push(
      `${r.symbol} is ${pct(u)} borrowed, under its ${pct(r.maxUtil)} max_util now, but was ${pct(last.borrowed / last.supplied)} borrowed at ${utcTime(last.sampledAt)} UTC, within ${THRESHOLDS.lockWindowSec / 3600} h: ${free}`,
    );
  }
  return out.length ? out.join("; ") : null;
}

/**
 * Why lenders have no first-loss capital in front of them (HR9), or null: the
 * pool has material borrows and its effective backstop (after the queue)
 * covers less than THRESHOLDS.minFirstLossCoverage of them.
 */
export function firstLossShortfall(s: PoolSnapshot, d: Derived[]): string | null {
  const liabilities = d.reduce((a, x) => a + x.borrowedUsd, 0);
  if (liabilities < THRESHOLDS.minLiabilitiesUsd) return null;
  const b = s.backstop;
  const effective = b ? b.usdc * THRESHOLDS.cometUsdcMultiplier * (1 - clamp(b.q4wPct, 0, 1)) : 0;
  const coverage = effective / liabilities;
  if (coverage >= THRESHOLDS.minFirstLossCoverage) return null;
  return `backstop ${fmtUsd(effective)} effective${b ? "" : " (no data)"} covers ${pct(coverage)} of ${fmtUsd(liabilities)} borrowed, under ${pct(THRESHOLDS.minFirstLossCoverage)}: lenders carry the first loss`;
}

export function ratePool(s: PoolSnapshot, opts: RateOptions = {}): PoolRating {
  const nowSec = s.asOf.timestamp;
  const d = derive(s);
  const manip = assessSdexCollateral(s, d, opts.manipulation);
  const fresh = oracleFreshnessFactor(d, nowSec);

  const factors: RatingFactor[] = [
    factor("oracle_source", oracleSourceFactor(d)),
    factor("oracle_freshness", fresh),
    factor("sdex_manipulation", manipulationFactor(manip)),
    factor("backstop_coverage", backstopFactor(s, d)),
    factor("utilization", utilizationFactor(d)),
    factor("supply_caps", supplyCapFactor(d, new Set(manip.filter((m) => m.score >= 75).map((m) => m.assetId)))),
    factor("collateral_concentration", concentrationFactor(d)),
  ];

  const uncappedScore = Math.round(clamp(factors.reduce((a, f) => a + f.value * f.weight, 0)));
  let score: number = uncappedScore;
  let eligible = true;
  const hardRules: string[] = [];

  // Blend refuses supply when status > 3 (pool.rs require_action_allowed): the
  // grade still describes the setup, but nobody can deposit.
  if (s.status >= 4) {
    eligible = false;
    hardRules.push(`HR1 status ${s.status} (${STATUS_LABELS[s.status] ?? "unknown"}): Blend does not accept deposits ⇒ not eligible`);
  }
  // HR8: deposits still open, but one permissionless call closes them.
  const freezing = pendingFreeze(s);
  if (freezing) {
    eligible = false;
    hardRules.push(`HR8 ${freezing} ⇒ not eligible`);
  }
  if (fresh.priceProblems.length) {
    eligible = false;
    score = Math.min(score, HARD_CAPS.collateralPriceUnavailable);
    hardRules.push(`HR2 price unavailable for collateral or a borrowed asset (${fresh.priceProblems.join("; ")}) ⇒ not eligible, grade ≤ D`);
  }
  const manipulable = manip.filter((m) => m.result?.profitable && !m.result.costIsLowerBound);
  if (manipulable.length) {
    eligible = false;
    score = Math.min(score, HARD_CAPS.sdexManipulable);
    hardRules.push(`HR3 SDEX-manipulable collateral (${manipulable.map((m) => m.symbol).join(", ")}) ⇒ not eligible, grade E`);
  }
  const opaque = d.filter((x) => x.isCollateral && x.r.source.kind === "opaque");
  if (opaque.length) {
    eligible = false;
    score = Math.min(score, HARD_CAPS.unverifiableCollateralSource);
    hardRules.push(`HR5 collateral price source unidentifiable (${opaque.map((x) => x.r.symbol).join(", ")}) ⇒ not eligible, grade ≤ C`);
  }
  const locked = lendersLockedIn(s, d);
  if (locked) {
    eligible = false;
    score = Math.min(score, HARD_CAPS.lendersLockedIn);
    hardRules.push(`HR10 ${locked} ⇒ not eligible, grade ≤ C`);
  }
  // HR6 / HR7 share one soft ceiling, applied once even when both hold. HR9
  // is the stricter one (at most C) and says what HR7 would about the backstop.
  const noFirstLoss = firstLossShortfall(s, d);
  const uninsured = noFirstLoss ? null : backstopUnreliable(s);
  const weakColl = weakCollateral(d, manip);
  const weakRule = () =>
    `HR6 collateral priced by a weak source (${weakColl.map((x) => `${x.r.symbol} ← ${x.r.source.kind}`).join(", ")}) ⇒ at most B (65+ compressed into 65–79)`;
  if (noFirstLoss && score > C_FLOOR) {
    score = softCeiling(score, HARD_CAPS.noFirstLossCapital, C_FLOOR);
    hardRules.push(`HR9 ${noFirstLoss} ⇒ at most C (50+ compressed into 50–64)`);
    if (weakColl.length) hardRules.push(weakRule());
  } else if ((uninsured || weakColl.length) && score > B_FLOOR) {
    score = softCeiling(score);
    if (uninsured) hardRules.push(`HR7 ${uninsured} ⇒ at most B (65+ compressed into 65–79)`);
    if (weakColl.length) hardRules.push(weakRule());
  }
  score = Math.round(clamp(score));
  if (score < 50 && eligible) {
    eligible = false;
    hardRules.push("HR4 score < 50 ⇒ not eligible");
  }

  const tvlUsd = Math.round(d.reduce((a, x) => a + x.suppliedUsd, 0) * 100) / 100;
  // NR: nothing to grade. A pool that never launched, or one holding less than
  // minRatedTvlUsd, gets no score, so it can never rank above a real market;
  // with no rating the guard refuses deposits, as for any unrated pool.
  const notRated =
    s.status === 6
      ? "never launched (Blend status 6, Setup)"
      : tvlUsd < THRESHOLDS.minRatedTvlUsd
        ? `${fmtUsd(tvlUsd)} supplied, under the ${fmtUsd(THRESHOLDS.minRatedTvlUsd)} needed to measure a market`
        : undefined;
  if (notRated) {
    eligible = false;
    // Ceilings and the score floor (HR4, HR6, HR7, HR9) shape a score; with no score they say nothing.
    for (let i = hardRules.length - 1; i >= 0; i--) if (/^HR[4679] /.test(hardRules[i])) hardRules.splice(i, 1);
    hardRules.unshift(`NR not rated: ${notRated} ⇒ no grade, not eligible`);
  }
  const finalScore: number | null = notRated ? null : score;
  const grade: RatingGrade = notRated ? "NR" : gradeFor(score);

  const reasons: string[] = [...hardRules];
  for (const m of manip) if (m.score < 50) reasons.push(`sdex_manipulation: ${m.note}`);
  for (const f of factors) if (f.value < 50 && f.key !== "sdex_manipulation") reasons.push(`${f.key}: ${f.note}`);
  for (const g of s.dataGaps) reasons.push(`data gap: ${g}`);

  const reasonsHash = sha256Canonical({
    engineVersion: ENGINE_VERSION,
    inputs: hashInputs(s),
    factors,
    hardRules,
    score: finalScore,
    uncappedScore: notRated ? null : uncappedScore,
    grade,
    eligibleForDeposit: eligible,
  });

  return {
    poolId: s.poolId,
    name: s.name,
    protocol: "blend",
    score: finalScore,
    ...(notRated ? { notRated } : { uncappedScore }),
    grade,
    ...(s.deployment ? { deployment: s.deployment } : {}),
    status: s.status,
    statusLabel: STATUS_LABELS[s.status] ?? `unknown(${s.status})`,
    eligibleForDeposit: eligible,
    factors,
    reasons,
    hardRules,
    tvlUsd,
    computedAt: opts.now ?? nowSec,
    reasonsHash,
    engineVersion: ENGINE_VERSION,
    yields: reserveYields(s),
  };
}

/** Current rates of the enabled reserves, highest supply APR first. Not a risk input. */
export function reserveYields(s: PoolSnapshot): ReserveYield[] {
  return s.reserves
    .filter((r) => r.enabled && typeof r.supplyApr === "number" && Number.isFinite(r.supplyApr))
    .map((r) => ({
      assetId: r.assetId,
      symbol: r.symbol,
      supplyApr: r.supplyApr as number,
      borrowApr: typeof r.borrowApr === "number" && Number.isFinite(r.borrowApr) ? r.borrowApr : null,
      suppliedUsd: r.priceUsd === null ? null : r.supplied * r.priceUsd,
    }))
    .sort((a, b) => b.supplyApr - a.supplyApr);
}

/** The subset of the snapshot that determines the rating (hashed into reasonsHash). */
export function hashInputs(s: PoolSnapshot): unknown {
  return {
    poolId: s.poolId,
    status: s.status,
    oracleId: s.oracleId,
    oracleKind: s.oracleKind,
    asOf: s.asOf,
    ...(s.backstopId ? { backstopId: s.backstopId } : {}),
    backstop: s.backstop,
    reserves: s.reserves.map((r) => ({
      assetId: r.assetId,
      cFactor: r.cFactor,
      lFactor: r.lFactor,
      maxUtil: r.maxUtil,
      supplyCap: r.supplyCap,
      enabled: r.enabled,
      supplied: r.supplied,
      borrowed: r.borrowed,
      priceUsd: r.priceUsd,
      priceTimestamp: r.priceTimestamp,
      source: { kind: r.source.kind, sourceOracleId: r.source.sourceOracleId, maxDevPct: r.source.maxDevPct, inferred: r.source.inferred },
    })),
    dexDepth: Object.keys(s.dexDepth)
      .sort()
      .map((k) => ({ assetId: k, truncated: s.dexDepth[k].truncated, asksHash: sha256Canonical(s.dexDepth[k].asks) })),
    ...(s.dexDepthHistory && Object.keys(s.dexDepthHistory).length
      ? {
          dexDepthHistory: Object.keys(s.dexDepthHistory)
            .sort()
            .map((k) => ({
              assetId: k,
              samples: s.dexDepthHistory![k].map((x) => ({ sampledAt: x.sampledAt, refPriceUsd: x.refPriceUsd, truncated: x.truncated, asksHash: sha256Canonical(x.asks) })),
            })),
        }
      : {}),
    ...(s.utilizationHistory && Object.keys(s.utilizationHistory).length
      ? {
          utilizationHistory: Object.keys(s.utilizationHistory)
            .sort()
            .map((k) => ({ assetId: k, samples: s.utilizationHistory![k] })),
        }
      : {}),
    dataGaps: s.dataGaps,
  };
}
