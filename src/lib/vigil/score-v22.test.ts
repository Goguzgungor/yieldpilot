import { describe, expect, it } from "vitest";
import { rateDefindexStrategy, rateDefindexVault } from "./defindex";
import { derive, ENGINE_VERSION, ratePool, THRESHOLDS, utilizationFactor } from "./score";
import { backstop, cid, healthyPool, reserve, src } from "./testkit";
import { pathsToGrades } from "./whatif";

// v2.2 (after the 2026-11-01 blind reviews): a pool with nothing in it gets no
// grade instead of a high one, an unpriced debt is a hard rule, utilization is
// read on the most-borrowed reserve, and pools of both Blend deployments carry
// their deployment label.
const dust = (supplied: number) =>
  healthyPool({
    poolId: cid(`dust${supplied}`),
    reserves: [reserve("USDC", { source: src("base"), supplied, borrowed: supplied * 0.4 })],
  });

describe("v2.2 scoring", () => {
  it("is versioned", () => {
    expect(ENGINE_VERSION).toMatch(/^vigil-risk-v2\.[23456]\./);
  });

  it("a pool that never launched is NR: no score, no uncapped score, not eligible, and no path to a grade", () => {
    const s = healthyPool({ poolId: cid("setup"), status: 6 });
    const r = ratePool(s);
    expect(r).toMatchObject({ grade: "NR", score: null, eligibleForDeposit: false });
    expect(r.uncappedScore).toBeUndefined();
    expect(r.notRated).toMatch(/never launched/);
    expect(r.hardRules[0]).toMatch(/^NR /);
    expect(r.reasonsHash).toMatch(/^[0-9a-f]{64}$/);
    const p = pathsToGrades(s);
    expect(p.A).toMatchObject({ reachable: false, already: false, steps: [] });
    expect(p.B.blocker).toMatch(/Not rated/);
  });

  it(`a pool holding under $${THRESHOLDS.minRatedTvlUsd} is NR even when active; at the threshold it is graded`, () => {
    const tiny = ratePool(dust(9_999));
    expect(tiny.grade).toBe("NR");
    expect(tiny.notRated).toMatch(/supplied/);
    expect(tiny.eligibleForDeposit).toBe(false);
    const enough = ratePool(dust(10_000));
    expect(enough.grade).not.toBe("NR");
    expect(typeof enough.score).toBe("number");
  });

  it("an empty pool can no longer outrank a real market", () => {
    const real = ratePool(healthyPool({ poolId: cid("real"), backstop: backstop({ usdc: 0, blnd: 0, meetsThreshold: false }) }));
    const empty = ratePool(healthyPool({ poolId: cid("empty"), status: 6, reserves: [reserve("USDC", { supplied: 0, borrowed: 0 })] }));
    expect(real.score).not.toBeNull();
    expect(empty.score).toBeNull();
  });

  it("an unpriced borrowed asset is HR2: the debt counts as $0 everywhere, so the pool must not look safe", () => {
    const s = healthyPool({
      poolId: cid("forex-like"),
      reserves: [
        reserve("XLM", { priceUsd: 0.2, supplied: 1_000_000, borrowed: 0, cFactor: 0.75 }),
        reserve("USDx", { cFactor: 0, supplied: 50_000, borrowed: 20_000, priceUsd: null, priceTimestamp: null, source: src("missing") }),
      ],
    });
    const r = ratePool(s);
    expect(r.hardRules.some((h) => h.startsWith("HR2") && h.includes("USDx (borrowed)"))).toBe(true);
    expect(r.score).toBeLessThanOrEqual(49);
    expect(r.eligibleForDeposit).toBe(false);
  });

  it("utilization is read on the most-borrowed reserve with material supply, not the pool-wide average", () => {
    // Fixed-like: idle XLM drags the pool-wide figure down while USDC is 76% borrowed.
    // At a thousandth of Fixed's size, so the dollar depth (v2.6) does not decide.
    const d = derive(
      healthyPool({
        reserves: [
          reserve("USDC", { source: src("base"), supplied: 51_500, borrowed: 39_400 }),
          reserve("XLM", { priceUsd: 0.2, supplied: 600_000, borrowed: 10_000 }),
        ],
      }),
    );
    const f = utilizationFactor(d);
    expect(f.raw).toBeCloseTo(39.4 / 51.5, 6);
    expect(f.value).toBeCloseTo(53, 0);
    expect(f.note).toMatch(/weakest reserve USDC 76\.5% borrowed/);
  });

  it("a dust reserve at 99% does not set the pool's utilization", () => {
    const f = utilizationFactor(
      derive(
        healthyPool({
          reserves: [
            reserve("USDC", { source: src("base"), supplied: 12, borrowed: 11.9 }),
            reserve("EURC", { priceUsd: 1.1, supplied: 1_000_000, borrowed: 100_000 }),
          ],
        }),
      ),
    );
    expect(f.value).toBe(100);
    expect(f.note).toMatch(/EURC/);
  });

  it("a rating carries its Blend deployment, and the backstop it was read from is part of the hash", () => {
    const v21 = healthyPool({ deployment: "v2.1", backstopId: cid("backstop-v21") });
    const r = ratePool(v21);
    expect(r.deployment).toBe("v2.1");
    expect(ratePool({ ...v21, backstopId: cid("backstop-v2") }).reasonsHash).not.toBe(r.reasonsHash);
  });

  it("a V2 pool's path to A says Blend's app takes backstop deposits for v2.1 only, and that update_status must be called", () => {
    const s = healthyPool({ poolId: cid("v2-onice"), deployment: "v2", status: 3, backstop: backstop({ usdc: 0, blnd: 0, meetsThreshold: false }) });
    const step = pathsToGrades(s).A.steps[0];
    expect(step).toMatch(/update_status/);
    expect(step).toMatch(/v2\.1 pools only/);
    const v21 = pathsToGrades({ ...s, deployment: "v2.1" }).A.steps[0];
    expect(v21).not.toMatch(/v2\.1 pools only/);
  });
});

describe("v2.2 DeFindex", () => {
  const nrPool = healthyPool({ poolId: cid("nr-pool"), status: 6 });
  const okPool = healthyPool({ poolId: cid("ok-pool"), deployment: "v2.1" });
  const ratings = Object.fromEntries([nrPool, okPool].map((p) => [p.poolId, ratePool(p)]));
  const snaps = Object.fromEntries([nrPool, okPool].map((p) => [p.poolId, p]));
  const strat = (poolId: string, seed: string) => ({
    strategyId: cid(seed),
    name: `strategy ${seed}`,
    asset: "USDC",
    assetContractId: okPool.reserves[0].assetId,
    blendPoolId: poolId,
  });

  it("a strategy on an NR pool is NR and not eligible; one on a graded pool inherits its deployment", () => {
    const nr = rateDefindexStrategy(strat(nrPool.poolId, "s-nr"), ratings, snaps);
    expect(nr).toMatchObject({ grade: "NR", score: null, eligibleForDeposit: false });
    expect(nr.notRated).toMatch(/underlying pool/);
    const ok = rateDefindexStrategy(strat(okPool.poolId, "s-ok"), ratings, snaps);
    expect(ok.grade).toBe("A");
    expect(ok.deployment).toBe("v2.1");
  });

  it("a vault is worst-of its rated strategies, and an NR strategy makes it ineligible", () => {
    const nr = rateDefindexStrategy(strat(nrPool.poolId, "v-nr"), ratings, snaps);
    const ok = rateDefindexStrategy(strat(okPool.poolId, "v-ok"), ratings, snaps);
    const v = rateDefindexVault({ vaultId: cid("vault"), name: "Vault" }, [nr, ok]);
    expect(v.score).toBe(ok.score);
    expect(v.eligibleForDeposit).toBe(false);
    expect(rateDefindexVault({ vaultId: cid("vault-nr"), name: "All NR" }, [nr]).grade).toBe("NR");
  });
});

describe("v2.2 HR7: a backstop that is leaving is not first-loss capital", () => {
  it("≥30% queued for withdrawal (Blend's own On_Ice trigger) caps a well-funded pool at B, with the queue as the path to A", () => {
    const s = healthyPool({ poolId: cid("leaving"), backstop: backstop({ q4wPct: 0.445 }) });
    const r = ratePool(s);
    expect(r.grade).toBe("B");
    expect(r.hardRules.find((h) => h.startsWith("HR7"))).toMatch(/44\.5% of the backstop is queued/);
    const p = pathsToGrades(s);
    expect(p.A.reachable).toBe(true);
    expect(p.A.levers).toEqual(["backstop"]);
    expect(p.A.steps[0]).toMatch(/withdrawal queue under 30% \(now 44\.5%\)/);
  });

  it("under 30% queued, the same pool keeps its A", () => {
    expect(ratePool(healthyPool({ poolId: cid("staying"), backstop: backstop({ q4wPct: 0.29 }) })).grade).toBe("A");
  });
});

describe("v2.2 NR hard rules", () => {
  it("an NR pool lists why it has no grade, not the ceilings that would have shaped a score", () => {
    const r = ratePool(healthyPool({ poolId: cid("nr-uninsured"), status: 6, backstop: backstop({ usdc: 0, blnd: 0, meetsThreshold: false }) }));
    expect(r.hardRules[0]).toMatch(/^NR /);
    expect(r.hardRules.some((h) => /^HR[467] /.test(h))).toBe(false);
    expect(r.hardRules.some((h) => h.startsWith("HR1"))).toBe(true);
  });
});
