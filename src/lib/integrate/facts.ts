/**
 * What another project needs to integrate Vigil: the on-chain addresses, the
 * three ways to connect, and RiskGate's deposit rule applied to an API rating.
 *
 * Client-safe on purpose (the /integrate page imports it): plain literals, no
 * SDK. integrate.test.ts checks every id against the config and onboarding
 * constants the app itself runs with.
 */
import { GUIDE_BANDS, RISKGATE_DEFAULT_MIN, type GuideGrade } from "../vigil/guide";

export const VIGIL = {
  site: "https://yieldpilot.org",
  apiRatings: "https://yieldpilot.org/api/ratings",
  apiRuns: "https://yieldpilot.org/api/ratings/runs",
  guideMd: "https://yieldpilot.org/integrate.md",
  methodology: "https://github.com/Goguzgungor/yieldpilot/blob/feat/yieldseeker-mvp/docs/vigil/methodology.md",
  contractsReadme: "https://github.com/Goguzgungor/yieldpilot/blob/feat/yieldseeker-mvp/contracts/README.md",
  network: "testnet",
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  /** RiskRegistry (contracts/vigil-registry). */
  registryId: "CB4LXLCCD7YDND5FBVXPKPHUQMF7JFSDRVXHG7ZZTWWNPJ6WDCXDNDF6",
  /** RiskGate (contracts/vigil-guard): one shared policy, no admin, no upgrade. */
  guardId: "CD6BDS7R5K3IUCQSJUZUWAGLTR47EZOYEVCO5MPT7YGNBNQRHSNY5VMS",
  /** YieldPilot's testnet Blend pool: the one testnet pool the registry rates (it carries the rating of the mainnet pool YieldPilot holds). */
  demoPoolId: "CBI7WAUQ4NPQFZW4C3MDSVFAZJWV3RCLZSTTMA5OZ6BTPEQMOZZNSZ3Z",
  /** Registry config as deployed: 1 publisher, threshold 1, submissions count for 2 h. */
  publishers: 1,
  threshold: 1,
  registryMaxAgeSecs: 7200,
  publishEveryMin: 30,
} as const;

export const DEFAULT_MIN_SCORE = RISKGATE_DEFAULT_MIN;
/** The age YieldPilot's own wallets accept; the registry stops counting a submission after the same 2 h. */
export const DEFAULT_MAX_AGE_SECS = 7200;
export const MAX_AGE_CHOICES = [3600, 7200] as const;

export type PathId = "api" | "registry" | "riskgate";
/** Where a registry check runs: an off-chain service, or inside the project's own Soroban contract. */
export type Where = "backend" | "contract";

export interface PathInfo {
  title: string;
  sub: string;
  /** What the project gets, for a product reader. */
  gives: string;
  /** What it does not protect. */
  doesNot: string;
  effort: string;
  /** Where it works today. */
  network: string;
  /** Whom the project has to trust. */
  trust: string;
}

export const PATHS: Record<PathId, PathInfo> = {
  api: {
    title: "Show ratings",
    sub: "Read the JSON API",
    gives:
      "Every Blend pool and DeFindex strategy on mainnet with its grade, score, reasons and whether Vigil allows deposits. Use it to label pools in your app or to drop weak ones before your backend picks one.",
    doesNot:
      "Nothing on-chain stops a deposit. If your backend has a bug or its key is stolen, money can still reach a weak pool.",
    effort: "Hours. One HTTP call, no keys, open to browsers (CORS).",
    network: "Mainnet pools, today.",
    trust: "yieldpilot.org's server. Every run's inputs are archived, so anyone can recompute a rating and check it.",
  },
  registry: {
    title: "Check before depositing",
    sub: "Read the on-chain registry",
    gives:
      "The signed score your deposit code checks before it moves money: read from the RiskRegistry contract, either by your backend over RPC or by your own Soroban contract.",
    doesNot:
      "It guards only the code paths that call it; a deposit sent another way is not checked. The registry is on testnet, so a mainnet contract cannot call it yet.",
    effort: "A day or two, tests included.",
    network: "Registry on testnet. It holds the scores of the mainnet pools, so a backend can read them today; contract-to-contract checks work on testnet only.",
    trust: "The registered publishers' signatures (one today, M-of-N by design).",
  },
  riskgate: {
    title: "Enforce on the wallet",
    sub: "Install RiskGate",
    gives:
      "A policy on your users' OpenZeppelin smart accounts. A deposit into a pool under your minimum fails on-chain, whoever signs it: your agent, a bug, or a stolen key. Withdrawals always work.",
    doesNot:
      "It needs OpenZeppelin smart accounts, and each account's owner has to sign the install. It knows Blend's pool calls (submit, claim) and token transfers and refuses every other function on the rule it guards, so it fits Blend pool rules, not DeFindex vaults.",
    effort: "A few days, plus one signature from each user.",
    network:
      "Testnet only. The one rated testnet pool is YieldPilot's demo pool; a deposit into any other testnet pool fails closed (no rating, #4114).",
    trust: "The same publishers as the registry, enforced by the account itself.",
  },
};

/** What the verdict needs from a rating (a subset of GET /api/ratings). */
export interface VerdictRating {
  poolId: string;
  name: string;
  grade: GuideGrade | "NR";
  /** null when not rated. */
  score: number | null;
  eligibleForDeposit: boolean;
}

export interface Verdict {
  allowed: boolean;
  /** The score the registry holds for the pool; null when nothing is published (not rated). */
  onchain: number | null;
  /** The RiskGate error a blocked deposit fails with. */
  code?: 4114 | 4115;
  reason: string;
}

export function gradeOf(score: number): GuideGrade {
  return GUIDE_BANDS.find(([min]) => score >= min)?.[1] ?? "E";
}

/**
 * Would a deposit into this pool pass RiskGate at `minScore`, given the latest
 * run? The publisher signs `score` for an eligible pool and 0 for a pool a hard
 * rule holds back (src/lib/vigil/publish.ts registryScore), and nothing for an
 * unrated one. Freshness is the chain's job (4116) and is not modelled here.
 */
export function depositVerdict(r: VerdictRating, minScore: number): Verdict {
  if (!Number.isInteger(minScore) || minScore < 1 || minScore > 100) {
    throw new Error(`minimum score must be an integer 1..100 (0 lets held-back pools through), got ${minScore}`);
  }
  if (r.score === null) {
    return { allowed: false, onchain: null, code: 4114, reason: "not rated, so the registry has nothing for it" };
  }
  if (!r.eligibleForDeposit) {
    return { allowed: false, onchain: 0, code: 4115, reason: `held back by a hard rule (${r.grade} ${r.score}), so the registry holds 0` };
  }
  if (r.score < minScore) {
    return { allowed: false, onchain: r.score, code: 4115, reason: `score ${r.score} is under your minimum of ${minScore}` };
  }
  return { allowed: true, onchain: r.score, reason: `score ${r.score} meets your minimum of ${minScore}` };
}

export function passingAt(ratings: VerdictRating[], minScore: number): number {
  return ratings.filter((r) => depositVerdict(r, minScore).allowed).length;
}

/**
 * Two live pools for the brief's tests: one a deposit may enter at `minScore`
 * and one it may not. The selected pool fills its own side; the other side is
 * the highest-scoring pool that fits it (a rated pool before an unrated one,
 * since "refused despite a decent score" teaches more).
 */
export function pickExamples<R extends VerdictRating>(
  ratings: R[],
  minScore: number,
  selectedId: string | null,
): { pass?: R; block?: R } {
  const byScore = [...ratings].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const allowed = (r: R) => depositVerdict(r, minScore).allowed;
  const selected = ratings.find((r) => r.poolId === selectedId);
  const pass = selected && allowed(selected) ? selected : byScore.find(allowed);
  const block = selected && !allowed(selected) ? selected : byScore.find((r) => !allowed(r));
  return { pass, block };
}
