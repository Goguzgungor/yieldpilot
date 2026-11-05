import { describe, it, expect } from "vitest";
import ts from "typescript";
import { parseConfig } from "../config";
import { EXEC_POOL_ID, VIGIL_GUARD_ID, EXEC_NETWORK_PASSPHRASE } from "../onboarding";
import { RISKGATE_DEFAULT_MIN } from "../vigil/guide";
import { VIGIL, DEFAULT_MIN_SCORE, DEFAULT_MAX_AGE_SECS, PATHS, depositVerdict, passingAt, pickExamples, type VerdictRating } from "./facts";
import { snippet } from "./snippets";
import { buildBrief, fullGuide } from "./brief";

const rating = (over: Partial<VerdictRating>): VerdictRating => ({
  poolId: "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD",
  name: "Fixed",
  grade: "B",
  score: 76,
  eligibleForDeposit: true,
  ...over,
});

/** A value interpolated as undefined; the snippets' own `| undefined` types are fine. */
const leaked = (text: string) => text.replace(/\| undefined/g, "").includes("undefined");

/** Syntax errors only (no type check): the snippet must at least parse as TypeScript. */
function syntaxErrors(code: string): string[] {
  const out = ts.transpileModule(code, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022 } });
  return (out.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

describe("integration facts", () => {
  it("match the ids the app itself runs with", () => {
    // The env config.test.ts uses, minus every Vigil and exec-pool id, so the defaults apply.
    const env = {
      RISK_TOLERANCE: "balanced",
      SCAN_RPC_URL: "https://mainnet.sorobanrpc.com",
      SCAN_NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015",
      SCAN_BLEND_POOL_IDS: "C_A",
      SCAN_USDC_CONTRACT_ID: "C_USDC_MAINNET",
      EXEC_RPC_URL: VIGIL.rpcUrl,
      EXEC_NETWORK_PASSPHRASE: VIGIL.networkPassphrase,
      AGENT_SIGNER_SECRET: "S_SECRET", SMART_WALLET_ADDRESS: "C_WALLET",
      PER_TX_CAP_USDC: "2000", DAILY_CAP_USDC: "5000",
      MIN_YIELD_DELTA_BPS: "50", REBALANCE_COOLDOWN_SEC: "120", SCAN_INTERVAL_SEC: "30",
    };
    const c = parseConfig(env);
    expect(VIGIL.registryId).toBe(c.vigilGuard.registry);
    expect(VIGIL.guardId).toBe(c.vigilGuard.id);
    expect(VIGIL.guardId).toBe(VIGIL_GUARD_ID);
    expect(VIGIL.demoPoolId).toBe(EXEC_POOL_ID);
    expect(VIGIL.networkPassphrase).toBe(EXEC_NETWORK_PASSPHRASE);
    expect(DEFAULT_MIN_SCORE).toBe(RISKGATE_DEFAULT_MIN);
    expect(BigInt(DEFAULT_MAX_AGE_SECS)).toBe(c.vigilGuard.maxAgeSecs);
  });

  it("describe three paths, each with what it gives, what it does not, and the network today", () => {
    expect(Object.keys(PATHS)).toEqual(["api", "registry", "riskgate"]);
    for (const p of Object.values(PATHS)) {
      expect(p.title.length).toBeGreaterThan(0);
      expect(p.gives.length).toBeGreaterThan(20);
      expect(p.doesNot.length).toBeGreaterThan(20);
      expect(p.network.length).toBeGreaterThan(5);
    }
  });
});

describe("depositVerdict (RiskGate's rule, applied to an API rating)", () => {
  it("allows a rated, eligible pool at or above the minimum", () => {
    expect(depositVerdict(rating({}), 60)).toMatchObject({ allowed: true, onchain: 76 });
    expect(depositVerdict(rating({ score: 60 }), 60).allowed).toBe(true);
  });

  it("blocks a pool below the minimum with 4115", () => {
    expect(depositVerdict(rating({ name: "YieldBlox", grade: "C", score: 58 }), 60)).toMatchObject({
      allowed: false,
      onchain: 58,
      code: 4115,
    });
  });

  it("puts 0 on-chain for a pool Vigil holds back, whatever its score", () => {
    const v = depositVerdict(rating({ name: "Etherfuse", score: 68, eligibleForDeposit: false }), 60);
    expect(v).toMatchObject({ allowed: false, onchain: 0, code: 4115 });
    expect(v.reason).toMatch(/held back/);
  });

  it("blocks an unrated pool with 4114: nothing is published for it", () => {
    expect(depositVerdict(rating({ grade: "NR", score: null, eligibleForDeposit: false }), 60)).toMatchObject({
      allowed: false,
      onchain: null,
      code: 4114,
    });
  });

  it("refuses a minimum of 0, which would let held-back pools through", () => {
    expect(() => depositVerdict(rating({}), 0)).toThrow(/1\.\.100/);
  });

  it("counts the pools that pass a minimum", () => {
    const rs = [rating({}), rating({ score: 58 }), rating({ score: 68, eligibleForDeposit: false }), rating({ score: null, grade: "NR" })];
    expect(passingAt(rs, 60)).toBe(1);
    expect(passingAt(rs, 50)).toBe(2);
  });
});

describe("pickExamples", () => {
  const fixed = rating({});
  const v21 = rating({ poolId: "CBAK", name: "Fixed v2.1", score: 79 });
  const yb = rating({ poolId: "CCCC", name: "YieldBlox", grade: "C", score: 58 });
  const frozen = rating({ poolId: "CDMA", name: "Etherfuse", score: 68, eligibleForDeposit: false });
  const nr = rating({ poolId: "CNR", name: "Solv", grade: "NR", score: null, eligibleForDeposit: false });

  it("takes the selected pool for its side and the strongest rated pool for the other", () => {
    expect(pickExamples([fixed, v21, yb, frozen, nr], 60, "CCCC")).toEqual({ pass: v21, block: yb });
    expect(pickExamples([fixed, v21, yb, frozen, nr], 60, fixed.poolId)).toEqual({ pass: fixed, block: frozen });
  });

  it("prefers a rated pool over an unrated one as the refused example", () => {
    expect(pickExamples([fixed, nr, yb], 60, null).block).toBe(yb);
    expect(pickExamples([fixed, nr], 60, null).block).toBe(nr);
  });

  it("leaves a side out when no pool fits it", () => {
    expect(pickExamples([yb], 60, null)).toEqual({ pass: undefined, block: yb });
    expect(pickExamples([fixed], 60, null)).toEqual({ pass: fixed, block: undefined });
  });
});

describe("snippets", () => {
  const opts = { minScore: 70, maxAgeSecs: 3600 };

  it.each(["api", "registry-ts", "riskgate"] as const)("%s parses as TypeScript and carries the chosen rule", (id) => {
    const s = snippet(id, opts);
    expect(s.lang).toBe("ts");
    expect(syntaxErrors(s.code)).toEqual([]);
    expect(s.code).toContain("MIN_SCORE = 70");
    expect(s.code).toMatch(/MAX_AGE_SECS = 3600/);
  });

  it("the registry reads name the testnet registry and RPC", () => {
    for (const id of ["registry-ts", "registry-rust"] as const) {
      expect(snippet(id, opts).code).toContain(VIGIL.registryId);
    }
    expect(snippet("registry-ts", opts).code).toContain(VIGIL.rpcUrl);
  });

  it("the Rust check declares the registry's Rating exactly and uses the chosen rule", () => {
    const s = snippet("registry-rust", opts).code;
    expect(s).toMatch(/pub score: u32,[\s\S]*pub publishers: u32,[\s\S]*pub timestamp: u64,/);
    expect(s).toContain("fn get_rating(env: Env, pool: Address) -> Option<Rating>;");
    expect(s).toContain("MIN_SCORE: u32 = 70");
    expect(s).toContain("MAX_AGE_SECS: u64 = 3600");
  });

  it("the RiskGate install names the guard and keeps the param keys sorted", () => {
    const s = snippet("riskgate", opts).code;
    expect(s).toContain(VIGIL.guardId);
    expect(s).toContain('"add_policy"');
    const keys = [...s.matchAll(/entry\("([a-z_]+)"/g)].map((m) => m[1]).slice(0, 4);
    expect(keys).toEqual(["allowed_recipients", "max_age_secs", "min_score", "registry"]);
  });

  it("the API check uses the same rule as the chain: eligible, rated, at the minimum, fresh", () => {
    const s = snippet("api", opts).code;
    expect(s).toContain("https://yieldpilot.org/api/ratings");
    expect(s).toMatch(/eligibleForDeposit/);
    expect(s).toMatch(/computedAt/);
  });
});

describe("buildBrief", () => {
  const pass = rating({});
  const block = rating({ poolId: "CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS", name: "YieldBlox", grade: "C", score: 58 });

  it.each(["api", "registry", "riskgate"] as const)("%s: states the decisions, the guide URL and the done-when list", (path) => {
    const b = buildBrief({ path, where: "backend", minScore: 65, maxAgeSecs: 7200, examples: { pass, block } });
    expect(b).toContain(PATHS[path].title);
    expect(b).toContain("Minimum score: 65");
    expect(b).toContain("https://yieldpilot.org/integrate.md");
    expect(b).toMatch(/## Done when/);
    expect(b).toContain(pass.poolId);
    expect(b).toContain(block.poolId);
    expect(b).toMatch(/fail closed/i);
  });

  it("puts the on-chain error codes in the on-chain paths' checks", () => {
    expect(buildBrief({ path: "riskgate", where: "backend", minScore: 60, maxAgeSecs: 7200 })).toMatch(/#4115/);
    expect(buildBrief({ path: "registry", where: "contract", minScore: 60, maxAgeSecs: 7200 })).toMatch(/Rust|soroban/i);
    expect(buildBrief({ path: "api", where: "backend", minScore: 60, maxAgeSecs: 7200 })).not.toMatch(/#4115/);
  });

  it("names the testnet limit for the on-chain paths", () => {
    expect(buildBrief({ path: "riskgate", where: "backend", minScore: 60, maxAgeSecs: 7200 })).toContain(VIGIL.demoPoolId);
    expect(buildBrief({ path: "registry", where: "contract", minScore: 60, maxAgeSecs: 7200 })).toMatch(/testnet/i);
  });

  it("works without live examples", () => {
    const b = buildBrief({ path: "api", where: "backend", minScore: 60, maxAgeSecs: 7200 });
    expect(b).toContain("Minimum score: 60");
    expect(leaked(b)).toBe(false);
  });
});

describe("fullGuide", () => {
  it("covers every path, the addresses, the error codes and the limits", () => {
    const g = fullGuide();
    for (const p of Object.values(PATHS)) expect(g).toContain(p.title);
    for (const id of [VIGIL.registryId, VIGIL.guardId, VIGIL.demoPoolId]) expect(g).toContain(id);
    for (const code of [4107, 4113, 4114, 4115, 4116]) expect(g).toContain(String(code));
    expect(g).toMatch(/testnet/i);
    expect(g).toMatch(/minimum of 0/i);
    expect(leaked(g)).toBe(false);
  });
});
