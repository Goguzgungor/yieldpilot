import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

// The mainnet read is replaced: these tests cover only how /api/ratings uses the cache.
const compute = vi.fn();
vi.mock("./vigil/service", () => ({ computeLiveRatings: (...a: unknown[]) => compute(...a) }));

type Runtime = typeof import("./runtime");
let runtime: Runtime;
const HOUR = 60 * 60 * 1000;
const run = (tag: string) => ({ engineVersion: "vigil-risk-v2.3.0", computedAt: tag, ratings: [] });
const kv = () => runtime.getRuntime().db;

beforeAll(async () => {
  const env: Record<string, string> = {
    SCAN_RPC_URL: "https://mainnet.sorobanrpc.com",
    SCAN_NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015",
    SCAN_BLEND_POOL_IDS: "C_A",
    SCAN_USDC_CONTRACT_ID: "C_USDC_MAINNET",
    EXEC_RPC_URL: "https://soroban-testnet.stellar.org",
    EXEC_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
    EXEC_POOL_ID: "C_EXEC_POOL",
    EXEC_USDC_CONTRACT_ID: "C_USDC_TESTNET",
    AGENT_SIGNER_SECRET: Keypair.random().secret(),
    SMART_WALLET_ADDRESS: "C_WALLET",
    PER_TX_CAP_USDC: "2000",
    DAILY_CAP_USDC: "5000",
    MIN_YIELD_DELTA_BPS: "50",
    REBALANCE_COOLDOWN_SEC: "120",
    SCAN_INTERVAL_SEC: "30",
    AGENT_LOOP_ENABLED: "0",
  };
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  delete process.env.MONGODB_URI; // in-memory KV
  runtime = await import("./runtime");
});

beforeEach(async () => {
  compute.mockReset();
  await kv().setKV("vigilRatingsRefreshAt", "0");
});

async function seed(tag: string, ageMs: number) {
  await kv().setKV("vigilRatings", JSON.stringify(run(tag)));
  await kv().setKV("vigilRatingsAt", String(Date.now() - ageMs));
}

describe("ratings cache", () => {
  it("serves an expired copy at once instead of making the visitor wait for the mainnet read", async () => {
    await seed("old", 2 * HOUR);
    const r = await runtime.getRatings();
    expect(r.data.computedAt).toBe("old");
    expect(r.expired).toBe(true);
    expect(compute).not.toHaveBeenCalled();
  });

  it("a fresh copy is not expired", async () => {
    await seed("fresh", 10 * 60 * 1000);
    expect((await runtime.getRatings()).expired).toBe(false);
  });

  it("the background refresh recomputes and stores the new run", async () => {
    await seed("old", 2 * HOUR);
    compute.mockResolvedValue(run("new"));
    await runtime.refreshExpiredRatings();
    expect(compute).toHaveBeenCalledTimes(1);
    const r = await runtime.getRatings();
    expect(r).toMatchObject({ expired: false, stale: false });
    expect(r.data.computedAt).toBe("new");
  });

  it("only one background run at a time, and none once the cache is fresh again", async () => {
    await seed("old", 2 * HOUR);
    await kv().setKV("vigilRatingsRefreshAt", String(Date.now() - 60_000)); // started on another instance
    await runtime.refreshExpiredRatings();
    expect(compute).not.toHaveBeenCalled();

    await kv().setKV("vigilRatingsRefreshAt", "0");
    await seed("fresh", 60_000);
    await runtime.refreshExpiredRatings();
    expect(compute).not.toHaveBeenCalled();
  });

  it("a failed background run keeps the old copy and does not throw", async () => {
    await seed("old", 2 * HOUR);
    compute.mockRejectedValue(new Error("rpc down"));
    await expect(runtime.refreshExpiredRatings()).resolves.toBeUndefined();
    expect((await runtime.getRatings()).data.computedAt).toBe("old");
  });
});
