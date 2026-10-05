import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import { ApiError, type YsApi } from "../../scripts/loadtest/api";
import type { ChainOps } from "../../scripts/loadtest/chain";
import { openRunDir, type RunFiles } from "../../scripts/loadtest/manifest";
import type { PlanEvent } from "../../scripts/loadtest/schedule";
import { runEvent, type StepCtx } from "../../scripts/loadtest/steps";

const wallets = [Keypair.random(), Keypair.random()];
const tmpFiles = () => openRunDir(mkdtempSync(join(tmpdir(), "ys-lt-")));

function fakeApi(over: Partial<YsApi> = {}): YsApi {
  return {
    agent: vi.fn(async () => ({ agentPublicKey: "GAGENT", ownerPublicKey: "GDEMO" })),
    prepareDeploy: vi.fn(async () => ({ xdr: "UNSIGNED", contractId: "CSA0" })),
    prepareFund: vi.fn(async () => ({ xdr: "UNSIGNED_FUND" })),
    submit: vi.fn(async (x: string) => ({ hash: `h(${x})` })),
    authorize: vi.fn(async () => ({ poolRuleId: 1, usdcRuleId: 2, hashes: ["hp", "hu"] })),
    faucet: vi.fn(async (to: string, usdc: number) => ({ txHash: `mint(${to},${usdc})` })),
    register: vi.fn(async () => {}),
    unregister: vi.fn(async () => ({ removed: true })),
    tick: vi.fn(async () => ({ ranAt: "t" })),
    get: vi.fn(async (p: string) => ({ route: p })),
    ...over,
  };
}
function fakeChain(): ChainOps {
  return {
    ensureFunded: vi.fn(async () => "funded" as const),
    ensureTrustline: vi.fn(async () => "htrust"),
    sign: vi.fn((xdr: string) => `signed:${xdr}`),
  };
}
function ctxWith(api: YsApi, files: RunFiles = tmpFiles(), chain: ChainOps = fakeChain()): StepCtx {
  let t = 1_000;
  return {
    api, chain, files,
    wallet: (i) => wallets[i],
    now: () => (t += 10),
    sleep: async () => {},
    retry: { attempts: 3, baseDelayMs: 1, outageWaitMs: 1, maxOutageWaits: 2 },
    log: () => {},
  };
}
const onboard: PlanEvent = { id: "onboard:w00", atMin: 0, kind: "onboard", wallet: 0, fundUsdc: 250 };
const owner0 = wallets[0].publicKey();

describe("onboard", () => {
  it("runs friendbot → deploy → authorize → fund → register like the UI", async () => {
    const api = fakeApi();
    const ctx = ctxWith(api);
    const rec = await runEvent(ctx, onboard, 0);
    expect(rec).toMatchObject({
      status: "ok",
      hashes: ["h(signed:UNSIGNED)", "hp", "hu", "mint(CSA0,250)"],
      data: { owner: owner0, smartWallet: "CSA0", poolRuleId: 1, usdcRuleId: 2, fundUsdc: 250 },
    });
    expect(ctx.chain.sign).toHaveBeenCalledWith("UNSIGNED", wallets[0]);
    expect(api.authorize).toHaveBeenCalledWith("CSA0", owner0);
    expect(api.faucet).toHaveBeenCalledWith("CSA0", 250);
    expect(api.register).toHaveBeenCalledWith({ owner: owner0, smartWallet: "CSA0", poolRuleId: 1, usdcRuleId: 2 });
    expect(ctx.files.read().at(-1)).toEqual(rec);
  });

  it("resumes after deploy + authorize without redeploying", async () => {
    const files = tmpFiles();
    files.append({ type: "step", eventId: onboard.id, wallet: 0, step: "friendbot", at: 1, hashes: [] });
    files.append({ type: "step", eventId: onboard.id, wallet: 0, step: "deploy", at: 1, hashes: ["hd"], data: { smartWallet: "CSA_OLD" } });
    files.append({ type: "step", eventId: onboard.id, wallet: 0, step: "authorize", at: 1, hashes: ["hp", "hu"], data: { poolRuleId: 5, usdcRuleId: 6 } });
    const api = fakeApi();
    const rec = await runEvent(ctxWith(api, files), onboard, 0);
    expect(api.prepareDeploy).not.toHaveBeenCalled();
    expect(api.authorize).not.toHaveBeenCalled();
    expect(api.faucet).toHaveBeenCalledWith("CSA_OLD", 250);
    expect(rec.data).toMatchObject({ smartWallet: "CSA_OLD", poolRuleId: 5, usdcRuleId: 6 });
    expect(rec.hashes).toEqual(["hd", "hp", "hu", "mint(CSA_OLD,250)"]);
  });

  it("retries a transient failure, then succeeds", async () => {
    let n = 0;
    const api = fakeApi({
      authorize: vi.fn(async () => {
        if (n++ < 2) throw new ApiError("/api/authorize", 500, "boom");
        return { poolRuleId: 1, usdcRuleId: 2, hashes: ["hp", "hu"] };
      }),
    });
    expect((await runEvent(ctxWith(api), onboard, 0)).status).toBe("ok");
    expect(api.authorize).toHaveBeenCalledTimes(3);
  });

  it("waits out an unreachable server without burning attempts", async () => {
    let n = 0;
    const api = fakeApi({
      faucet: vi.fn(async () => {
        if (n++ < 2) throw new ApiError("/api/faucet", 0, "null");
        return { txHash: "m" };
      }),
      register: vi.fn(async () => {
        throw new ApiError("/api/register", 500, "x");
      }),
    });
    const rec = await runEvent(ctxWith(api), onboard, 0);
    // 2 outages absorbed on faucet; register then burns its own 3 attempts.
    expect(api.faucet).toHaveBeenCalledTimes(3);
    expect(api.register).toHaveBeenCalledTimes(3);
    expect(rec.status).toBe("failed");
  });

  it("fails fast on a 4xx and records the error", async () => {
    const api = fakeApi({
      register: vi.fn(async () => {
        throw new ApiError("/api/register", 400, "invalid body");
      }),
    });
    const rec = await runEvent(ctxWith(api), onboard, 0);
    expect(rec.status).toBe("failed");
    expect(rec.error).toContain("invalid body");
    expect(api.register).toHaveBeenCalledTimes(1);
  });
});

describe("after onboarding", () => {
  async function onboarded() {
    const ctx = ctxWith(fakeApi());
    await runEvent(ctx, onboard, 0);
    return ctx;
  }

  it("transfer top-up: trustline → mint to G → wallet-signed G→SA transfer", async () => {
    const ctx = await onboarded();
    const rec = await runEvent(ctx, { id: "topup:w00:1", atMin: 60, kind: "topup", wallet: 0, usdc: 100, via: "transfer" }, 0);
    expect(rec.status).toBe("ok");
    expect(ctx.api.faucet).toHaveBeenLastCalledWith(owner0, 100);
    expect(ctx.api.prepareFund).toHaveBeenCalledWith(owner0, "CSA0", 1_000_000_000n);
    expect(rec.hashes).toEqual(["htrust", `mint(${owner0},100)`, "h(signed:UNSIGNED_FUND)"]);
  });

  it("second transfer top-up skips the trustline", async () => {
    const ctx = await onboarded();
    await runEvent(ctx, { id: "topup:w00:1", atMin: 60, kind: "topup", wallet: 0, usdc: 100, via: "transfer" }, 0);
    await runEvent(ctx, { id: "topup:w00:2", atMin: 90, kind: "topup", wallet: 0, usdc: 50, via: "transfer" }, 0);
    expect(ctx.chain.ensureTrustline).toHaveBeenCalledTimes(1);
  });

  it("faucet top-up mints into the smart account", async () => {
    const ctx = await onboarded();
    await runEvent(ctx, { id: "topup:w00:1", atMin: 60, kind: "topup", wallet: 0, usdc: 3000, via: "faucet" }, 0);
    expect(ctx.api.faucet).toHaveBeenLastCalledWith("CSA0", 3000);
  });

  it("unregister forgets the owner", async () => {
    const ctx = await onboarded();
    const rec = await runEvent(ctx, { id: "unregister:w00", atMin: 90, kind: "unregister", wallet: 0 }, 0);
    expect(ctx.api.unregister).toHaveBeenCalledWith(owner0);
    expect(rec.data).toMatchObject({ removed: true, smartWallet: "CSA0" });
  });

  it("skips actions for a wallet that never onboarded", async () => {
    const ctx = ctxWith(fakeApi());
    const rec = await runEvent(ctx, { id: "topup:w01:1", atMin: 60, kind: "topup", wallet: 1, usdc: 50, via: "faucet" }, 0);
    expect(rec.status).toBe("skipped");
    expect(ctx.api.faucet).not.toHaveBeenCalled();
  });

  it("tick records the server's ranAt and how long it took", async () => {
    const rec = await runEvent(ctxWith(fakeApi()), { id: "tick:0010", atMin: 10, kind: "tick" }, 0);
    expect(rec.data).toMatchObject({ ranAt: "t" });
    expect(Number(rec.data?.durationMs)).toBeGreaterThan(0);
  });

  it("snapshot writes every read route to the run dir", async () => {
    const ctx = ctxWith(fakeApi());
    await runEvent(ctx, { id: "snapshot:0120", atMin: 120, kind: "snapshot" }, 0);
    const snap = ctx.files.readJson<Record<string, unknown>>("snapshots/snapshot-0120.json")!;
    expect(snap["/api/users"]).toEqual({ route: "/api/users" });
    expect(snap["/api/activity"]).toEqual({ route: "/api/activity" });
  });
});
