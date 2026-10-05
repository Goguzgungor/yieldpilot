import { describe, expect, it } from "vitest";
import { ApiError, createApi } from "../../scripts/loadtest/api";
import type { requestJson } from "../../scripts/loadtest/http";

const BASE = "http://localhost:3100";
type Call = { method: string; url: string; body: unknown; timeoutMs: number | undefined };

function fake(status: number, data: unknown) {
  const calls: Call[] = [];
  const request = (async (method: string, url: string, body?: unknown, timeoutMs?: number) => {
    calls.push({ method, url, body, timeoutMs });
    return { status, data };
  }) as unknown as typeof requestJson;
  return { calls, request };
}

describe("createApi", () => {
  it("prepareDeploy posts step=deploy and returns xdr + contractId", async () => {
    const f = fake(200, { xdr: "AAA", contractId: "CSA" });
    expect(await createApi(BASE, { request: f.request }).prepareDeploy("GOWN")).toEqual({ xdr: "AAA", contractId: "CSA" });
    expect(f.calls[0]).toMatchObject({ method: "POST", url: `${BASE}/api/onboard/prepare`, body: { owner: "GOWN", step: "deploy" } });
  });

  it("treats a deploy answer without contractId as an error", async () => {
    await expect(createApi(BASE, { request: fake(200, { xdr: "AAA" }).request }).prepareDeploy("G")).rejects.toBeInstanceOf(ApiError);
  });

  it("prepareFund sends the amount as a decimal stroop string", async () => {
    const f = fake(200, { xdr: "AAA" });
    await createApi(BASE, { request: f.request }).prepareFund("GOWN", "CSA", 2_500_000_000n);
    expect(f.calls[0].body).toEqual({ owner: "GOWN", step: "fund", smartWallet: "CSA", amountStroops: "2500000000" });
  });

  it("faucet and register post the UI's bodies", async () => {
    const f = fake(200, { ok: true, txHash: "m1" });
    const api = createApi(BASE, { request: f.request });
    expect(await api.faucet("CSA", 250)).toEqual({ txHash: "m1" });
    await api.register({ owner: "G", smartWallet: "C", poolRuleId: 1, usdcRuleId: 2 });
    expect(f.calls.map((c) => [c.url, c.body])).toEqual([
      [`${BASE}/api/faucet`, { to: "CSA", amount: 250 }],
      [`${BASE}/api/register`, { owner: "G", smartWallet: "C", poolRuleId: 1, usdcRuleId: 2 }],
    ]);
  });

  it("unregister puts the owner in the query string", async () => {
    const f = fake(200, { ok: true, removed: true });
    expect(await createApi(BASE, { request: f.request }).unregister("GOWN")).toEqual({ removed: true });
    expect(f.calls[0]).toMatchObject({ method: "DELETE", url: `${BASE}/api/register?owner=GOWN` });
  });

  it("tick waits without a client timeout and carries the cron key", async () => {
    const f = fake(200, { ok: true, ranAt: "t" });
    await createApi(BASE, { request: f.request, cronSecret: "s3" }).tick();
    expect(f.calls[0]).toMatchObject({ method: "POST", url: `${BASE}/api/tick?key=s3`, timeoutMs: 0 });
  });

  it("maps failures to ApiError: 4xx permanent, 5xx and unreachable transient, cron key never in the message", async () => {
    const reg = { owner: "G", smartWallet: "C", poolRuleId: 1, usdcRuleId: 2 };
    const e400 = await createApi(BASE, { request: fake(400, { error: "invalid body" }).request }).register(reg).catch((e) => e);
    expect(e400).toBeInstanceOf(ApiError);
    expect(e400.permanent).toBe(true);
    expect(e400.message).toContain("invalid body");
    const e502 = await createApi(BASE, { request: fake(502, { ok: false, error: "faucet mint failed" }).request }).faucet("C", 5).catch((e) => e);
    expect(e502.permanent).toBe(false);
    const e0 = await createApi(BASE, { request: fake(0, null).request, cronSecret: "s3" }).tick().catch((e) => e);
    expect(e0.status).toBe(0);
    expect(e0.message).not.toContain("s3");
  });
});
