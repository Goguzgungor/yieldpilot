import { describe, expect, it } from "vitest";
import { GRADE_BANDS, HARD_CAPS, WEIGHTS } from "./score";
import {
  cappedBy,
  depositFunnel,
  factorReadings,
  GUIDE_BANDS,
  GUIDE_CEILINGS,
  GUIDE_FACTORS,
  hasRule,
  weakOn,
  type GuideRating,
} from "./guide";

function rating(p: Partial<GuideRating> & { poolId: string }): GuideRating {
  return {
    name: p.poolId,
    protocol: "blend",
    score: 70,
    status: 1,
    eligibleForDeposit: true,
    hardRules: [],
    factors: [],
    ...p,
  };
}

describe("guide constants mirror the engine", () => {
  it("has every weight, equal to score.ts", () => {
    expect(Object.fromEntries(GUIDE_FACTORS.map((f) => [f.key, f.weight]))).toEqual(WEIGHTS);
  });

  it("lists factors largest weight first", () => {
    const w = GUIDE_FACTORS.map((f) => f.weight);
    expect(w).toEqual([...w].sort((a, b) => b - a));
  });

  it("uses the engine's grade bands", () => {
    expect(GUIDE_BANDS).toEqual(GRADE_BANDS);
  });

  it("uses the engine's caps", () => {
    const cap = (id: string) => GUIDE_CEILINGS.find((c) => c.id === id)!.cap;
    expect(cap("weak")).toBe(HARD_CAPS.weakCollateralSource);
    expect(cap("weak")).toBe(HARD_CAPS.uninsured);
    expect(cap("first-loss")).toBe(HARD_CAPS.noFirstLossCapital);
    expect(cap("locked-in")).toBe(HARD_CAPS.lendersLockedIn);
    expect(cap("unknown-source")).toBe(HARD_CAPS.unverifiableCollateralSource);
    expect(cap("missing-price")).toBe(HARD_CAPS.collateralPriceUnavailable);
    expect(cap("pushable")).toBe(HARD_CAPS.sdexManipulable);
  });

  it("gives each ceiling the grade its cap falls in", () => {
    for (const c of GUIDE_CEILINGS) {
      const band = GUIDE_BANDS.find(([min]) => c.cap >= min)!;
      expect(band[1], c.id).toBe(c.grade);
    }
  });
});

describe("hasRule", () => {
  it("does not read HR10 as HR1", () => {
    const r = { hardRules: ["HR10 USDC is 89.9% borrowed ⇒ not eligible"] };
    expect(hasRule(r, "HR10")).toBe(true);
    expect(hasRule(r, "HR1")).toBe(false);
  });

  it("reads a DeFindex strategy's underlying rules", () => {
    expect(hasRule({ hardRules: ["underlying: HR9 backstop $0.00 ⇒ at most C"] }, "HR9")).toBe(true);
  });
});

describe("cappedBy", () => {
  it("matches any of a ceiling's codes", () => {
    const weak = GUIDE_CEILINGS.find((c) => c.id === "weak")!;
    const out = cappedBy(
      [
        rating({ poolId: "a", hardRules: ["HR6 collateral priced by a weak source"] }),
        rating({ poolId: "b", hardRules: ["HR7 backstop below threshold"] }),
        rating({ poolId: "c", hardRules: ["HR9 backstop $0.00"] }),
      ],
      weak,
    );
    expect(out.map((r) => r.poolId)).toEqual(["a", "b"]);
  });
});

describe("factorReadings / weakOn", () => {
  const ratings = [
    rating({ poolId: "fixed", name: "Fixed", factors: [{ key: "backstop_coverage", value: 0 }] }),
    rating({ poolId: "v21", name: "Fixed v2.1", factors: [{ key: "backstop_coverage", value: 100 }] }),
    rating({ poolId: "nr", score: null, factors: [{ key: "backstop_coverage", value: 0 }] }),
    rating({ poolId: "dfx", protocol: "defindex", underlying: "fixed", factors: [{ key: "underlying_pool", value: 57 }] }),
  ];

  it("reads graded Blend pools only, weakest first", () => {
    expect(factorReadings(ratings, "backstop_coverage")).toEqual([
      { poolId: "fixed", name: "Fixed", value: 0 },
      { poolId: "v21", name: "Fixed v2.1", value: 100 },
    ]);
  });

  it("adds the DeFindex strategies on a weak pool", () => {
    expect([...weakOn(ratings, "backstop_coverage")].sort()).toEqual(["dfx", "fixed"]);
  });
});

describe("depositFunnel", () => {
  it("narrows step by step and counts Blend pools only", () => {
    const steps = depositFunnel([
      rating({ poolId: "nr", score: null, eligibleForDeposit: false, status: 6 }),
      rating({ poolId: "frozen", score: 53, status: 4, eligibleForDeposit: false }),
      rating({ poolId: "locked", score: 64, eligibleForDeposit: false }),
      rating({ poolId: "fixed", score: 57, status: 3 }),
      rating({ poolId: "good", score: 72 }),
      rating({ poolId: "dfx", protocol: "defindex", score: 57 }),
    ]);
    expect(steps.map((s) => [s.id, s.poolIds])).toEqual([
      ["found", ["nr", "frozen", "locked", "fixed", "good"]],
      ["rated", ["frozen", "locked", "fixed", "good"]],
      ["open", ["locked", "fixed", "good"]],
      ["eligible", ["fixed", "good"]],
      ["clears", ["good"]],
    ]);
  });

  it("takes the minimum score as a parameter", () => {
    const steps = depositFunnel([rating({ poolId: "fixed", score: 57 })], 50);
    expect(steps.at(-1)!.poolIds).toEqual(["fixed"]);
    expect(steps.at(-1)!.label).toContain("50");
  });
});
