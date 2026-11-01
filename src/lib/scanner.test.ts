import { describe, it, expect } from "vitest";
import { scanSource, createBlendSource, type RawReserve, type BlendReader } from "./scanner";
import type { PoolYield, YieldSource } from "./types";

const fakeSource: YieldSource = {
  protocol: "test",
  async readPool(poolId) {
    const map: Record<string, PoolYield> = {
      C_A: { protocol: "test", poolId: "C_A", name: "A", asset: "USDC", apyBps: 860, tvlUsdc: 155_000_0000000n, utilizationBps: 6200, oracleHealthy: true },
    };
    return map[poolId] ?? null;
  },
};

describe("scanSource", () => {
  it("collects a PoolYield for each readable pool", async () => {
    const out = await scanSource(fakeSource, ["C_A"]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ protocol: "test", poolId: "C_A", apyBps: 860 });
  });

  it("skips pools that return null or throw", async () => {
    const flaky: YieldSource = {
      protocol: "test",
      async readPool(id) {
        if (id === "BAD") throw new Error("rpc");
        if (id === "NULL") return null;
        return fakeSource.readPool(id);
      },
    };
    const out = await scanSource(flaky, ["C_A", "BAD", "NULL"]);
    expect(out.map((p) => p.poolId)).toEqual(["C_A"]);
  });
});

const blendReader: BlendReader = {
  async readReserve(poolId: string): Promise<RawReserve> {
    const map: Record<string, RawReserve> = {
      C_A: { poolId: "C_A", name: "Fixed Pool", supplyApr: 0.086, totalSupplyUsdc: 155_000_0000000n, utilization: 0.62, oracleStale: false },
      C_B: { poolId: "C_B", name: "YBX Pool", supplyApr: 0.094, totalSupplyUsdc: 40_000_0000000n, utilization: 0.71, oracleStale: true },
    };
    return map[poolId];
  },
};

describe("createBlendSource", () => {
  it("maps a Blend reserve to a protocol-tagged PoolYield", async () => {
    const src = createBlendSource(blendReader);
    expect(src.protocol).toBe("blend");
    expect(await src.readPool("C_A")).toMatchObject({
      protocol: "blend", poolId: "C_A", apyBps: 860, oracleHealthy: true, utilizationBps: 6200, tvlUsdc: 155_000_0000000n,
    });
    expect(await src.readPool("C_B")).toMatchObject({ protocol: "blend", poolId: "C_B", apyBps: 940, oracleHealthy: false });
  });

  it("carries the Blend pool status through to the PoolYield", async () => {
    const frozenReader: BlendReader = {
      async readReserve(poolId) {
        return { poolId, name: "Etherfuse", supplyApr: 0.01, totalSupplyUsdc: 15_000_0000000n, utilization: 0.1, oracleStale: false, poolStatus: 4 };
      },
    };
    expect(await createBlendSource(frozenReader).readPool("C_E")).toMatchObject({ poolStatus: 4 });
  });
});
