import { describe, expect, it } from "vitest";
import { ratePool } from "./score";
import { backstop, cid, healthyPool, reserve, src } from "./testkit";
import { pathsToGrades } from "./whatif";

describe("pathsToGrades", () => {
  it("a pool already graded A needs nothing", () => {
    const p = pathsToGrades(healthyPool());
    expect(ratePool(healthyPool()).grade).toBe("A");
    expect(p.A).toMatchObject({ reachable: true, already: true, steps: [] });
    expect(p.B).toMatchObject({ reachable: true, already: true, steps: [] });
  });

  it("an on-ice pool with an empty backstop is B, and reaches A by refilling the backstop (Blend reactivates it)", () => {
    // Fixed today: status 3 because the backstop is below Blend's threshold.
    const s = healthyPool({ poolId: cid("fixed-like"), status: 3, backstop: backstop({ usdc: 0, blnd: 0, meetsThreshold: false, q4wPct: 0.066 }) });
    expect(ratePool(s).grade).toBe("B");
    const p = pathsToGrades(s);
    expect(p.B.already).toBe(true);
    expect(p.A.reachable).toBe(true);
    expect(p.A.levers).toEqual(["backstop"]);
    expect(p.A.steps[0]).toMatch(/backstop/i);
    expect(p.A.steps[0]).toMatch(/reactivates/i);
    expect(p.A.score).toBeGreaterThanOrEqual(80);
  });

  it("the grade path never asks for an admin action: status is not graded (it only opens or closes deposits)", () => {
    const s = healthyPool({ poolId: cid("frozen"), status: 4, backstop: backstop({ usdc: 0, blnd: 0, meetsThreshold: false }) });
    const p = pathsToGrades(s);
    expect(p.A.levers).toEqual(["backstop"]);
    expect(ratePool(s).eligibleForDeposit).toBe(false);
  });

  it("a pool priced by an issuer push oracle needs a better price source to reach A", () => {
    const s = healthyPool({
      poolId: cid("push"),
      reserves: [
        reserve("USDC", { source: src("base"), supplied: 2_000_000, borrowed: 900_000, cFactor: 0.95, lFactor: 0.95 }),
        reserve("CETES", { priceUsd: 0.06, supplied: 5_000_000, borrowed: 0, cFactor: 0.8, lFactor: 0, source: src("issuer_push") }),
      ],
    });
    const before = ratePool(s);
    expect(before.grade).not.toBe("A");
    const p = pathsToGrades(s);
    expect(p.A.reachable).toBe(true);
    expect(p.A.levers).toContain("oracle");
    expect(p.A.steps.find((x) => /price/i.test(x))).toMatch(/CETES/);
  });

  it("says when a grade is out of reach of the levers (a collateral with no price at all)", () => {
    // A missing price can't be simulated into existence: the oracle has to publish one first.
    const s = healthyPool({
      poolId: cid("unpriced"),
      reserves: [
        reserve("USDC", { source: src("base"), supplied: 2_000_000, borrowed: 900_000 }),
        reserve("GHOST", { priceUsd: null, priceTimestamp: null, supplied: 1_000_000, borrowed: 0, source: src("missing") }),
      ],
    });
    expect(ratePool(s).grade).toBe("D");
    const p = pathsToGrades(s);
    expect(p.B).toMatchObject({ reachable: false, steps: [] });
    expect(p.B.blocker).toMatch(/GHOST/);
  });

  it("prefers the smallest set of changes", () => {
    const s = healthyPool({ poolId: cid("fixed-like-2"), status: 3, backstop: backstop({ usdc: 0, blnd: 0, meetsThreshold: false }) });
    const p = pathsToGrades(s);
    expect(p.B.levers.length).toBeLessThanOrEqual(p.A.levers.length);
  });
});

describe("HR6: an A needs robust prices on every collateral", () => {
  it("caps a pool with a weakly-priced collateral at B, and the A path asks for a better feed", () => {
    const s = healthyPool({
      poolId: cid("peg"),
      reserves: [
        reserve("USDC", { source: src("base"), supplied: 2_000_000, borrowed: 900_000, cFactor: 0.95, lFactor: 0.95 }),
        reserve("PYUSD", { supplied: 1_000_000, borrowed: 0, cFactor: 0.9, lFactor: 0, source: src("fixed_peg") }),
      ],
    });
    const r = ratePool(s);
    expect(r.score).toBeLessThanOrEqual(79);
    expect(r.grade).toBe("B");
    expect(r.hardRules.some((h) => h.startsWith("HR6"))).toBe(true);
    expect(r.eligibleForDeposit).toBe(true); // a B is still depositable
    const p = pathsToGrades(s);
    expect(p.B.already).toBe(true);
    expect(p.A.levers).toContain("oracle");
  });
});
