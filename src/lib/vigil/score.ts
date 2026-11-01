/**
 * Vigil risk engine v2 — pool scoring (pure, deterministic).
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
  type PoolRating,
  type PoolSnapshot,
  type RatingFactor,
  type ReserveSnapshot,
  type ReserveYield,
} from "./types";

export const ENGINE_VERSION = "vigil-risk-v2.0.0";

/** Factor weights (sum = 1). */
export const WEIGHTS = {
  pool_status: 0.15,
  oracle_source: 0.15,
  oracle_freshness: 0.1,
  sdex_manipulation: 0.2,
  backstop_coverage: 0.15,
  utilization: 0.1,
  supply_caps: 0.1,
  collateral_concentration: 0.05,
} as const;

export type FactorKey = keyof typeof WEIGHTS;

export const WEIGHT_RATIONALE: Record<FactorKey, string> = {
  pool_status:
    "Status gates what the pool can do (borrowing off at >1, supplying off at >3 — pool.rs require_action_allowed) and is the pool's own alarm (on-ice/frozen follow backstop stress).",
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
export const STATUS_SCORE: Record<number, number> = { 0: 100, 1: 100, 2: 40, 3: 30, 4: 10, 5: 0, 6: 0 };

export const GRADE_BANDS: ReadonlyArray<readonly [number, Grade]> = [
  [80, "A"],
  [65, "B"],
  [50, "C"],
  [35, "D"],
  [0, "E"],
];

export const HARD_CAPS = {
  /** status >= 2 ⇒ grade ≤ D */
  statusNotActive: 49,
  /** collateral with stale/missing price ⇒ grade ≤ D */
  collateralPriceUnavailable: 49,
  /** SDEX-priced collateral with a profitable manipulation (rho < 1) ⇒ grade E */
  sdexManipulable: 34,
  /** collateral whose price source cannot be identified ⇒ grade ≤ C, not eligible */
  unverifiableCollateralSource: 64,
  /** any collateral priced below THRESHOLDS.robustSourceQuality ⇒ grade ≤ B (an A needs robust feeds) */
  weakCollateralSource: 79,
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
  /** sourceQuality at or above this is a robust price source (RedStone = 85, Reflector CEX/FX = 95). */
  robustSourceQuality: 85,
  /** Below this many USD of liabilities the pool has nothing at risk. */
  minLiabilitiesUsd: 1_000,
  /** Below this much borrowable liquidity there is nothing to drain. */
  minLiquidityUsd: 1_000,
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

export function statusFactor(s: PoolSnapshot): FactorCalc {
  const label = STATUS_LABELS[s.status] ?? `unknown(${s.status})`;
  return { value: STATUS_SCORE[s.status] ?? 0, raw: s.status, note: `pool status ${s.status} ${label}` };
}

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

export function oracleFreshnessFactor(d: Derived[], nowSec: number): FactorCalc & { collateralProblems: string[] } {
  const collateralProblems: string[] = [];
  const otherProblems: string[] = [];
  for (const x of d) {
    if (!x.isCollateral && x.r.borrowed <= 0) continue;
    const p = priceProblem(x.r, nowSec);
    if (!p) continue;
    const age = x.r.priceTimestamp !== null ? ` (age ${Math.max(0, nowSec - x.r.priceTimestamp)}s)` : "";
    (x.isCollateral ? collateralProblems : otherProblems).push(`${x.r.symbol}: ${p}${age}`);
  }
  if (collateralProblems.length)
    return { value: 0, raw: collateralProblems.length, note: `collateral price ${collateralProblems.join("; ")}`, collateralProblems };
  if (otherProblems.length)
    return { value: 50, raw: otherProblems.length, note: `borrowed-asset price ${otherProblems.join("; ")}`, collateralProblems };
  return { value: 100, raw: 0, note: "all collateral / borrowed-asset prices fresh", collateralProblems };
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
    const depth = s.dexDepth[x.r.assetId];
    if (!depth) {
      out.push({ assetId: x.r.assetId, symbol: x.r.symbol, result: null, score: 50, note: `${x.r.symbol}: SDEX-priced but order book unavailable` });
      continue;
    }
    const others = d.filter((o) => o !== x && o.isBorrowable && o.availableUsd > 0);
    const availableUsd = others.reduce((a, o) => a + o.availableUsd, 0);
    const avgLFactor = availableUsd > 0 ? others.reduce((a, o) => a + o.availableUsd * o.r.lFactor, 0) / availableUsd : 0;
    const result = assessManipulation(
      {
        priceUsd: x.r.priceUsd as number,
        cFactor: x.r.cFactor,
        capHeadroomTokens: x.r.supplyCap === null ? null : Math.max(0, x.r.supplyCap - x.r.supplied),
        availableUsd,
        avgLFactor,
        depth,
        maxDevPct: x.r.source.maxDevPct,
        resolutionSec: x.r.source.resolutionSec,
      },
      params,
    );
    const score = rhoToScore(result.rho, result.costIsLowerBound);
    const note =
      result.rho === null
        ? `${x.r.symbol}: no profitable leverage (nothing borrowable or c_factor too low)`
        : `${x.r.symbol}: pump ×${result.multiplier} costs ${fmtUsd(result.manipulationCostUsd)} on SDEX${
            result.costIsLowerBound ? " (lower bound, book truncated)" : ""
          } + ${fmtUsd(result.collateralCostUsd)} collateral to borrow ${fmtUsd(result.extractableUsd)} (rho=${result.rho.toPrecision(3)}; hold ${result.roundsToHold} round${
            result.roundsToHold > 1 ? "s" : ""
          }${result.minHoldSeconds ? ` ≈${result.minHoldSeconds}s` : ""}, max_dev=${x.r.source.maxDevPct === undefined ? "unknown" : `${x.r.source.maxDevPct}%`})`;
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

export function utilizationFactor(d: Derived[]): FactorCalc {
  const sup = d.reduce((a, x) => a + x.suppliedUsd, 0);
  const bor = d.reduce((a, x) => a + x.borrowedUsd, 0);
  if (sup <= 0) return { value: 100, raw: 0, note: "no supply" };
  const u = bor / sup;
  let maxU = 0;
  let maxSym = "";
  for (const x of d) {
    if (x.suppliedUsd < 1) continue;
    const ru = x.r.supplied > 0 ? x.r.borrowed / x.r.supplied : 0;
    if (ru > maxU) {
      maxU = ru;
      maxSym = x.r.symbol;
    }
  }
  const { utilizationFull: lo, utilizationZero: hi } = THRESHOLDS;
  const value = u <= lo ? 100 : u >= hi ? 0 : (100 * (hi - u)) / (hi - lo);
  return { value, raw: u, note: `pool utilization ${pct(u)} (highest reserve ${maxSym || "-"} ${pct(maxU)})` };
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

export function ratePool(s: PoolSnapshot, opts: RateOptions = {}): PoolRating {
  const nowSec = s.asOf.timestamp;
  const d = derive(s);
  const manip = assessSdexCollateral(s, d, opts.manipulation);
  const fresh = oracleFreshnessFactor(d, nowSec);

  const factors: RatingFactor[] = [
    factor("pool_status", statusFactor(s)),
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

  if (s.status >= 2) {
    eligible = false;
    score = Math.min(score, HARD_CAPS.statusNotActive);
    hardRules.push(`HR1 status ${s.status} (${STATUS_LABELS[s.status] ?? "unknown"}) ≥ 2 ⇒ not eligible, grade ≤ D`);
  }
  if (fresh.collateralProblems.length) {
    eligible = false;
    score = Math.min(score, HARD_CAPS.collateralPriceUnavailable);
    hardRules.push(`HR2 collateral price unavailable (${fresh.collateralProblems.join("; ")}) ⇒ not eligible, grade ≤ D`);
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
  const weakColl = weakCollateral(d, manip);
  if (weakColl.length && score > HARD_CAPS.weakCollateralSource) {
    score = HARD_CAPS.weakCollateralSource;
    hardRules.push(
      `HR6 collateral priced by a weak source (${weakColl.map((x) => `${x.r.symbol} ← ${x.r.source.kind}`).join(", ")}) ⇒ grade ≤ B`,
    );
  }
  score = Math.round(clamp(score));
  if (score < 50 && eligible) {
    eligible = false;
    hardRules.push("HR4 score < 50 ⇒ not eligible");
  }
  const grade = gradeFor(score);

  const reasons: string[] = [...hardRules];
  for (const m of manip) if (m.score < 50) reasons.push(`sdex_manipulation: ${m.note}`);
  for (const f of factors) if (f.value < 50 && f.key !== "sdex_manipulation") reasons.push(`${f.key}: ${f.note}`);
  for (const g of s.dataGaps) reasons.push(`data gap: ${g}`);

  const tvlUsd = Math.round(d.reduce((a, x) => a + x.suppliedUsd, 0) * 100) / 100;
  const reasonsHash = sha256Canonical({
    engineVersion: ENGINE_VERSION,
    inputs: hashInputs(s),
    factors,
    hardRules,
    score,
    uncappedScore,
    grade,
    eligibleForDeposit: eligible,
  });

  return {
    poolId: s.poolId,
    name: s.name,
    protocol: "blend",
    score,
    uncappedScore,
    grade,
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
    dataGaps: s.dataGaps,
  };
}
