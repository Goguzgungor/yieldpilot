/**
 * Step 03 of /integrate: one live `get_rating` call, drawn three ways at once —
 * the path it takes through the integrator's system, the request and answer,
 * and the lines of code that make it. Pure and client-safe; the call itself is
 * in registryCall.ts.
 */
import { VIGIL, type PathId, type Where } from "./facts";

/** `get_rating`'s answer: `Some(Rating)`, or `None` (null) when nothing fresh is published. */
export interface OnchainRating {
  score: number;
  publishers: number;
  /** Oldest counted submission, unix seconds. */
  timestamp: number;
}

export type CheckId = "exists" | "fresh" | "min";
export type CheckState = "pass" | "fail" | "skipped";
export type GuardCode = 4114 | 4115 | 4116;

export interface CheckResult {
  id: CheckId;
  state: CheckState;
  /** e.g. "76 ≥ 60", "41 min old, within 2 h". */
  note: string;
}

export interface RatingCheck {
  allowed: boolean;
  /** RiskGate's code for the first failed check (the registry paths name the same three). */
  code: GuardCode | null;
  failed: CheckId | null;
  checks: CheckResult[];
}

const CODE: Record<CheckId, GuardCode> = { exists: 4114, fresh: 4116, min: 4115 };

/** A ledger may close a little ahead of the visitor's clock; a timestamp this far ahead still reads as fresh. */
export const CLOCK_SKEW_SECS = 300;

/**
 * The order the checks run in. RiskGate tests the score before freshness
 * (contracts/vigil-guard check_rating); the registry snippets test freshness
 * first. The first failure decides the error, so the order shows.
 */
export function checkOrder(path: PathId): CheckId[] {
  return path === "riskgate" ? ["exists", "min", "fresh"] : ["exists", "fresh", "min"];
}

function duration(secs: number): string {
  if (secs < 60) return `${secs} s`;
  const m = Math.round(secs / 60);
  return m < 90 ? `${m} min` : `${Math.round((m / 60) * 10) / 10} h`;
}

/** Run the integrator's rule on a live `get_rating` answer, in the path's order. */
export function checkRating(
  r: OnchainRating | null,
  opts: { path: PathId; minScore: number; maxAgeSecs: number; nowSecs: number },
): RatingCheck {
  const verdicts: Record<CheckId, () => { pass: boolean; note: string }> = {
    exists: () => (r ? { pass: true, note: "Some(Rating)" } : { pass: false, note: "None: no fresh rating is published for this pool" }),
    fresh: () => {
      const age = opts.nowSecs - r!.timestamp;
      if (age < -CLOCK_SKEW_SECS) return { pass: false, note: `timestamp is ${duration(-age)} in the future` };
      const shown = duration(Math.max(0, age));
      return age <= opts.maxAgeSecs
        ? { pass: true, note: `${shown} old, within ${duration(opts.maxAgeSecs)}` }
        : { pass: false, note: `${shown} old, over ${duration(opts.maxAgeSecs)}` };
    },
    min: () =>
      r!.score >= opts.minScore
        ? { pass: true, note: `${r!.score} ≥ ${opts.minScore}` }
        : { pass: false, note: `${r!.score} < ${opts.minScore}${r!.score === 0 ? " (Vigil holds this pool back, so the registry signs 0)" : ""}` },
  };
  let failed: CheckId | null = null;
  const checks = checkOrder(opts.path).map((id): CheckResult => {
    if (failed) return { id, state: "skipped", note: "not reached" };
    const v = verdicts[id]();
    if (!v.pass) failed = id;
    return { id, state: v.pass ? "pass" : "fail", note: v.note };
  });
  return { allowed: failed === null, code: failed ? CODE[failed] : null, failed, checks };
}

export interface FlowNode {
  title: string;
  sub: string;
}

export interface Flow {
  /** ① caller, ② where the check runs, ③ the registry. */
  nodes: [FlowNode, FlowNode, FlowNode];
  /** What the visitor's browser does in place of ② (it can't run their code). */
  stands: string;
}

/** The path a deposit check takes on-chain; null for the ratings API, which never touches the chain. */
export function flowFor(path: PathId, where: Where): Flow | null {
  const registry: FlowNode = { title: `RiskRegistry · ${VIGIL.network}`, sub: "get_rating(pool)" };
  if (path === "api") return null;
  if (path === "riskgate") {
    return {
      nodes: [
        { title: "Your dApp or agent", sub: "pool.submit([Supply])" },
        { title: "User's smart account", sub: "RiskGate enforce()" },
        registry,
      ],
      stands: "RiskGate makes this call inside the smart account's authorization; your browser makes the same call directly.",
    };
  }
  if (where === "contract") {
    return {
      nodes: [
        { title: "Your dApp", sub: "deposit(pool, amount)" },
        { title: "Your contract", sub: "require_rated(pool)" },
        registry,
      ],
      stands: "Your contract makes this call cross-contract; your browser makes the same call directly.",
    };
  }
  return {
    nodes: [
      { title: "Your backend", sub: "depositAllowed(pool)" },
      { title: `Soroban RPC · ${VIGIL.network}`, sub: "simulateTransaction" },
      registry,
    ],
    stands: "Your backend sends exactly this request; here your browser sends it.",
  };
}

/** What the integrator's system does with the answer. */
export function outcomeFor(path: PathId, where: Where, c: RatingCheck): string {
  const name: Record<CheckId, string> = { exists: "RatingUnavailable", fresh: "RatingStale", min: "ScoreTooLow" };
  if (path === "riskgate") {
    return c.allowed
      ? "RiskGate returns, the smart account authorizes the call, and the Blend pool takes the deposit."
      : `RiskGate panics with Error(Contract, #${c.code}) ${name[c.failed!]}: the whole transaction reverts. Withdrawals are never checked.`;
  }
  if (where === "contract") {
    return c.allowed
      ? "require_rated returns and your contract moves the funds."
      : `require_rated panics with RiskError::${name[c.failed!]} and your deposit reverts.`;
  }
  const reason = { exists: "no rating (4114)", fresh: "rating too old (4116)", min: "score below the minimum (4115)" };
  return c.allowed
    ? "depositAllowed returns { allowed: true } and your backend sends the deposit."
    : `depositAllowed returns { allowed: false, reason: "${reason[c.failed!]}" } and your backend skips the pool.`;
}

export interface CodeLine {
  text: string;
  /** Which flow node (1..3) this line belongs to, so it lights with the call. */
  step?: 1 | 2 | 3;
  /** Which check this line makes, so the live answer is written next to it. */
  check?: CheckId;
  /** The integrator's own code around the snippet (not copied from it). */
  caller?: true;
}

export interface LiveCode {
  lang: "rust" | "ts";
  /** Who writes this code, e.g. "Your contract (Rust)". */
  label: string;
  lines: CodeLine[];
}

/** The lines behind the live call, an excerpt of the brief's snippet for the same path. */
export function liveCodeFor(path: PathId, where: Where): LiveCode | null {
  if (path === "api") return null;
  if (path === "riskgate") {
    return {
      lang: "rust",
      label: "RiskGate (contracts/vigil-guard): you install it, you don't write it",
      lines: [
        { text: "// your agent signs pool.submit(account, account, account, [Supply])", step: 1 },
        { text: "// the account's context rule runs RiskGate's enforce() first", step: 2 },
        { text: "let rating = match RiskRegistryClient::new(e, registry).try_get_rating(pool) {", step: 3 },
        { text: "    Ok(Ok(Some(r))) => r,", step: 3 },
        { text: "    _ => panic_with_error!(e, GuardError::RatingUnavailable), // #4114", check: "exists" },
        { text: "};" },
        { text: "if rating.score < params.min_score {", check: "min" },
        { text: "    panic_with_error!(e, GuardError::ScoreTooLow); // #4115" },
        { text: "}" },
        { text: "let now = e.ledger().timestamp();" },
        { text: "if rating.timestamp > now || now - rating.timestamp > params.max_age_secs {", check: "fresh" },
        { text: "    panic_with_error!(e, GuardError::RatingStale); // #4116" },
        { text: "}" },
      ],
    };
  }
  if (where === "contract") {
    return {
      lang: "rust",
      label: "Your contract (Rust)",
      lines: [
        { text: "pub fn deposit(env: Env, pool: Address, amount: i128) {", step: 1, caller: true },
        { text: "    require_rated(&env, &registry_id(&env), &pool); // id from your config", step: 2, caller: true },
        { text: "    // … move `amount` into `pool`" },
        { text: "}", caller: true },
        { text: "" },
        { text: "pub fn require_rated(env: &Env, registry: &Address, pool: &Address) {", step: 2 },
        { text: "    let rating = RiskRegistryClient::new(env, registry)", step: 3 },
        { text: "        .get_rating(pool)", step: 3 },
        { text: "        .unwrap_or_else(|| panic_with_error!(env, RiskError::RatingUnavailable));", check: "exists" },
        { text: "    let now = env.ledger().timestamp();" },
        { text: "    if rating.timestamp > now || now - rating.timestamp > MAX_AGE_SECS {", check: "fresh" },
        { text: "        panic_with_error!(env, RiskError::RatingStale);" },
        { text: "    }" },
        { text: "    if rating.score < MIN_SCORE {", check: "min" },
        { text: "        panic_with_error!(env, RiskError::ScoreTooLow);" },
        { text: "    }" },
        { text: "}" },
      ],
    };
  }
  return {
    lang: "ts",
    label: "Your backend (TypeScript)",
    lines: [
      { text: "const check = await depositAllowed(pool);", step: 1, caller: true },
      { text: "if (!check.allowed) return skip(pool, check.reason);", step: 1, caller: true },
      { text: "" },
      { text: "// depositAllowed(pool), in vigil-registry.ts" },
      { text: "const r = await getRating(pool);", step: 1 },
      { text: 'if (!r) return { allowed: false, reason: "no rating (4114)" };', check: "exists" },
      { text: 'if (r.timestamp > nowSecs || nowSecs - r.timestamp > BigInt(MAX_AGE_SECS)) return { allowed: false, reason: "rating too old (4116)" };', check: "fresh" },
      { text: "if (r.score < MIN_SCORE) return { allowed: false, reason: `score ${r.score} < ${MIN_SCORE} (4115)` };", check: "min" },
      { text: "return { allowed: true, reason: `score ${r.score}` };" },
      { text: "" },
      { text: "// getRating(pool): the request this page sends" },
      { text: '.addOperation(new Contract(REGISTRY).call("get_rating", new Address(pool).toScVal()))', step: 3 },
      { text: "const sim = await server.simulateTransaction(tx);", step: 2 },
      { text: "const v = sim.result?.retval ? scValToNative(sim.result.retval) : null;", step: 2 },
    ],
  };
}
