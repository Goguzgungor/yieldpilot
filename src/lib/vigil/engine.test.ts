import { describe, expect, it } from "vitest";
import { functionSource } from "./discovery";
import { runVigil, toRatingsJson } from "./engine";
import { cid, healthyPool } from "./testkit";

describe("runVigil (offline, injected readers)", () => {
  const ok = cid("ok-pool");
  const broken = cid("broken-pool");
  const frozen = cid("frozen-pool");
  const snapshots: Record<string, ReturnType<typeof healthyPool>> = {
    [ok]: healthyPool({ poolId: ok, name: "OK" }),
    [frozen]: healthyPool({ poolId: frozen, name: "Frozen", status: 5 }),
  };
  const deps = {
    sources: [functionSource("factory", async () => [ok, broken, frozen], true)],
    verifier: { isPool: async () => true },
    snapshot: async (id: string) => {
      if (!snapshots[id]) throw new Error("rpc down");
      return snapshots[id];
    },
    readStrategy: async () => ({ pool: frozen, asset: snapshots[ok].reserves[0].assetId, managedTokens: 500 }),
  };

  it("rates every discovered pool, records failures, and rates DeFindex strategies from on-chain config", async () => {
    const r = await runVigil(deps, {
      defindexStrategies: [{ strategyId: cid("s"), name: "S", asset: "USDC", assetContractId: snapshots[ok].reserves[0].assetId, blendPoolId: ok }],
    });
    expect(r.pools.map((p) => p.name)).toEqual(["OK", "Frozen"]);
    expect(r.failures).toEqual([{ id: broken, error: "rpc down" }]);
    expect(r.defindex[0].underlying).toEqual([frozen]); // on-chain Config.pool wins
    expect(r.defindex[0].eligibleForDeposit).toBe(false);
    expect(r.defindex[0].tvlUsd).toBe(500);

    const json = toRatingsJson(r);
    expect(json.coverage).toMatchObject({ poolsFound: 3, rated: 2, fallbackOnly: false });
    expect(json.ratings).toHaveLength(3);
    expect(JSON.parse(JSON.stringify(json)).ratings[0].reasonsHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
