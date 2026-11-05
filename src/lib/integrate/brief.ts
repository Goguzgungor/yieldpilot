/**
 * The text an integrating project hands to its AI: `buildBrief` for the
 * choices made on /integrate, `fullGuide` for /integrate.md (everything, for an
 * AI that reads the guide itself). Pure strings, client-safe.
 */
import { DEFAULT_MAX_AGE_SECS, DEFAULT_MIN_SCORE, PATHS, VIGIL, depositVerdict, type PathId, type VerdictRating, type Where } from "./facts";
import { snippet, type SnippetId } from "./snippets";

/** RiskGate (41xx) refusals, from contracts/vigil-guard. */
export const RISKGATE_ERRORS: Array<[code: number, name: string, meaning: string]> = [
  [4100, "NotInstalled", "no RiskGate params for this smart account and rule"],
  [4101, "AlreadyInstalled", "RiskGate is already on this rule"],
  [4102, "InvalidParams", "min_score over 100, a minimum without a registry, or a registry with max_age_secs 0"],
  [4103, "OnlyCallContract", "RiskGate attaches only to CallContract rules"],
  [4104, "NoSigners", "not every signer of the rule authenticated"],
  [4105, "ContextNotAllowed", "contract creation is refused"],
  [4106, "WrongContract", "the called contract is not the rule's target"],
  [4107, "FunctionNotAllowed", "only submit, submit_with_allowance, claim and transfer pass"],
  [4108, "BadArgs", "the arguments do not decode as Blend's or the token's"],
  [4109, "AccountMismatch", "from, spender and to must all be the smart account"],
  [4110, "EmptyRequests", "submit with no requests"],
  [4111, "RequestTypeNotAllowed", "only supply and withdraw (request types 0 to 3)"],
  [4112, "NegativeAmount", "a negative amount"],
  [4113, "RecipientNotAllowed", "a transfer to an address not in allowed_recipients"],
  [4114, "RatingUnavailable", "the registry has no rating for the pool"],
  [4115, "ScoreTooLow", "the pool's rating is under the account's minimum"],
  [4116, "RatingStale", "the pool's rating is older than max_age_secs"],
];

export interface BriefOptions {
  path: PathId;
  /** Only read for the registry path. */
  where: Where;
  minScore: number;
  maxAgeSecs: number;
  /** Live pools to test against: one Vigil allows at the minimum, one it refuses. */
  examples?: { pass?: VerdictRating; block?: VerdictRating };
  /** ISO date the examples were read, for the brief's "as of". */
  asOf?: string;
}

export function snippetFor(path: PathId, where: Where): SnippetId {
  if (path === "registry") return where === "contract" ? "registry-rust" : "registry-ts";
  return path;
}

const BANDS_LINE = "Grades: A is 80 and up, B 65 to 79, C 50 to 64, D 35 to 49, E under 35.";

function goal(path: PathId, where: Where): string {
  switch (path) {
    case "api":
      return "our app shows each pool's Vigil grade, and our backend never sends a deposit to a pool Vigil does not allow";
    case "registry":
      return where === "contract"
        ? "our Soroban contract checks the pool's Vigil rating on-chain before it moves funds into the pool, and reverts otherwise"
        : "our backend checks the pool's on-chain Vigil rating before every deposit and refuses the deposit when the check fails";
    case "riskgate":
      return "our users' OpenZeppelin smart accounts refuse, on-chain, every deposit into a pool rated under our minimum, even when our own agent key signs it";
  }
}

function lookFor(path: PathId, where: Where): string {
  switch (path) {
    case "api":
      return "where we list pools to users and where our backend picks the pool a deposit goes to";
    case "registry":
      return where === "contract" ? "the contract function that deposits into a pool" : "the function that builds or submits a deposit";
    case "riskgate":
      return "where users' smart accounts get their context rules (onboarding) and the rule our agent signs pool calls under";
  }
}

function facts(path: PathId, where: Where): string[] {
  const registry = [
    `RiskRegistry: \`${VIGIL.registryId}\` on Stellar ${VIGIL.network} (RPC ${VIGIL.rpcUrl}, passphrase "${VIGIL.networkPassphrase}").`,
    "`get_rating(pool: Address) -> Option<Rating>`, with `Rating { score: u32, publishers: u32, timestamp: u64 }`: the median of the fresh publisher submissions, and the oldest of their timestamps.",
    `Today: ${VIGIL.publishers} publisher, threshold ${VIGIL.threshold}; a submission counts for ${VIGIL.registryMaxAgeSecs} s and a new one is signed every ${VIGIL.publishEveryMin} minutes. If publishing stops, ratings go stale and checks fail closed.`,
    "The registry holds a pool's score when Vigil allows deposits, 0 when a hard rule holds the pool back, and nothing (None) for a pool it does not rate.",
    "Pools are keyed by their mainnet contract ids, plus YieldPilot's testnet demo pool `" + VIGIL.demoPoolId + "`, which carries the rating of the mainnet pool YieldPilot holds.",
  ];
  switch (path) {
    case "api":
      return [
        `\`GET ${VIGIL.apiRatings}\`: no key, CORS open. Top level: \`engineVersion\`, \`computedAt\` (unix seconds), \`stale\` (true when the last refresh failed), \`ratings[]\`.`,
        "Each rating: `poolId`, `name`, `protocol` (blend | defindex), `grade` (A to E, or NR for not rated), `score` (0 to 100, higher is safer, null when NR), `eligibleForDeposit`, `reasons[]`, `hardRules[]`, `tvlUsd`, `yields[]`.",
        "A deposit is allowed when the pool is rated, `eligibleForDeposit` is true and `score` is at least the minimum. This is the same rule RiskGate enforces on-chain.",
        `Every run's inputs are archived for 90 days at \`${VIGIL.apiRuns}\`, so a rating can be recomputed and checked.`,
      ];
    case "registry":
      return where === "contract"
        ? [...registry, "A Soroban contract can call the registry only on the same network: testnet today. A mainnet contract cannot call it yet; until a mainnet registry exists, check from the backend for mainnet."]
        : registry;
    case "riskgate":
      return [
        `RiskGate: \`${VIGIL.guardId}\` on ${VIGIL.network}, an OpenZeppelin smart-account policy shared by every account; no admin, no upgrade.`,
        "Install with `add_policy(context_rule_id, RISKGATE, params)` on the smart account (the owner authorizes), or pass it in the policies map of `add_context_rule`.",
        "On a pool rule it allows only `submit` / `submit_with_allowance` with from = spender = to = the smart account and request types 0 to 3, and `claim` to the account itself. Any request of type 0 (Supply) or 2 (SupplyCollateral) needs a fresh rating at or above `min_score`; withdrawals are never rating-gated.",
        "On a token rule it allows only `transfer` from the smart account to an address in `allowed_recipients`.",
        "Every other function on the guarded rule is refused (#4107), so RiskGate fits Blend pool rules; it does not know DeFindex vault calls.",
        ...registry,
        `On testnet, the only rated pool you can call is YieldPilot's demo pool \`${VIGIL.demoPoolId}\`; a deposit into any other testnet pool fails with #4114.`,
        "Built on stellar-accounts 0.8 and tested against the OpenZeppelin smart account 0.7 wasm.",
      ];
  }
}

function doneWhen(path: PathId, where: Where): string[] {
  switch (path) {
    case "api":
      return [
        "Pools show their Vigil grade and score; unrated pools say \"not rated\".",
        "The code that picks a deposit target calls `depositAllowed` and skips every pool it refuses.",
        "If the API call fails or `computedAt` is older than `MAX_AGE_SECS`, no deposit is made (fail closed) and the reason is logged.",
        "Unit tests use a saved API response, with no live network calls, and cover: allowed, under the minimum, held back (`eligibleForDeposit: false`), not rated, stale, API down.",
      ];
    case "registry":
      return where === "contract"
        ? [
            "The deposit function calls `require_rated(&env, &registry, &pool)` before it moves funds; withdrawals do not call it.",
            "The registry address lives in the contract's config, set at construction and changeable only by the admin.",
            "Tests (soroban-sdk testutils) register a mock registry contract that implements `get_rating`, and cover: allowed, no rating, stale, under the minimum.",
            `On testnet, the check passes for YieldPilot's demo pool \`${VIGIL.demoPoolId}\` while its rating is at or above the minimum, and fails for a pool the registry does not rate.`,
          ]
        : [
            "Every deposit calls `depositAllowed(pool)` first; a refusal or a thrown error stops the deposit and logs the reason.",
            "Tests mock `simulateTransaction` (no network) and cover: allowed, no rating (4114), under the minimum (4115), too old (4116), RPC error.",
            "One manual run against testnet returns a score for a pool Vigil rates.",
          ];
    case "riskgate":
      return [
        "New smart accounts get RiskGate on the agent's pool rule (`poolRuleParams()`) and on its token rule (`tokenRuleParams([pool ids])`) during onboarding.",
        "Existing accounts get `installRiskGateOp`, authorized by each account's owner.",
        `On a testnet account installed with a minimum of 100, a deposit (\`submit\` with request type 0) into the demo pool fails with Error(Contract, #4115) and a withdrawal (type 1 or 3) still succeeds.`,
        "With the real minimum, a deposit into an unrated testnet pool fails with #4114, and a token transfer to an address outside `allowed_recipients` fails with #4113.",
        "The UI names a RiskGate refusal (`riskGateError`) instead of showing a raw host error.",
      ];
  }
}

function examplesBlock(o: BriefOptions): string[] {
  const { pass, block } = o.examples ?? {};
  if (!pass && !block) return [];
  const line = (r: VerdictRating) => {
    const v = depositVerdict(r, o.minScore);
    return `- ${r.name} \`${r.poolId}\`: ${r.grade}${r.score === null ? "" : ` ${r.score}`}, deposit ${v.allowed ? "allowed" : "refused"} (${v.reason}).`;
  };
  return [
    `## Live examples${o.asOf ? ` (as of ${o.asOf})` : ""}`,
    "",
    "What Vigil says about two mainnet pools at your minimum. Ratings move every 30 minutes, so re-read them from the API before you rely on these in a test.",
    "",
    ...(pass ? [line(pass)] : []),
    ...(block ? [line(block)] : []),
    "",
  ];
}

export function buildBrief(o: BriefOptions): string {
  const p = PATHS[o.path];
  const s = snippet(snippetFor(o.path, o.where), { minScore: o.minScore, maxAgeSecs: o.maxAgeSecs });
  const network = o.path === "api" ? "mainnet ratings over HTTPS" : `Stellar ${VIGIL.network} (the registry and RiskGate are not on mainnet yet)`;
  return [
    `# Integrate Vigil pool risk ratings: ${p.title}`,
    "",
    `You are working in our codebase. We are adding Vigil, a risk rating for Stellar lending pools (Blend V2 and v2.1, and DeFindex strategies), so that ${goal(o.path, o.where)}.`,
    "",
    `First read the full integration guide: ${VIGIL.guideMd}`,
    `Then find ${lookFor(o.path, o.where)}, and tell me your plan before you change anything.`,
    "",
    "## Decisions already made",
    "",
    `- Path: ${p.title} (${p.sub}).`,
    `- Minimum score: ${o.minScore}. A pool must score at least this to receive a deposit. ${BANDS_LINE}`,
    `- Maximum rating age: ${o.maxAgeSecs} seconds.`,
    `- Network: ${network}.`,
    "- Fail closed: when the rating is missing, unreadable, too old or under the minimum, do not deposit. Never block withdrawals on a rating.",
    "- No Vigil SDK (it is not published). Start from the code below.",
    "",
    "## Facts",
    "",
    ...facts(o.path, o.where).map((f) => `- ${f}`),
    "",
    "## Code to start from",
    "",
    `File: ${s.file}`,
    "",
    "```" + s.lang,
    s.code.trimEnd(),
    "```",
    "",
    "## Done when",
    "",
    ...doneWhen(o.path, o.where).map((d) => `- [ ] ${d}`),
    "",
    ...examplesBlock(o),
    "## Do not",
    "",
    "- Do not copy scores into config or code: read them each time, caching for at most 5 minutes.",
    "- Do not use a minimum of 0: the registry signs 0 for pools Vigil holds back, so 0 lets them through.",
    "- Do not treat a missing or unreadable rating as safe.",
    "",
  ].join("\n");
}

function codeBlock(id: SnippetId): string[] {
  const s = snippet(id, { minScore: DEFAULT_MIN_SCORE, maxAgeSecs: DEFAULT_MAX_AGE_SECS });
  return [`File: ${s.file}`, "", "```" + s.lang, s.code.trimEnd(), "```", ""];
}

function pathSummary(id: PathId): string[] {
  const p = PATHS[id];
  return [
    `- **Gives:** ${p.gives}`,
    `- **Does not:** ${p.doesNot}`,
    `- **Effort:** ${p.effort}`,
    `- **Works on:** ${p.network}`,
    `- **You trust:** ${p.trust}`,
    "",
  ];
}

/** /integrate.md: the whole guide, written for an AI coding assistant and the person who briefs it. */
export function fullGuide(): string {
  return [
    "# Vigil integration guide",
    "",
    "Vigil rates every Blend pool (V2 and v2.1) and DeFindex strategy on Stellar mainnet from 0 to 100 (higher is safer), grades it A to E, and says whether deposits should be allowed. Ratings are recomputed every 30 minutes, served as JSON, and signed into an on-chain registry that a smart-account policy (RiskGate) can enforce.",
    "",
    `This file is for an AI coding assistant integrating Vigil into another project, and for the person briefing it. The interactive version, which writes a brief for your choices, is ${VIGIL.site}/integrate.`,
    "",
    "## Rules that hold on every path",
    "",
    "- A deposit is allowed when the pool is rated, Vigil allows deposits (`eligibleForDeposit`) and its score is at least your minimum. The default minimum is 60.",
    "- " + BANDS_LINE,
    "- Fail closed: a missing, unreadable or stale rating means no deposit. Withdrawals are never blocked by a rating.",
    "- Do not use a minimum of 0: the registry signs 0 for pools Vigil holds back, so a minimum of 0 lets them through.",
    "- There is no published SDK. The code below uses `@stellar/stellar-sdk` (checked with 15.1) or `soroban-sdk` (checked with 28) directly.",
    "",
    "## Choose a path",
    "",
    "| Path | What it is | Works on | Stops a bad deposit on-chain |",
    "|---|---|---|---|",
    `| 1. ${PATHS.api.title} | ${PATHS.api.sub} | ${PATHS.api.network} | No |`,
    `| 2. ${PATHS.registry.title} | ${PATHS.registry.sub} | Testnet registry; backend reads work for mainnet pools | Only where your code calls it |`,
    `| 3. ${PATHS.riskgate.title} | ${PATHS.riskgate.sub} | Testnet only | Yes, for every signer |`,
    "",
    "## Addresses",
    "",
    "| What | Value |",
    "|---|---|",
    `| Ratings API | \`${VIGIL.apiRatings}\` |`,
    `| Run archive | \`${VIGIL.apiRuns}\` |`,
    `| RiskRegistry (${VIGIL.network}) | \`${VIGIL.registryId}\` |`,
    `| RiskGate (${VIGIL.network}) | \`${VIGIL.guardId}\` |`,
    `| Rated testnet demo pool (YieldPilot's) | \`${VIGIL.demoPoolId}\` |`,
    `| RPC | \`${VIGIL.rpcUrl}\` |`,
    `| Network passphrase | \`${VIGIL.networkPassphrase}\` |`,
    "",
    `## 1. ${PATHS.api.title}`,
    "",
    ...pathSummary("api"),
    ...facts("api", "backend").map((f) => `- ${f}`),
    "",
    ...codeBlock("api"),
    `## 2. ${PATHS.registry.title}`,
    "",
    ...pathSummary("registry"),
    ...facts("registry", "contract").map((f) => `- ${f}`),
    "",
    "### From a backend (TypeScript)",
    "",
    ...codeBlock("registry-ts"),
    "### From your own Soroban contract (Rust)",
    "",
    ...codeBlock("registry-rust"),
    `## 3. ${PATHS.riskgate.title}`,
    "",
    ...pathSummary("riskgate"),
    ...facts("riskgate", "backend").map((f) => `- ${f}`),
    "",
    ...codeBlock("riskgate"),
    "### RiskGate errors",
    "",
    "A refused call fails with `Error(Contract, #code)`.",
    "",
    "| Code | Name | Meaning |",
    "|---|---|---|",
    ...RISKGATE_ERRORS.map(([c, n, m]) => `| ${c} | ${n} | ${m} |`),
    "",
    "## Limits today",
    "",
    `- The registry and RiskGate are on testnet. A mainnet contract cannot call them yet; on mainnet, read the API or the testnet registry from your backend.`,
    `- One publisher signs the ratings (threshold ${VIGIL.threshold}). The registry takes up to 16 and returns their median.`,
    "- Ratings depend on Vigil's engine version; a change of method is announced in the methodology's version history.",
    "",
    "## Check a rating yourself",
    "",
    `- The method: ${VIGIL.methodology}`,
    `- Contract reference (every function, event and encoding): ${VIGIL.contractsReadme}`,
    `- Each run's full input is at \`${VIGIL.apiRuns}?at=<computedAt>\`; \`scripts/vigil-verify.ts\` in the repository recomputes every hash and re-rates every pool from it.`,
    "",
  ].join("\n");
}
