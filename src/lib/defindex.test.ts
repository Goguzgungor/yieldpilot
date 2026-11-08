import { describe, it, expect } from "vitest";
import { createDefindexSource, toUsdcStroops, type StrategyTvlReader } from "./defindex";
import type { BlendReader, RawReserve } from "./scanner";
import type { DefindexStrategyConfig } from "./config";

const usdcReader: BlendReader = {
  async readReserve(poolId: string): Promise<RawReserve> {
    return { poolId, name: "Blend Fixed", supplyApr: 0.086, totalSupplyUsdc: 155_000_0000000n, utilization: 0.62, oracleStale: false };
  },
};
const readerFor = (): BlendReader => usdcReader;

const strategies: DefindexStrategyConfig[] = [
  {
    strategyId: "C_STRAT_USDC", blendPoolId: "C_BLEND_FIXED", name: "DeFindex USDC · Blend Fixed",
    asset: "USDC", assetContractId: "C_USDC", fallbackTvlUsdc: 1_000_0000000n,
  },
];

describe("createDefindexSource", () => {
  it("derives APY/utilization/oracle from the underlying Blend reserve, tagged defindex", async () => {
    const src = createDefindexSource(readerFor, strategies);
    expect(src.protocol).toBe("defindex");
    expect(await src.readPool("C_STRAT_USDC")).toMatchObject({
      protocol: "defindex", poolId: "C_STRAT_USDC", name: "DeFindex USDC · Blend Fixed",
      asset: "USDC", apyBps: 860, utilizationBps: 6200, oracleHealthy: true,
    });
  });

  it("reads each strategy's configured asset reserve via readerFor (multi-asset)", async () => {
    const byAsset: Record<string, RawReserve> = {
      C_USDC: { poolId: "C_FIXED", name: "Fixed", supplyApr: 0.0821, totalSupplyUsdc: 1n, utilization: 0.77, oracleStale: false },
      C_EURC: { poolId: "C_FIXED", name: "Fixed", supplyApr: 0.0659, totalSupplyUsdc: 1n, utilization: 0.738, oracleStale: false },
    };
    const multiReaderFor = (assetId: string): BlendReader => ({
      async readReserve(poolId) { return { ...byAsset[assetId], poolId }; },
    });
    const eurc: DefindexStrategyConfig = {
      strategyId: "C_STRAT_EURC", blendPoolId: "C_FIXED", name: "DeFindex EURC · Fixed",
      asset: "EURC", assetContractId: "C_EURC", fallbackTvlUsdc: 0n,
    };
    const src = createDefindexSource(multiReaderFor, [strategies[0], eurc]);
    expect(await src.readPool("C_STRAT_USDC")).toMatchObject({ asset: "USDC", apyBps: 821, utilizationBps: 7700 });
    expect(await src.readPool("C_STRAT_EURC")).toMatchObject({ asset: "EURC", apyBps: 659, utilizationBps: 7380 });
  });

  it("uses configured fallback TVL when no on-chain reader is provided", async () => {
    const src = createDefindexSource(readerFor, strategies);
    expect((await src.readPool("C_STRAT_USDC"))?.tvlUsdc).toBe(1_000_0000000n);
  });

  it("prefers live on-chain strategy TVL when a reader returns a value", async () => {
    const tvlReader: StrategyTvlReader = { async readTotalManagedFunds() { return 7_500_0000000n; } };
    const src = createDefindexSource(readerFor, strategies, tvlReader);
    expect((await src.readPool("C_STRAT_USDC"))?.tvlUsdc).toBe(7_500_0000000n);
  });

  it("falls back to config TVL when the on-chain reader returns null or throws", async () => {
    const nullReader: StrategyTvlReader = { async readTotalManagedFunds() { return null; } };
    const throwReader: StrategyTvlReader = { async readTotalManagedFunds() { throw new Error("rpc"); } };
    expect((await createDefindexSource(readerFor, strategies, nullReader).readPool("C_STRAT_USDC"))?.tvlUsdc).toBe(1_000_0000000n);
    const quiet = { onTvlError: () => {} };
    expect((await createDefindexSource(readerFor, strategies, throwReader, quiet).readPool("C_STRAT_USDC"))?.tvlUsdc).toBe(1_000_0000000n);
  });

  it("retries a rate-limited TVL read instead of showing the fallback", async () => {
    let calls = 0;
    const limited: StrategyTvlReader = {
      async readTotalManagedFunds() {
        if (++calls < 3) throw new Error("Request failed with status code 429");
        return 18_893_585_0000000n;
      },
    };
    const src = createDefindexSource(readerFor, strategies, limited, { sleep: async () => {} });
    expect((await src.readPool("C_STRAT_USDC"))?.tvlUsdc).toBe(18_893_585_0000000n);
    expect(calls).toBe(3);
  });

  it("reports a TVL read that still fails, and keeps the fallback", async () => {
    const errors: string[] = [];
    const down: StrategyTvlReader = { async readTotalManagedFunds() { throw new Error("Request failed with status code 503"); } };
    const src = createDefindexSource(readerFor, strategies, down, {
      sleep: async () => {},
      onTvlError: (id, e) => errors.push(`${id}: ${(e as Error).message}`),
    });
    expect((await src.readPool("C_STRAT_USDC"))?.tvlUsdc).toBe(1_000_0000000n);
    expect(errors).toEqual(["C_STRAT_USDC: Request failed with status code 503"]);
  });

  it("returns null for an unknown strategy id", async () => {
    const src = createDefindexSource(readerFor, strategies);
    expect(await src.readPool("C_UNKNOWN")).toBeNull();
  });

  it("inherits the underlying Blend pool status", async () => {
    const onIceFor = (): BlendReader => ({
      async readReserve(poolId) {
        return { poolId, name: "Blend Fixed", supplyApr: 0.05, totalSupplyUsdc: 1n, utilization: 0.5, oracleStale: false, poolStatus: 3 };
      },
    });
    expect(await createDefindexSource(onIceFor, strategies).readPool("C_STRAT_USDC")).toMatchObject({ poolStatus: 3 });
  });
});

describe("toUsdcStroops", () => {
  it("passes 7-decimal USDC through at price 1", () => {
    expect(toUsdcStroops(187_810_278_070_411n, 7, 1)).toBe(187_810_278_070_411n);
  });
  it("prices non-USDC assets with the oracle price", () => {
    // 42,149.2258669 XLM at $0.168342 ≈ $7,095.48
    expect(toUsdcStroops(421_492_258_669n, 7, 0.168342)).toBe(70_954_849_809n);
  });
  it("rescales other decimals and rejects unusable inputs", () => {
    expect(toUsdcStroops(5_000_000n, 6, 1)).toBe(50_000_000n);
    expect(toUsdcStroops(0n, 7, 1)).toBe(0n);
    expect(toUsdcStroops(10n, 7, Number.NaN)).toBe(0n);
  });
});
