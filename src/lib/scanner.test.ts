import { describe, it, expect } from "vitest";
import { scanSource, createBlendSource, createPoolCache, type RawReserve, type BlendReader } from "./scanner";
import { PermanentReadError } from "./rpcRetry";
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
    const out = await scanSource(flaky, ["C_A", "BAD", "NULL"], { onError: () => {} });
    expect(out.map((p) => p.poolId)).toEqual(["C_A"]);
  });

  const noWait = { sleep: async () => {} };

  it("retries a pool the RPC rate-limits instead of dropping it", async () => {
    let calls = 0;
    const limited: YieldSource = {
      protocol: "test",
      async readPool(id) {
        if (++calls < 3) throw new Error("Request failed with status code 429");
        return fakeSource.readPool(id);
      },
    };
    const out = await scanSource(limited, ["C_A"], { ...noWait, onError: () => {} });
    expect(out.map((p) => p.poolId)).toEqual(["C_A"]);
    expect(calls).toBe(3);
  });

  it("reports every pool it drops, without retrying a permanent failure", async () => {
    let calls = 0;
    const errors: string[] = [];
    const src: YieldSource = {
      protocol: "test",
      async readPool(id) {
        calls++;
        if (id === "NO_USDC") throw new PermanentReadError("No USDC reserve found in pool NO_USDC");
        throw new Error("Request failed with status code 429");
      },
    };
    const out = await scanSource(src, ["NO_USDC", "LIMITED"], {
      ...noWait,
      retryDelaysMs: [1, 1],
      onError: (id, e) => errors.push(`${id}: ${(e as Error).message}`),
    });
    expect(out).toEqual([]);
    expect(calls).toBe(1 + 3);
    expect(errors).toEqual(["NO_USDC: No USDC reserve found in pool NO_USDC", "LIMITED: Request failed with status code 429"]);
  });

  it("bounds the total retry wait of one scan", async () => {
    const waits: number[] = [];
    const src: YieldSource = {
      protocol: "test",
      async readPool() {
        throw new Error("Request failed with status code 429");
      },
    };
    await scanSource(src, ["A", "B", "C"], {
      sleep: async (ms) => void waits.push(ms),
      retryDelaysMs: [10, 10],
      retryBudgetMs: 30,
      onError: () => {},
    });
    expect(waits.reduce((a, b) => a + b, 0)).toBe(30);
  });
});

describe("createPoolCache", () => {
  it("loads a pool and its oracle once while fresh, and again after a failure", async () => {
    const loads: string[] = [];
    let fail = true;
    const cache = createPoolCache({
      loadPool: async (id) => {
        loads.push(id);
        if (id === "FLAKY" && fail) {
          fail = false;
          throw new Error("Request failed with status code 429");
        }
        return { id, loadOracle: async () => ({ id: `oracle:${id}` }) } as never;
      },
      ttlMs: 60_000,
    });
    await Promise.all([cache.pool("C_A"), cache.pool("C_A")]);
    await cache.oracle("C_A");
    await cache.oracle("C_A");
    expect(loads).toEqual(["C_A"]);
    await expect(cache.pool("FLAKY")).rejects.toThrow("429");
    await cache.pool("FLAKY");
    expect(loads).toEqual(["C_A", "FLAKY", "FLAKY"]);
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
