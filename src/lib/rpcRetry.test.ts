import { describe, it, expect } from "vitest";
import { isTransientRpcError, PermanentReadError, withRetry } from "./rpcRetry";

describe("isTransientRpcError", () => {
  it("treats rate limits, 5xx and dropped connections as transient", () => {
    expect(isTransientRpcError(new Error("Request failed with status code 429"))).toBe(true);
    expect(isTransientRpcError(Object.assign(new Error("boom"), { response: { status: 429 } }))).toBe(true);
    expect(isTransientRpcError(new Error("Request failed with status code 503"))).toBe(true);
    expect(isTransientRpcError(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))).toBe(true);
    expect(isTransientRpcError(new Error("timeout of 30000ms exceeded"))).toBe(true);
    expect(isTransientRpcError(new TypeError("fetch failed"))).toBe(true);
  });

  it("treats a missing reserve, a contract error or an unknown error as permanent", () => {
    expect(isTransientRpcError(new PermanentReadError("No USDC reserve found in pool C"))).toBe(false);
    expect(isTransientRpcError(new Error("HostError: Error(Contract, #1206)"))).toBe(false);
    expect(isTransientRpcError(new Error("Request failed with status code 404"))).toBe(false);
    expect(isTransientRpcError(new Error("rpc"))).toBe(false);
  });
});

describe("withRetry", () => {
  const recorder = () => {
    const waits: number[] = [];
    return { waits, sleep: async (ms: number) => void waits.push(ms) };
  };
  const rateLimited = () => new Error("Request failed with status code 429");

  it("retries a transient failure after each configured delay until it succeeds", async () => {
    const { waits, sleep } = recorder();
    let calls = 0;
    const v = await withRetry(async () => {
      if (++calls < 3) throw rateLimited();
      return "ok";
    }, { delaysMs: [10, 20, 40], sleep });
    expect(v).toBe("ok");
    expect(calls).toBe(3);
    expect(waits).toEqual([10, 20]);
  });

  it("rethrows the last error once the delays run out", async () => {
    const { waits, sleep } = recorder();
    let calls = 0;
    await expect(withRetry(async () => {
      calls++;
      throw rateLimited();
    }, { delaysMs: [10, 20], sleep })).rejects.toThrow("429");
    expect(calls).toBe(3);
    expect(waits).toEqual([10, 20]);
  });

  it("does not retry a permanent failure", async () => {
    const { waits, sleep } = recorder();
    let calls = 0;
    await expect(withRetry(async () => {
      calls++;
      throw new PermanentReadError("No USDC reserve found in pool C");
    }, { delaysMs: [10, 20], sleep })).rejects.toThrow("No USDC reserve");
    expect(calls).toBe(1);
    expect(waits).toEqual([]);
  });

  it("stops retrying when a shared budget cannot cover the next wait", async () => {
    const { waits, sleep } = recorder();
    const budget = { remainingMs: 25 };
    let calls = 0;
    const fail = async () => {
      calls++;
      throw rateLimited();
    };
    await expect(withRetry(fail, { delaysMs: [10, 20], sleep, budget })).rejects.toThrow("429");
    expect(waits).toEqual([10]); // 20 more would overrun the 15 left
    expect(budget.remainingMs).toBe(15);
    await expect(withRetry(fail, { delaysMs: [10, 20], sleep, budget })).rejects.toThrow("429");
    expect(waits).toEqual([10, 10]);
    expect(budget.remainingMs).toBe(5);
    expect(calls).toBe(4);
  });
});
