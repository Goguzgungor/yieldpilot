/**
 * CLIENT-SAFE. The ratings page's "how a grade is made" guide: the engine's
 * factors, ceilings and deposit gates in plain words, and the pure functions
 * that tie each of them to the live ratings (which pools a rule caps, which are
 * weak on a factor, how many pass each gate).
 *
 * The weights, caps and grade bands are duplicated as literals because
 * score.ts imports node:crypto (via canonical.ts) and cannot ship to the
 * browser. guide.test.ts fails if they drift from score.ts.
 */

export type GuideGrade = "A" | "B" | "C" | "D" | "E";

/** score.ts GRADE_BANDS: lower bound of each grade. */
export const GUIDE_BANDS: ReadonlyArray<readonly [number, GuideGrade]> = [
  [80, "A"],
  [65, "B"],
  [50, "C"],
  [35, "D"],
  [0, "E"],
];

/** The minimum score RiskGate is installed with on YieldPilot wallets. */
export const RISKGATE_DEFAULT_MIN = 60;

/** What the guide needs from a rating (a subset of GET /api/ratings). */
export interface GuideRating {
  poolId: string;
  name: string;
  protocol: "blend" | "defindex";
  score: number | null;
  uncappedScore?: number;
  status: number;
  eligibleForDeposit: boolean;
  hardRules: string[];
  factors: Array<{ key: string; value: number }>;
  /** DeFindex: the Blend pool the strategy deposits into. */
  underlying?: string;
}

export interface GuideFactor {
  key: string;
  label: string;
  /** score.ts WEIGHTS */
  weight: number;
  /** What the engine reads, in one or two sentences. */
  reads: string;
  /** Why it weighs what it weighs. */
  why: string;
}

/** The seven factors, largest weight first. */
export const GUIDE_FACTORS: readonly GuideFactor[] = [
  {
    key: "utilization",
    label: "Liquidity",
    weight: 0.24,
    reads:
      "What lenders can withdraw from each reserve: the share not lent out (full marks up to 60% borrowed, none from 95%) or the dollars not lent out (none at $10K, full marks from $1M), whichever is better. The weakest reserve counts.",
    why: "Lenders can take back only what is not lent. A $150M reserve 99% borrowed still lets $1.5M out; a $40K one 80% borrowed lets $8K out.",
  },
  {
    key: "sdex_manipulation",
    label: "Manipulation cost",
    weight: 0.23,
    reads:
      "For collateral priced from SDEX trading: what it costs to push that price on the thinnest order book of the last 24 hours, against what could then be borrowed.",
    why: "The one failure that has drained a Blend pool: YieldBlox lost about $10M in February 2026 to collateral pushed ×100 on a thin book.",
  },
  {
    key: "oracle_source",
    label: "Price source",
    weight: 0.18,
    reads:
      "The weakest price feed behind any collateral. CEX and FX feeds score high; SDEX-built feeds, fixed pegs and an issuer's own push oracle score low.",
    why: "Every borrow is valued by the oracle, so a pool is only as sound as its weakest collateral price.",
  },
  {
    key: "oracle_freshness",
    label: "Price freshness",
    weight: 0.12,
    reads: "Whether every collateral and every borrowed asset has a fresh price.",
    why: "A stale price stops liquidations, and an unpriced debt counts as $0 in every total.",
  },
  {
    key: "supply_caps",
    label: "Supply caps",
    weight: 0.12,
    reads: "How much borrowing power a weakly priced collateral can create within its supply cap.",
    why: "Caps bound how far a mispriced collateral can reach into the pool's liquidity.",
  },
  {
    key: "backstop_coverage",
    label: "Backstop cover",
    weight: 0.06,
    reads:
      "The first-loss capital behind the pool, after its withdrawal queue, against what is borrowed. Full marks at 10% of borrows.",
    why: "The backstop absorbs bad debt before lenders do. It weighs little since v2.6: no Blend pool holding real deposits has a funded one, so it no longer tells pools apart. HR9 still caps a pool without one at B.",
  },
  {
    key: "collateral_concentration",
    label: "Concentration",
    weight: 0.05,
    reads: "How concentrated the supplied collateral is in a single asset.",
    why: "Concentration concentrates tail risk. Kept small so it does not count the price factors twice.",
  },
];

export interface GuideCeiling {
  id: string;
  /** Hard-rule codes (score.ts) this ceiling stands for. */
  codes: string[];
  label: string;
  detail: string;
  /** Highest score the rule allows (score.ts HARD_CAPS). */
  cap: number;
  grade: GuideGrade;
  /** Soft ceilings compress the scores above them instead of clipping them. */
  soft: boolean;
  /** Whether the rule also closes deposits. */
  closesDeposits: boolean;
}

/** The ceilings, mildest first. */
export const GUIDE_CEILINGS: readonly GuideCeiling[] = [
  {
    id: "weak",
    codes: ["HR6", "HR7"],
    label: "Weak price feed, or a backstop that is short or leaving",
    detail:
      "A collateral priced by anything weaker than RedStone, a Reflector CEX/FX feed or the base asset; or a backstop below Blend's threshold, or with 30% or more queued to leave. An A needs robust feeds and real first-loss capital.",
    cap: 79,
    grade: "B",
    soft: true,
    closesDeposits: false,
  },
  {
    id: "first-loss",
    codes: ["HR9"],
    label: "Almost no first-loss capital",
    detail:
      "Borrowing of $1K or more with a backstop covering under 1% of it. Any bad debt goes straight to lenders, however clean the price feeds are, so an A needs real first-loss capital (at most C until v2.6).",
    cap: 79,
    grade: "B",
    soft: true,
    closesDeposits: false,
  },
  {
    id: "locked-in",
    codes: ["HR10"],
    label: "Lenders locked in",
    detail:
      "A reserve borrowed to its own max_util with under $1M withdrawable, now or in any read of the last 6 hours. Its lenders can only take out what is not lent, and a new deposit is the first money they can withdraw.",
    cap: 64,
    grade: "C",
    soft: false,
    closesDeposits: true,
  },
  {
    id: "unknown-source",
    codes: ["HR5"],
    label: "Price source cannot be identified",
    detail: "A collateral whose oracle the engine cannot attribute to a known feed.",
    cap: 64,
    grade: "C",
    soft: false,
    closesDeposits: true,
  },
  {
    id: "missing-price",
    codes: ["HR2"],
    label: "A price is missing or stale",
    detail: "On any collateral or any borrowed asset. Liquidations stop and debts read as $0.",
    cap: 49,
    grade: "D",
    soft: false,
    closesDeposits: true,
  },
  {
    id: "pushable",
    codes: ["HR3"],
    label: "Collateral can be pushed profitably",
    detail:
      "Pushing the SDEX price of a collateral, on the thinnest book of the last 24 hours, costs less than what could then be borrowed against it. This is how YieldBlox was drained.",
    cap: 34,
    grade: "E",
    soft: false,
    closesDeposits: true,
  },
];

/** The rule text without DeFindex's "underlying: " prefix. */
function bare(rule: string): string {
  return rule.replace(/^underlying: /, "");
}

/** Whether a rating carries a hard rule with this code. "HR1" does not match "HR10". */
export function hasRule(r: Pick<GuideRating, "hardRules">, code: string): boolean {
  return r.hardRules.some((h) => bare(h).startsWith(`${code} `));
}

/** Ratings a ceiling applies to today. */
export function cappedBy(ratings: readonly GuideRating[], ceiling: GuideCeiling): GuideRating[] {
  return ratings.filter((r) => ceiling.codes.some((c) => hasRule(r, c)));
}

export interface FactorReading {
  poolId: string;
  name: string;
  value: number;
}

/** A factor's value on every graded Blend pool, weakest first. */
export function factorReadings(ratings: readonly GuideRating[], key: string): FactorReading[] {
  const out: FactorReading[] = [];
  for (const r of ratings) {
    if (r.protocol !== "blend" || r.score === null) continue;
    const f = r.factors.find((x) => x.key === key);
    if (f) out.push({ poolId: r.poolId, name: r.name, value: f.value });
  }
  return out.sort((a, b) => a.value - b.value || a.name.localeCompare(b.name));
}

/** Score below which a factor counts as weak in the guide. */
export const WEAK_FACTOR = 50;

/**
 * Pools weak on a factor (graded Blend pools under {@link WEAK_FACTOR}), plus
 * the DeFindex strategies that deposit into them.
 */
export function weakOn(ratings: readonly GuideRating[], key: string): Set<string> {
  const weak = new Set(factorReadings(ratings, key).filter((x) => x.value < WEAK_FACTOR).map((x) => x.poolId));
  for (const r of ratings) if (r.protocol === "defindex" && r.underlying && weak.has(r.underlying)) weak.add(r.poolId);
  return weak;
}

export interface GateStep {
  id: string;
  label: string;
  detail: string;
  poolIds: string[];
}

/**
 * How many Blend pools pass each deposit gate, in order. Each step is a subset
 * of the one before it.
 */
export function depositFunnel(ratings: readonly GuideRating[], minScore = RISKGATE_DEFAULT_MIN): GateStep[] {
  const blend = ratings.filter((r) => r.protocol === "blend");
  const rated = blend.filter((r) => r.score !== null);
  // Blend refuses supply above status 3 (pool.rs require_action_allowed).
  const open = rated.filter((r) => r.status <= 3);
  const eligible = open.filter((r) => r.eligibleForDeposit);
  const clears = eligible.filter((r) => (r.score ?? 0) >= minScore);
  const ids = (xs: GuideRating[]) => xs.map((r) => r.poolId);
  return [
    {
      id: "found",
      label: "Found on-chain",
      detail: "Every pool in the deploy history of Blend's two V2-code factories, each confirmed with is_pool.",
      poolIds: ids(blend),
    },
    {
      id: "rated",
      label: "Rated",
      detail: "A pool that never launched, or holds under $10K, is not rated (NR): there is no market to measure.",
      poolIds: ids(rated),
    },
    {
      id: "open",
      label: "Blend takes deposits",
      detail: "Blend refuses new supply when a pool is frozen or was never launched, whatever its grade.",
      poolIds: ids(open),
    },
    {
      id: "eligible",
      label: "Eligible under Vigil",
      detail:
        "Also closed: a backstop queue one update_status call from freezing the pool, lenders locked in, a score under 50, and every ceiling that closes deposits.",
      poolIds: ids(eligible),
    },
    {
      id: "clears",
      label: `Clears RiskGate's ${minScore}`,
      detail: `The minimum YieldPilot wallets are installed with. Below it the on-chain guard refuses the deposit, so the agent holds.`,
      poolIds: ids(clears),
    },
  ];
}
