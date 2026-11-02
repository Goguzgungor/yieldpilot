import { describe, expect, it } from "vitest";
import { gateByVigil, vigilCandidatePools, type VigilVerdict } from "./vigilGate";
import type { ScoredPool } from "./types";

const pool = (poolId: string, eligible = true): ScoredPool => ({
  protocol: "blend",
  poolId,
  name: poolId,
  asset: "USDC",
  apyBps: 500,
  tvlUsdc: 1_000_000_0000000n,
  utilizationBps: 5000,
  oracleHealthy: true,
  riskScore: 40,
  eligible,
  ...(eligible ? {} : { reason: "pool frozen" }),
});
const verdict = (poolId: string, o: Partial<VigilVerdict> = {}): VigilVerdict => ({
  poolId,
  name: poolId,
  protocol: "blend",
  score: 75,
  grade: "B",
  eligibleForDeposit: true,
  hardRules: [],
  ...o,
});

describe("gateByVigil", () => {
  it("keeps pools the RiskGate would accept and says why the others are out", () => {
    const out = gateByVigil(
      [pool("OK"), pool("LOW"), pool("HR8"), pool("NR"), pool("UNRATED"), pool("FROZEN", false)],
      [
        verdict("OK"),
        verdict("LOW", { score: 57, grade: "C" }),
        verdict("HR8", { score: 70, eligibleForDeposit: false, hardRules: ["HR8 97.8% of the backstop is queued for withdrawal ⇒ not eligible"] }),
        verdict("NR", { score: null, grade: "NR", eligibleForDeposit: false, notRated: "never launched" }),
      ],
      60,
    );
    const by = Object.fromEntries(out.map((p) => [p.poolId, p]));
    expect(by.OK.eligible).toBe(true);
    expect(by.LOW).toMatchObject({ eligible: false, reason: "Vigil C 57 < 60, the RiskGate minimum" });
    expect(by.HR8.reason).toMatch(/^Vigil B 70, not eligible: HR8 97\.8%/);
    expect(by.NR.reason).toBe("Vigil NR: never launched");
    expect(by.UNRATED.reason).toBe("not rated by Vigil");
    expect(by.FROZEN.reason).toBe("pool frozen"); // the agent's own reason stays
  });

  it("no fresh ratings ⇒ nothing is eligible, as on-chain (RatingUnavailable / RatingStale)", () => {
    const out = gateByVigil([pool("A"), pool("B")], null, 60);
    expect(out.every((p) => !p.eligible && /no fresh Vigil rating/.test(p.reason!))).toBe(true);
  });
});

describe("vigilCandidatePools", () => {
  it("lists depositable Blend pools at or above the minimum, not DeFindex strategies", () => {
    const ids = vigilCandidatePools(
      [verdict("V21"), verdict("C57", { score: 57 }), verdict("DFX", { protocol: "defindex" }), verdict("OUT", { eligibleForDeposit: false })],
      60,
    );
    expect(ids).toEqual(["V21"]);
    expect(vigilCandidatePools(null, 60)).toEqual([]);
  });
});
