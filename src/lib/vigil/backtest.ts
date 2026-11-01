/**
 * Backtest: the YieldBlox pool (CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS) as it stood
 * just before the 22 Feb 2026 exploit (~00:24 UTC).
 *
 * *** THIS IS A RECONSTRUCTION *** — Soroban RPC cannot read historical state, so every input
 * below is rebuilt from archived on-chain records, and one input (the USTRY SDEX ask book) comes
 * from a post-mortem because Horizon keeps no historical order books. Provenance per field:
 *
 *  - status 1 (Active): pool `set_status` events (Stellar Expert event index) — last change before
 *    the exploit was 2025-04-17 (→1); next was 2026-02-22T01:35Z (→3).
 *  - reserve configs (c/l factor, max_util, supply caps): pool `queue_set_reserve`/`set_reserve`
 *    events; CETES cap raised to 2e7 on 2025-08-29; every later change is post-exploit.
 *  - supplied / borrowed: replay of all 53,537 pool events from deploy to 2026-02-21T23:58:52Z
 *    (supply/withdraw[_collateral] → bTokens, borrow/repay → dTokens) × the b/d rate implied by the
 *    last such event per asset (tokens / b-or-d tokens).
 *  - oracle: pool oracle CD74A3… (yieldblox/oracle-aggregator@2307a9b, verified on Stellar Expert);
 *    a Blend pool's oracle cannot change after deploy, the aggregator emitted 0 events and its asset
 *    configs can only be added, never edited — so today's `asset_configs()` is the pre-exploit config:
 *    USTRY/CETES/EURC via Reflector DEX (CALI2B…) max_dev 10, XLM/AQUA max_dev 0, USDC = base,
 *    USDGLO/PYUSD = base-like (fixed 1.0).
 *  - prices: Horizon /trade_aggregations daily close vs USDC for 2026-02-21 (XLM 0.16115,
 *    EURC 1.1765201, AQUA 0.0003491, CETES 0.0670232, USTRY 1.0574269).
 *  - backstop: replay of 5,727 backstop events for this pool (deposit/withdraw/queue/dequeue/donate)
 *    → 4,385,291 LP tokens, q4w 0.52%; LP value ≈ $0.35 from the last interest-auction fills on
 *    2026-02-21 (USDC lot / LP bid ≈ 0.33–0.35; a filler only fills when lot ≥ bid, so this is an
 *    upper-bound estimate). Split 80/20 BLND/USDC at BLND ≈ $0.0634 (Horizon close).
 *  - USTRY SDEX book: rekt.news/yieldblox-rekt — "USTRY on the ask side: fewer than five tokens",
 *    "Hourly volume … under $1", single market maker. Modelled as 4.9 USTRY at $1.06.
 *    XLM / CETES / EURC books for that date are NOT obtainable → left as data gaps.
 */
import type { AskLevel, AssetPriceSource, PoolSnapshot, ReserveSnapshot } from "./types";
import { assessSdexCollateral, derive, ratePool } from "./score";
import type { ManipulationResult } from "./manipulation";

export const YIELDBLOX_POOL = "CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS";
const AGG = "CD74A3C54EKUVEGUC6WNTUPOTHB624WFKXN3IYTFJGX3EHXDXHCYMXXR";
const RDEX = "CALI2BYU2JE6WVRUFYTS6MSBNEHGJ35P4AVCZYF3B6QOE3QKOB2PLE6M";
/** 2026-02-22T00:00:00Z */
export const BACKTEST_AS_OF = 1771718400;

const A = {
  XLM: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
  USDC: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
  EURC: "CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV",
  AQUA: "CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK",
  USDGLO: "CB226ZOEYXTBPD3QEGABTJYSKZVBP2PASEISLG3SBMTN5CE4QZUVZ3CE",
  USTRY: "CBLV4ATSIWU67CFSQU2NVRKINQIKUZ2ODSZBUJTJ43VJVRSBTZYOPNUR",
  CETES: "CAL6ER2TI6CTRAY6BFXWNWA7WTYXUXTQCHUBCIBU5O6KM3HJFG6Z6VXV",
  PYUSD: "CCCRWH6Q3FNP3I2I57BDLM5AFAT7O6OF6GKQOC6SSJNDAVRZ57SPHGU2",
} as const;

const dex = (assetId: string, maxDevPct: number): AssetPriceSource => ({
  assetId,
  kind: "reflector_dex",
  sourceOracleId: RDEX,
  viaAggregator: true,
  maxDevPct,
  resolutionSec: 300,
  maxAgeSec: 900,
  evidence: `asset_configs() on CD74A3…: Stellar(${assetId.slice(0, 6)}…) via oracle[0] CALI2B… (Reflector DEX), max_dev=${maxDevPct}% [reconstruction]`,
});

type Row = [sym: keyof typeof A, c: number, l: number, mu: number, cap: number, supplied: number, borrowed: number, price: number, src: AssetPriceSource];

function rows(): Row[] {
  return [
    ["XLM", 0.75, 0.75, 0.7, 1e9, 115_961_263.09, 8_300_795.81, 0.16115, dex(A.XLM, 0)],
    ["USDC", 0.95, 0.95, 0.95, 2e8, 7_487_935.53, 6_013_898.24, 1, { assetId: A.USDC, kind: "base", viaAggregator: true, evidence: "base() of CD74A3… [reconstruction]" }],
    ["EURC", 0.9, 0.9, 0.9, 1e7, 427_590.29, 326_119.47, 1.1765201, dex(A.EURC, 10)],
    ["AQUA", 0, 0.5, 0.7, 1e9, 46_478_936.03, 19_249_616.08, 0.0003491, dex(A.AQUA, 0)],
    ["USDGLO", 0.9, 0.9, 0.9, 1e5, 42_189.88, 32_638.24, 1, { assetId: A.USDGLO, kind: "fixed_peg", viaAggregator: true, evidence: "base-like asset of CD74A3… (fixed 1.0) [reconstruction]" }],
    ["USTRY", 0.9, 0.9, 0.8, 250_000, 2_255.81, 1_089.32, 1.0574269, dex(A.USTRY, 10)],
    ["CETES", 0.8, 0.8, 0.8, 2e7, 9_512_981.12, 4_429_022.74, 0.0670232, dex(A.CETES, 10)],
    ["PYUSD", 0.9, 0.9, 0.9, 5e6, 35_701.48, 27_831.36, 1, { assetId: A.PYUSD, kind: "fixed_peg", viaAggregator: true, evidence: "base-like asset of CD74A3… (fixed 1.0) [reconstruction]" }],
  ];
}

/** USTRY ask side per rekt.news ("fewer than five tokens"). */
export const RECONSTRUCTED_USTRY_ASKS: AskLevel[] = [{ price: 1.06, amount: 4.9 }];

export function yieldBloxReconstruction(opts: { ustryAsks?: AskLevel[] } = {}): PoolSnapshot {
  const reserves: ReserveSnapshot[] = rows().map(([sym, c, l, mu, cap, supplied, borrowed, price, src]) => ({
    assetId: A[sym],
    symbol: sym,
    decimals: 7,
    cFactor: c,
    lFactor: l,
    maxUtil: mu,
    supplyCap: cap,
    enabled: true,
    supplied,
    borrowed,
    priceUsd: price,
    priceTimestamp: BACKTEST_AS_OF - 60,
    source: src,
  }));
  const lpValueUsd = 4_385_291.18 * 0.35;
  return {
    poolId: YIELDBLOX_POOL,
    name: "YieldBlox (reconstruction @2026-02-22T00:00Z)",
    protocol: "blend",
    status: 1,
    admin: "CANSYFVMIP7JVYEZQ463Y2I2VLEVNLDJJ4QNZTDBGLOOGKURPTW4A6FQ",
    oracleId: AGG,
    oracleKind: "blend_aggregator",
    backstopRate: 0,
    reserves,
    backstop: {
      tokens: 4_385_291.18,
      shares: 3_969_986.47,
      q4wPct: 0.0052,
      usdc: lpValueUsd * 0.2,
      blnd: (lpValueUsd * 0.8) / 0.0634,
      meetsThreshold: true,
    },
    dexDepth: {
      [A.USTRY]: { assetId: A.USTRY, quote: "USDC", asks: opts.ustryAsks ?? RECONSTRUCTED_USTRY_ASKS, truncated: false, source: "rekt.news/yieldblox-rekt (reconstruction)" },
    },
    asOf: { timestamp: BACKTEST_AS_OF },
    dataGaps: [
      "RECONSTRUCTION: historical SDEX order books for XLM, CETES, EURC on 2026-02-21 are not obtainable (Horizon keeps no order-book history)",
    ],
    provenance: "RECONSTRUCTION from archived on-chain events + Horizon trade history + rekt.news (see backtest.ts header)",
  };
}

export interface BacktestResult {
  rating: ReturnType<typeof ratePool>;
  ustry: ManipulationResult;
  /** rho for USTRY as the reconstructed ask depth is scaled up (USD of asks below $1.06·100). */
  sensitivity: { askDepthUsd: number; rho: number | null; profitable: boolean; grade: string; eligible: boolean }[];
  /** What the attacker actually extracted (BlockSec / rekt): 1,000,196 USDC + 61,249,278 XLM. */
  actualExtractedUsd: number;
}

export function runYieldBloxBacktest(): BacktestResult {
  const snap = yieldBloxReconstruction();
  const rating = ratePool(snap);
  const ustry = ustryAssessment(snap);
  const sensitivity = [1, 1e2, 1e3, 1e4, 1e5, 1e6, 2e6, 5e6].map((scale) => {
    const asks = RECONSTRUCTED_USTRY_ASKS.map((a) => ({ price: a.price, amount: a.amount * scale }));
    const s = yieldBloxReconstruction({ ustryAsks: asks });
    const r = ratePool(s);
    const m = ustryAssessment(s);
    return { askDepthUsd: Math.round(asks.reduce((x, a) => x + a.amount * a.price, 0)), rho: m.rho, profitable: m.profitable, grade: r.grade, eligible: r.eligibleForDeposit };
  });
  return { rating, ustry, sensitivity, actualExtractedUsd: 1_000_196 + 61_249_278 * 0.16115 };
}

function ustryAssessment(snap: PoolSnapshot): ManipulationResult {
  const a = assessSdexCollateral(snap, derive(snap)).find((m) => m.assetId === A.USTRY);
  if (!a?.result) throw new Error("USTRY assessment missing");
  return a.result;
}
