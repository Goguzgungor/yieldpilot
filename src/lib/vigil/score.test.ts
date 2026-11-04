import { describe, expect, it } from "vitest";
import {
  HARD_CAPS,
  SOURCE_QUALITY,
  WEIGHTS,
  backstopFactor,
  concentrationFactor,
  derive,
  gradeFor,
  oracleFreshnessFactor,
  oracleSourceFactor,
  priceProblem,
  ratePool,
  rhoToScore,
  sourceQuality,
  staleAfterSec,
  supplyCapFactor,
  utilizationFactor,
} from "./score";
import { T0, backstop, depth, healthyPool, reserve, src } from "./testkit";
import type { PoolSnapshot } from "./types";

const factorOf = (s: PoolSnapshot, key: string) => ratePool(s).factors.find((f) => f.key === key)!;

describe("weights and grades", () => {
  it("weights sum to 1", () => {
    expect(Object.values(WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });
  it("grade bands A/B/C/D/E", () => {
    expect([100, 80, 79, 65, 64, 50, 49, 35, 34, 0].map(gradeFor).join("")).toBe("AABBCCDDEE");
  });
});

describe("healthy baseline", () => {
  it("an active, CEX-priced, well-backstopped pool grades A and is eligible", () => {
    const r = ratePool(healthyPool());
    expect(r.grade).toBe("A");
    expect(r.eligibleForDeposit).toBe(true);
    expect(r.hardRules).toEqual([]);
    expect(r.factors.reduce((a, f) => a + f.contribution, 0)).toBeCloseTo(r.uncappedScore!, 0);
    expect(r.tvlUsd).toBeCloseTo(2_000_000 + 10_000_000 * 0.2 + 1_000_000 * 1.1, 2);
  });
});

describe("pool status (HR1, v2.1; NR for Setup since v2.2)", () => {
  it.each([2, 3])("status %i (borrowing paused) still accepts deposits and is not graded down by status", (status) => {
    const r = ratePool(healthyPool({ status }));
    expect(r.eligibleForDeposit).toBe(true);
    expect(r.grade).toBe("A");
    expect(r.hardRules.some((h) => h.startsWith("HR1"))).toBe(false);
  });
  it.each([4, 5])("status %i ⇒ Blend refuses deposits: not eligible, grade unchanged", (status) => {
    const r = ratePool(healthyPool({ status }));
    expect(r.eligibleForDeposit).toBe(false);
    expect(r.grade).toBe("A");
    expect(r.hardRules[0]).toMatch(/^HR1/);
  });
  it("status 6 (never launched) ⇒ not rated", () => {
    const r = ratePool(healthyPool({ status: 6 }));
    expect(r.grade).toBe("NR");
    expect(r.score).toBeNull();
    expect(r.eligibleForDeposit).toBe(false);
    expect(r.hardRules.some((h) => h.startsWith("HR1"))).toBe(true);
  });
});

describe("oracle_source factor", () => {
  it("is worst-of over collateral reserves only", () => {
    const s = healthyPool();
    s.reserves.push(reserve("JUNK", { cFactor: 0, source: src("opaque") })); // not collateral
    expect(oracleSourceFactor(derive(s)).value).toBe(SOURCE_QUALITY.reflector_cex);
    s.reserves.push(reserve("PUSH", { source: src("issuer_push") }));
    expect(oracleSourceFactor(derive(s)).value).toBe(SOURCE_QUALITY.issuer_push);
  });
  it("deducts for market feeds without max_dev and for inferred attributions", () => {
    expect(sourceQuality(reserve("A", { source: src("reflector_dex", { maxDevPct: 10 }) }))).toBe(60);
    expect(sourceQuality(reserve("A", { source: src("reflector_dex", { maxDevPct: 0 }) }))).toBe(50);
    expect(sourceQuality(reserve("A", { source: src("reflector_dex", { maxDevPct: 10, inferred: true }) }))).toBe(50);
  });
  it("is 100 when there is no collateral", () => {
    const s = healthyPool({ reserves: [reserve("USDC", { cFactor: 0 })] });
    expect(oracleSourceFactor(derive(s)).value).toBe(100);
  });
});

describe("oracle_freshness factor + HR2", () => {
  it("staleness threshold is max(1h, 2×resolution) capped at Blend's 24h", () => {
    expect(staleAfterSec(reserve("A", { source: src("reflector_cex", { resolutionSec: 300 }) }))).toBe(3600);
    expect(staleAfterSec(reserve("A", { source: src("redstone", { resolutionSec: 43_200 }) }))).toBe(86_400);
    expect(staleAfterSec(reserve("A", { source: src("redstone", { resolutionSec: 100_000 }) }))).toBe(86_400);
  });
  it("base / fixed-peg prices are never stale", () => {
    expect(priceProblem(reserve("A", { source: src("fixed_peg"), priceTimestamp: T0 - 999_999 }), T0)).toBeNull();
  });
  it("stale collateral ⇒ factor 0, not eligible, grade ≤ D", () => {
    const s = healthyPool();
    s.reserves[1].priceTimestamp = T0 - 7200;
    const r = ratePool(s);
    expect(factorOf(s, "oracle_freshness").value).toBe(0);
    expect(r.eligibleForDeposit).toBe(false);
    expect(r.score).toBeLessThanOrEqual(HARD_CAPS.collateralPriceUnavailable);
    expect(r.hardRules.some((h) => h.startsWith("HR2"))).toBe(true);
  });
  it("missing collateral price ⇒ HR2", () => {
    const s = healthyPool();
    s.reserves[2] = reserve("EURC", { priceUsd: null, priceTimestamp: null, source: src("missing") });
    expect(ratePool(s).hardRules.some((h) => h.startsWith("HR2"))).toBe(true);
  });
  it("a missing price on a borrowed (non-collateral) asset ⇒ HR2 too: that debt can be neither valued nor liquidated", () => {
    const s = healthyPool();
    s.reserves.push(reserve("BOR", { cFactor: 0, borrowed: 10, priceUsd: null, priceTimestamp: null, source: src("missing") }));
    const f = oracleFreshnessFactor(derive(s), T0);
    expect(f.value).toBe(0);
    expect(f.priceProblems).toEqual(["BOR (borrowed): missing"]);
    const r = ratePool(s);
    expect(r.hardRules.some((h) => h.startsWith("HR2") && h.includes("BOR (borrowed)"))).toBe(true);
    expect(r.eligibleForDeposit).toBe(false);
  });
  it("a borrowable asset nobody has borrowed is not a price problem (a new borrow would just revert)", () => {
    const s = healthyPool();
    s.reserves.push(reserve("IDLE", { cFactor: 0, borrowed: 0, priceUsd: null, priceTimestamp: null, source: src("missing") }));
    expect(oracleFreshnessFactor(derive(s), T0).priceProblems).toEqual([]);
  });
});

describe("sdex_manipulation factor + HR3", () => {
  const thin = () => {
    const s = healthyPool();
    const ustry = reserve("USTRY", { supplied: 2_000, borrowed: 0, priceUsd: 1.06, supplyCap: 250_000, source: src("reflector_dex", { maxDevPct: 10 }) });
    s.reserves.push(ustry);
    s.dexDepth[ustry.assetId] = depth(ustry.assetId, [[1.06, 4.9]]);
    return s;
  };

  it("thin SDEX-priced collateral ⇒ factor 0, HR3, grade E, not eligible", () => {
    const r = ratePool(thin());
    const f = r.factors.find((x) => x.key === "sdex_manipulation")!;
    expect(f.value).toBe(0);
    expect(Number(f.raw)).toBeLessThan(0.1);
    expect(r.grade).toBe("E");
    expect(r.score).toBeLessThanOrEqual(HARD_CAPS.sdexManipulable);
    expect(r.eligibleForDeposit).toBe(false);
    expect(r.hardRules.some((h) => h.startsWith("HR3") && h.includes("USTRY"))).toBe(true);
  });

  it("the same thin book is ignored when the price comes from a CEX feed (no false positive)", () => {
    const s = thin();
    const u = s.reserves[s.reserves.length - 1];
    u.source = src("reflector_cex");
    const r = ratePool(s);
    expect(r.factors.find((x) => x.key === "sdex_manipulation")!.value).toBe(100);
    expect(r.hardRules).toEqual([]);
  });

  it("deep SDEX book ⇒ high factor, no hard rule", () => {
    const s = thin();
    const u = s.reserves[s.reserves.length - 1];
    s.dexDepth[u.assetId] = depth(u.assetId, [[1.07, 100_000_000]]);
    const r = ratePool(s);
    expect(r.factors.find((x) => x.key === "sdex_manipulation")!.value).toBeGreaterThan(75);
    expect(r.hardRules).toEqual([]);
  });

  it("truncated book with rho < 1 is 'uncertain' (50) and does not fire HR3", () => {
    const s = thin();
    const u = s.reserves[s.reserves.length - 1];
    s.dexDepth[u.assetId] = depth(u.assetId, [[1.06, 4.9]], true);
    const r = ratePool(s);
    expect(r.factors.find((x) => x.key === "sdex_manipulation")!.value).toBe(50);
    expect(r.hardRules.some((h) => h.startsWith("HR3"))).toBe(false);
  });

  it("SDEX-priced collateral without an order book scores 50 and is noted", () => {
    const s = thin();
    s.dexDepth = {};
    expect(factorOf(s, "sdex_manipulation").value).toBe(50);
  });

  it("rhoToScore: log scale, 1 ⇒ 50, 10 ⇒ 100, 0.1 ⇒ 0", () => {
    expect(rhoToScore(1, false)).toBe(50);
    expect(rhoToScore(10, false)).toBe(100);
    expect(rhoToScore(0.1, false)).toBe(0);
    expect(rhoToScore(null, false)).toBe(100);
    expect(rhoToScore(0.5, true)).toBe(50);
  });
});

describe("backstop_coverage factor", () => {
  it("full marks at ≥10% effective coverage of liabilities, linear below", () => {
    const s = healthyPool();
    const liab = derive(s).reduce((a, x) => a + x.borrowedUsd, 0);
    s.backstop = backstop({ usdc: (0.05 * liab) / 5 }); // 5% coverage
    expect(backstopFactor(s, derive(s)).value).toBeCloseTo(50, 6);
    s.backstop = backstop({ usdc: (0.2 * liab) / 5 });
    expect(backstopFactor(s, derive(s)).value).toBe(100);
  });
  it("queued withdrawals reduce effective coverage", () => {
    const s = healthyPool();
    const liab = derive(s).reduce((a, x) => a + x.borrowedUsd, 0);
    s.backstop = backstop({ usdc: (0.1 * liab) / 5, q4wPct: 0.5 });
    expect(backstopFactor(s, derive(s)).value).toBeCloseTo(50, 6);
  });
  it("zero backstop (post-Comet-exploit state) scores 0; unreadable scores 0; no liabilities scores 50", () => {
    const s = healthyPool({ backstop: backstop({ usdc: 0, blnd: 0, meetsThreshold: false }) });
    expect(backstopFactor(s, derive(s)).value).toBe(0);
    expect(backstopFactor(healthyPool({ backstop: null }), derive(healthyPool())).value).toBe(0);
    const empty = healthyPool({ backstop: backstop({ usdc: 0 }), reserves: [reserve("USDC", { borrowed: 0 })] });
    expect(backstopFactor(empty, derive(empty)).value).toBe(50);
  });
});

describe("utilization factor", () => {
  it("100 up to 60%, 0 from 95%, linear in between", () => {
    const at = (u: number) => utilizationFactor(derive(healthyPool({ reserves: [reserve("USDC", { supplied: 100_000, borrowed: 100_000 * u })] }))).value;
    expect(at(0.5)).toBe(100);
    expect(at(0.6)).toBe(100);
    expect(at(0.775)).toBeCloseTo(50, 6);
    expect(at(0.95)).toBe(0);
  });
});

describe("supply_caps factor", () => {
  it("penalises weakly-priced collateral whose cap allows borrow power ≫ pool liquidity", () => {
    const s = healthyPool();
    const liquidity = derive(s).reduce((a, x) => a + x.availableUsd, 0);
    s.reserves.push(reserve("PEG", { source: src("fixed_peg"), supplied: 0, borrowed: 0, supplyCap: (0.05 * liquidity) / 0.9 }));
    expect(supplyCapFactor(derive(s)).value).toBe(100); // κ = 5%
    s.reserves[3].supplyCap = (1.5 * liquidity) / 0.9; // κ = 150%
    expect(supplyCapFactor(derive(s)).value).toBe(0);
    s.reserves[3].supplyCap = null; // uncapped
    expect(supplyCapFactor(derive(s)).value).toBe(0);
  });
  it("ignores robust sources and depth-verified SDEX assets; n/a without liquidity", () => {
    const s = healthyPool();
    expect(supplyCapFactor(derive(s)).value).toBe(100);
    const x = reserve("XLMDEX", { source: src("reflector_dex"), supplyCap: null });
    s.reserves.push(x);
    expect(supplyCapFactor(derive(s)).value).toBe(0);
    expect(supplyCapFactor(derive(s), new Set([x.assetId])).value).toBe(100);
    const dry = healthyPool({ reserves: [reserve("PEG", { source: src("fixed_peg"), supplied: 0, borrowed: 0 })] });
    expect(supplyCapFactor(derive(dry)).value).toBe(100);
  });
});

describe("collateral_concentration factor", () => {
  it("HHI-based: diversified 100, single collateral 0, n/a when nothing borrowable", () => {
    expect(concentrationFactor(derive(healthyPool())).value).toBe(100);
    const one = healthyPool({ reserves: [reserve("BTC", { lFactor: 0.9 }), reserve("USDC", { cFactor: 0, supplied: 1_000_000, borrowed: 0 })] });
    expect(concentrationFactor(derive(one)).value).toBe(0);
    const nothingBorrowable = healthyPool({ reserves: [reserve("PT", { lFactor: 0, borrowed: 0 })] });
    expect(concentrationFactor(derive(nothingBorrowable)).value).toBe(100);
  });
});

describe("reasonsHash", () => {
  it("is deterministic, ignores computedAt, and changes with any input", () => {
    const a = ratePool(healthyPool(), { now: 1 });
    const b = ratePool(healthyPool(), { now: 2 });
    expect(a.reasonsHash).toBe(b.reasonsHash);
    expect(a.reasonsHash).toMatch(/^[0-9a-f]{64}$/);
    const s = healthyPool();
    s.reserves[0].supplied += 1;
    expect(ratePool(s).reasonsHash).not.toBe(a.reasonsHash);
  });
});

describe("HR4 / HR5", () => {
  it("an active pool scoring below 50 is not eligible (HR4)", () => {
    const s = healthyPool({ backstop: backstop({ usdc: 0 }) });
    // 89% borrowed, under a 95% max_util (so HR10 stays out of it), at a tenth
    // of the healthy pool's size so the dollar depth (v2.6) does not lift it
    s.reserves = s.reserves.map((r) => ({
      ...r,
      supplyCap: null,
      supplied: r.supplied / 10,
      borrowed: (r.supplied / 10) * 0.89,
      maxUtil: 0.95,
      source: { ...r.source, kind: "issuer_push" as const },
    }));
    const dex = reserve("DEX", { supplyCap: null, source: src("reflector_dex", { maxDevPct: 10 }) });
    s.reserves.push(dex);
    s.dexDepth[dex.assetId] = depth(dex.assetId, [[1.01, 1]], true); // uncertain ⇒ 50
    const r = ratePool(s);
    expect(r.score).toBeLessThan(50);
    expect(r.hardRules).toEqual(["HR4 score < 50 ⇒ not eligible"]);
    expect(r.eligibleForDeposit).toBe(false);
  });

  it("unidentifiable collateral source ⇒ HR5, grade ≤ C, not eligible; manipulation not credited", () => {
    const s = healthyPool();
    s.reserves[2] = { ...s.reserves[2], source: { ...s.reserves[2].source, kind: "opaque" } };
    const r = ratePool(s);
    expect(r.hardRules.some((h) => h.startsWith("HR5") && h.includes("EURC"))).toBe(true);
    expect(r.score).toBeLessThanOrEqual(HARD_CAPS.unverifiableCollateralSource);
    expect(r.eligibleForDeposit).toBe(false);
    expect(r.factors.find((f) => f.key === "sdex_manipulation")!.value).toBe(50);
  });
});
