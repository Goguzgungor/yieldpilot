import { describe, expect, it } from "vitest";
import { rateDefindexStrategy, rateDefindexVault, type DefindexStrategyInput } from "./defindex";
import { ratePool } from "./score";
import { backstop, cid, healthyPool, reserve } from "./testkit";

const good = healthyPool({ poolId: cid("good") });
// Deposits closed (Admin_Frozen) and uninsured: not eligible, and scores below `good`.
const bad = healthyPool({ poolId: cid("bad"), status: 4, backstop: backstop({ usdc: 0, blnd: 0, meetsThreshold: false }) });
const ratings = Object.fromEntries([good, bad].map((p) => [p.poolId, ratePool(p)]));
const snaps = Object.fromEntries([good, bad].map((p) => [p.poolId, p]));
const usdc = good.reserves[0].assetId;

const strat = (o: Partial<DefindexStrategyInput> = {}): DefindexStrategyInput => ({
  strategyId: cid("strat"),
  name: "DeFindex USDC",
  asset: "USDC",
  assetContractId: usdc,
  blendPoolId: good.poolId,
  tvlUsd: 1234,
  ...o,
});

describe("rateDefindexStrategy", () => {
  it("inherits the underlying pool's score, grade and eligibility", () => {
    const r = rateDefindexStrategy(strat(), ratings, snaps);
    expect(r.protocol).toBe("defindex");
    expect(r.score).toBe(ratings[good.poolId].score);
    expect(r.grade).toBe(ratings[good.poolId].grade);
    expect(r.eligibleForDeposit).toBe(true);
    expect(r.underlying).toEqual([good.poolId]);
    expect(r.tvlUsd).toBe(1234);
    expect(r.reasons.some((x) => /not modelled/.test(x))).toBe(true);
  });

  it("prefers the strategy's on-chain Config.pool over configuration and says so", () => {
    const r = rateDefindexStrategy(strat({ onchainPoolId: bad.poolId }), ratings, snaps);
    expect(r.underlying).toEqual([bad.poolId]);
    expect(r.eligibleForDeposit).toBe(false);
    expect(r.hardRules.some((h) => h.startsWith("underlying: HR1"))).toBe(true);
    expect(r.reasons.some((x) => x.includes("using on-chain value"))).toBe(true);
  });

  it("an unrated underlying pool ⇒ score 0, grade E, not eligible", () => {
    const r = rateDefindexStrategy(strat({ blendPoolId: cid("missing") }), ratings, snaps);
    expect(r).toMatchObject({ score: 0, grade: "E", eligibleForDeposit: false });
  });

  it("a strategy asset that is not a live reserve of the pool ⇒ not eligible", () => {
    const r = rateDefindexStrategy(strat({ assetContractId: cid("nope") }), ratings, snaps);
    expect(r.eligibleForDeposit).toBe(false);
    expect(r.hardRules.some((h) => h.startsWith("HR-D2"))).toBe(true);
    const disabled = { ...good, reserves: [reserve("USDC", { assetId: usdc, enabled: false }), ...good.reserves.slice(1)] };
    const r2 = rateDefindexStrategy(strat(), ratings, { [good.poolId]: disabled });
    expect(r2.hardRules.some((h) => h.includes("disabled"))).toBe(true);
  });
});

describe("rateDefindexVault", () => {
  it("is worst-of its strategies", () => {
    const s1 = rateDefindexStrategy(strat(), ratings, snaps);
    const s2 = rateDefindexStrategy(strat({ strategyId: cid("s2"), blendPoolId: bad.poolId }), ratings, snaps);
    const v = rateDefindexVault({ vaultId: cid("vault"), name: "Vault" }, [s1, s2]);
    expect(v.score).toBe(Math.min(s1.score!, s2.score!));
    expect(v.eligibleForDeposit).toBe(false);
    expect(v.underlying).toEqual([s1.poolId, s2.poolId]);
    expect(rateDefindexVault({ vaultId: cid("v2"), name: "Empty" }, []).grade).toBe("E");
  });
});
