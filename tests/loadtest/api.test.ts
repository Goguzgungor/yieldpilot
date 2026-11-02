import { describe, expect, it } from "vitest";
import { ApiError, createApi } from "../../scripts/loadtest/api";
import type { requestJson } from "../../scripts/loadtest/http";
import { ownerMessage } from "../../src/lib/ownerMessage";

const BASE = "http://localhost:3100";
type Call = { method: string; url: string; body: unknown; timeoutMs: number | undefined };

function fake(status: number, data: unknown, code?: string) {
  const calls: Call[] = [];
  const request = (async (method: string, url: string, body?: unknown, timeoutMs?: number) => {
    calls.push({ method, url, body, timeoutMs });
    return { status, data, code };
  }) as unknown as typeof requestJson;
  return { calls, request };
}

describe("createApi", () => {
  it("prepareDeploy posts step=deploy and returns xdr + contractId", async () => {
    const f = fake(200, { xdr: "AAA", contractId: "CSA" });
    expect(await createApi(BASE, { request: f.request }).prepareDeploy("GOWN")).toEqual({ xdr: "AAA", contractId: "CSA" });
    expect(f.calls[0]).toMatchObject({ method: "POST", url: `${BASE}/api/onboard/prepare`, body: { owner: "GOWN", step: "deploy" } });
  });

  it("authorize prepares, wallet-signs and submits both agent rules, returning the rule ids", async () => {
    const calls: Call[] = [];
    let n = 0;
    const request = (async (method: string, url: string, body?: unknown, timeoutMs?: number) => {
      calls.push({ method, url, body, timeoutMs });
      if (url.endsWith("/prepare")) return { status: 200, data: { xdr: `X${n}` } };
      n++;
      return { status: 200, data: { hash: `h${n}`, contextRuleId: n } };
    }) as unknown as typeof requestJson;
    const r = await createApi(BASE, { request }).authorize("CSA", "GOWN", (x) => `signed:${x}`);
    expect(r).toEqual({ poolRuleId: 1, usdcRuleId: 2, hashes: ["h1", "h2"] });
    expect(calls.map((c) => (c.body as { step?: string }).step ?? (c.body as { signedXdr: string }).signedXdr)).toEqual([
      "authorize-pool",
      "signed:X0",
      "authorize-usdc",
      "signed:X1",
    ]);
  });

  it("authorize fails if the submit answer has no rule id", async () => {
    const f = fake(200, { xdr: "X", hash: "h" });
    await expect(createApi(BASE, { request: f.request }).authorize("CSA", "G", (x) => x)).rejects.toBeInstanceOf(ApiError);
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
    const signed: string[] = [];
    await api.register({ owner: "G", smartWallet: "C", poolRuleId: 1, usdcRuleId: 2 }, (m) => (signed.push(m), "SIG"));
    expect(f.calls.map((c) => [c.url, c.body])).toEqual([
      [`${BASE}/api/faucet`, { to: "CSA", amount: 250 }],
      [`${BASE}/api/register`, { owner: "G", smartWallet: "C", poolRuleId: 1, usdcRuleId: 2, signedAt: expect.any(String), signature: "SIG" }],
    ]);
    // the wallet signs the same message the UI asks Freighter to sign
    const { signedAt } = f.calls[1].body as { signedAt: string };
    expect(signed).toEqual([ownerMessage({ action: "register", owner: "G", smartWallet: "C", poolRuleId: 1, usdcRuleId: 2 }, signedAt)]);
  });

  it("unregister sends the owner's signed request in the body", async () => {
    const f = fake(200, { ok: true, removed: true });
    const signed: string[] = [];
    expect(await createApi(BASE, { request: f.request }).unregister("GOWN", (m) => (signed.push(m), "SIG"))).toEqual({ removed: true });
    expect(f.calls[0]).toMatchObject({
      method: "DELETE",
      url: `${BASE}/api/register`,
      body: { owner: "GOWN", signedAt: expect.any(String), signature: "SIG" },
    });
    const { signedAt } = f.calls[0].body as { signedAt: string };
    expect(signed).toEqual([ownerMessage({ action: "unregister", owner: "GOWN" }, signedAt)]);
  });

  it("tick waits without a client timeout and carries the cron key", async () => {
    const f = fake(200, { ok: true, ranAt: "t" });
    await createApi(BASE, { request: f.request, cronSecret: "s3" }).tick();
    expect(f.calls[0]).toMatchObject({ method: "POST", url: `${BASE}/api/tick?key=s3`, timeoutMs: 0 });
  });

  it("maps failures to ApiError: 4xx permanent, 5xx and unreachable transient, cron key never in the message", async () => {
    const reg = { owner: "G", smartWallet: "C", poolRuleId: 1, usdcRuleId: 2 };
    const e400 = await createApi(BASE, { request: fake(400, { error: "invalid body" }).request }).register(reg, () => "SIG").catch((e) => e);
    expect(e400).toBeInstanceOf(ApiError);
    expect(e400.permanent).toBe(true);
    expect(e400.message).toContain("invalid body");
    const e502 = await createApi(BASE, { request: fake(502, { ok: false, error: "faucet mint failed" }).request }).faucet("C", 5).catch((e) => e);
    expect(e502.permanent).toBe(false);
    const e0 = await createApi(BASE, { request: fake(0, null, "ECONNREFUSED").request, cronSecret: "s3" }).tick().catch((e) => e);
    expect(e0.status).toBe(0);
    expect(e0.code).toBe("ECONNREFUSED");
    expect(e0.message).toContain("ECONNREFUSED");
    expect(e0.message).not.toContain("s3");
  });
});
