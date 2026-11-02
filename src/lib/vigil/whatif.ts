/**
 * "What would it take?" — for each pool, the smallest set of protocol-side
 * changes after which the engine itself would grade the pool B (65+) or A (80+).
 *
 * Each lever is a concrete change someone can make (refill the backstop, a
 * better price feed, a supply cap, a fresh price). Pool status is not graded
 * (it only opens or closes deposits), so admin actions are not levers.
 * Combinations are applied to the snapshot and re-scored with {@link ratePool},
 * so the answer always follows the current methodology. Market conditions
 * (utilization, collateral mix, pool size) are not levers, so a pool that is
 * not rated (NR) has no path. Paths are informational: they are not part of the
 * rating or its reasonsHash.
 */
import {
  assessSdexCollateral,
  derive,
  lendersLockedIn,
  priceProblem,
  ratePool,
  sourceQuality,
  THRESHOLDS,
  weakCollateral,
  type RateOptions,
} from "./score";
import type { Grade, GradePath, GradePaths, LeverKey, PoolSnapshot, ReserveSnapshot } from "./types";

export type { GradePath, GradePaths, LeverKey };

const TARGET_MIN = { A: 80, B: 65 } as const;
const WEAK_SOURCE = THRESHOLDS.robustSourceQuality;

/** Plain-language names for price-source kinds, for the steps users read. */
const SOURCE_NAMES: Partial<Record<string, string>> = {
  fixed_peg: "a fixed peg",
  issuer_push: "the issuer's push oracle",
  reflector_dex: "Reflector's DEX feed",
  sdex_other: "an SDEX-based feed",
  protocol_model: "a protocol pricing model",
  opaque: "an unidentified adapter",
};

interface Lever {
  key: LeverKey;
  step: string;
  apply(s: PoolSnapshot): PoolSnapshot;
}

const usd = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`);
const qty = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toFixed(0));
const isCollateral = (r: ReserveSnapshot) => r.enabled && r.cFactor >= THRESHOLDS.minCollateralFactor;
const mapReserves = (s: PoolSnapshot, ids: Set<string>, f: (r: ReserveSnapshot) => ReserveSnapshot): PoolSnapshot => ({
  ...s,
  reserves: s.reserves.map((r) => (ids.has(r.assetId) ? f(r) : r)),
});

function leversFor(s: PoolSnapshot, opts: RateOptions): Lever[] {
  const out: Lever[] = [];
  const d = derive(s);
  const rating = ratePool(s, opts);
  const factor = (k: string) => rating.factors.find((f) => f.key === k)?.value ?? 100;

  // 1 — backstop. Once the backstop meets its threshold and the withdrawal queue
  // is under 30%, anyone can call Blend's permissionless update_status, which
  // reactivates an On_Ice / Frozen pool.
  const b = s.backstop;
  const autoStatus = s.status === 3 || s.status === 5;
  const queued = !!b && b.q4wPct >= THRESHOLDS.backstopQueueOnIce;
  if (!b || !b.meetsThreshold || queued || factor("backstop_coverage") < 100 || autoStatus) {
    const liabilities = d.reduce((a, x) => a + x.borrowedUsd, 0);
    const neededUsd = Math.max(liabilities * THRESHOLDS.backstopFullCoverage, 1);
    const sized = liabilities >= THRESHOLDS.minLiabilitiesUsd;
    // A funded backstop whose only problem is the queue needs the queue cut, not a refill.
    const onlyQueue = !!b && b.meetsThreshold && queued && factor("backstop_coverage") >= 100;
    out.push({
      key: "backstop",
      step:
        (onlyQueue
          ? `Bring the backstop's withdrawal queue under 30% (now ${(b.q4wPct * 100).toFixed(1)}%), with new backstop deposits or cancelled withdrawals`
          : sized
            ? `Refill the backstop to at least ${usd(neededUsd)} (10% of the pool's ${usd(liabilities)} of borrows), above Blend's threshold, with under 30% queued for withdrawal`
            : "Refill the backstop above Blend's threshold, with under 30% queued for withdrawal") +
        (autoStatus ? ". Anyone can then call Blend's update_status, which reactivates the pool" : "") +
        (s.deployment === "v2" ? " (Blend's app now takes backstop deposits for v2.1 pools only)" : ""),
      apply: (x) => ({
        ...x,
        status: x.status === 3 || x.status === 5 ? 1 : x.status,
        backstop: {
          tokens: b?.tokens ?? 0,
          shares: b?.shares ?? 0,
          blnd: b?.blnd ?? 0,
          q4wPct: 0,
          meetsThreshold: true,
          usdc: Math.max(b?.usdc ?? 0, neededUsd / THRESHOLDS.cometUsdcMultiplier),
        },
      }),
    });
  }

  // 3 — weak price sources on collateral (same set HR6 caps on).
  const weak = weakCollateral(d, assessSdexCollateral(s, d, opts.manipulation)).map((x) => x.r);
  if (weak.length) {
    const kinds = [...new Set(weak.map((r) => `${SOURCE_NAMES[r.source.kind] ?? r.source.kind}${r.source.inferred ? " (inferred)" : ""}`))].join(" / ");
    out.push({
      key: "oracle",
      step: `Price ${weak.map((r) => r.symbol).join(", ")} from a robust feed (a CEX/FX feed such as Reflector CEX, behind a max_dev limit) instead of ${kinds}`,
      apply: (x) =>
        mapReserves(x, new Set(weak.map((r) => r.assetId)), (r) => ({
          ...r,
          source: { ...r.source, kind: "reflector_cex", inferred: false, viaAggregator: true, maxDevPct: r.source.maxDevPct ? r.source.maxDevPct : 10 },
        })),
    });
  }

  // 4 — supply caps on weakly-priced collateral.
  if (factor("supply_caps") < 100) {
    const liquidity = d.reduce((a, x) => a + x.availableUsd, 0);
    const capped = d.filter((x) => isCollateral(x.r) && x.priced && sourceQuality(x.r) < WEAK_SOURCE);
    const caps = new Map(capped.map((x) => [x.r.assetId, (0.1 * liquidity) / ((x.r.priceUsd as number) * x.r.cFactor)]));
    if (caps.size) {
      out.push({
        key: "caps",
        step: `Cap the supply of ${capped
          .map((x) => `${x.r.symbol} at about ${qty(caps.get(x.r.assetId) as number)}`)
          .join(", ")}, so its borrowing power stays under 10% of the ${usd(liquidity)} available to borrow`,
        apply: (x) => mapReserves(x, new Set(caps.keys()), (r) => ({ ...r, supplyCap: Math.min(r.supplyCap ?? Infinity, caps.get(r.assetId) as number) })),
      });
    }
  }

  // 5 — stale (not missing) prices.
  const stale = s.reserves.filter((r) => r.enabled && priceProblem(r, s.asOf.timestamp) === "stale");
  if (stale.length) {
    out.push({
      key: "fresh",
      step: `The oracle publishes fresh prices for ${stale.map((r) => r.symbol).join(", ")}`,
      apply: (x) => mapReserves(x, new Set(stale.map((r) => r.assetId)), (r) => ({ ...r, priceTimestamp: x.asOf.timestamp })),
    });
  }
  return out;
}

function combos<T>(items: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (items.length < k) return [];
  const [head, ...tail] = items;
  return [...combos(tail, k - 1).map((c) => [head, ...c]), ...combos(tail, k)];
}

function blockerFor(s: PoolSnapshot, best: { score: number }, target: "A" | "B"): string {
  const missing = s.reserves.filter((r) => r.enabled && priceProblem(r, s.asOf.timestamp) === "missing").map((r) => r.symbol);
  if (missing.length) return `No price at all for ${missing.join(", ")}: the oracle has to publish one before this pool can be rated higher.`;
  const locked = lendersLockedIn(s, derive(s));
  if (locked) return `${locked}. The pool stays at most C and closed to deposits until borrowers repay or lenders add supply, and no read within ${THRESHOLDS.lockWindowSec / 3600} h is at max_util.`;
  return `Even with every change above the engine would give ${best.score}; market conditions (utilization, collateral mix) keep it under ${TARGET_MIN[target]}.`;
}

export function pathsToGrades(s: PoolSnapshot, opts: RateOptions = {}): GradePaths {
  const now = ratePool(s, opts);
  if (now.score === null) {
    const blocker = `Not rated: ${now.notRated}. A grade needs a launched pool with a market in it.`;
    const nr = (target: "A" | "B"): GradePath => ({ target, already: false, reachable: false, levers: [], steps: [], score: null, grade: null, blocker });
    return { A: nr("A"), B: nr("B") };
  }
  const nowScore = now.score;
  const levers = leversFor(s, opts);
  const rate = (c: Lever[]) => ratePool(c.reduce((x, l) => l.apply(x), s), opts);

  const bestAll = levers.length ? rate(levers) : now;
  const bestAllScore = bestAll.score ?? nowScore;

  const path = (target: "A" | "B"): GradePath => {
    const min = TARGET_MIN[target];
    if (nowScore >= min) return { target, already: true, reachable: true, levers: [], steps: [], score: nowScore, grade: now.grade as Grade };
    for (let k = 1; k <= levers.length; k++) {
      let best: { c: Lever[]; score: number; grade: Grade } | null = null;
      for (const c of combos(levers, k)) {
        const r = rate(c);
        if (r.score !== null && r.score >= min && (!best || r.score > best.score)) best = { c, score: r.score, grade: r.grade as Grade };
      }
      if (best) {
        return { target, already: false, reachable: true, levers: best.c.map((l) => l.key), steps: best.c.map((l) => l.step), score: best.score, grade: best.grade };
      }
    }
    return { target, already: false, reachable: false, levers: [], steps: [], score: null, grade: null, blocker: blockerFor(s, { score: bestAllScore }, target) };
  };
  return { A: path("A"), B: path("B") };
}
