import { describe, expect, it } from "vitest";
import { rateDefindexStrategy } from "./defindex";
import { ratePool } from "./score";
import { cid, healthyPool, reserve } from "./testkit";

const pool = healthyPool({
  poolId: cid("yield-pool"),
  reserves: [
    reserve("USDC", { supplied: 2_000_000, borrowed: 900_000, supplyApr: 0.0581, borrowApr: 0.0912 }),
    reserve("XLM", { priceUsd: 0.2, supplied: 10_000_000, borrowed: 1_000_000, supplyApr: 0.012, borrowApr: 0.08 }),
    reserve("OFF", { enabled: false, supplyApr: 0.5, borrowApr: 0.9 }),
    reserve("EURC", { priceUsd: 1.1, supplied: 1_000_000, borrowed: 300_000 }),
  ],
});

describe("rating yields (informational, not a risk input)", () => {
  it("lists each enabled reserve's supply/borrow APR, highest supply rate first", () => {
    const r = ratePool(pool);
    expect(r.yields?.map((y) => y.symbol)).toEqual(["USDC", "XLM"]);
    expect(r.yields?.[0]).toMatchObject({ symbol: "USDC", supplyApr: 0.0581, borrowApr: 0.0912, suppliedUsd: 2_000_000 });
    expect(r.yields?.[1].suppliedUsd).toBeCloseTo(2_000_000);
  });

  it("does not change the score or the reasonsHash", () => {
    const bare = healthyPool({ poolId: cid("yield-pool"), reserves: pool.reserves.map(({ supplyApr: _s, borrowApr: _b, ...r }) => r) });
    const a = ratePool(pool);
    const b = ratePool(bare);
    expect(a.score).toBe(b.score);
    expect(a.reasonsHash).toBe(b.reasonsHash);
    expect(b.yields).toEqual([]);
  });

  it("a DeFindex strategy reports only its own asset's rate in the underlying pool", () => {
    const rated = { [pool.poolId]: ratePool(pool) };
    const s = rateDefindexStrategy(
      { strategyId: cid("s"), name: "DeFindex XLM", asset: "XLM", assetContractId: pool.reserves[1].assetId, blendPoolId: pool.poolId, tvlUsd: 10 },
      rated,
      { [pool.poolId]: pool },
    );
    expect(s.yields?.map((y) => y.symbol)).toEqual(["XLM"]);
    expect(s.yields?.[0].supplyApr).toBe(0.012);
  });
});
