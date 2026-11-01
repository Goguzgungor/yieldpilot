import { describe, it, expect, vi } from "vitest";
import { probeWallet } from "./walletDetect";

const noSleep = async () => {};

describe("probeWallet", () => {
  it("is true as soon as the extension answers connected", async () => {
    const isConnected = vi.fn(async () => ({ isConnected: true }));
    expect(await probeWallet(isConnected, { sleep: noSleep })).toBe(true);
    expect(isConnected).toHaveBeenCalledTimes(1);
  });

  it("retries a probe that went unanswered (freighter-api reports a 2 s timeout as isConnected:false)", async () => {
    const answers = [{ isConnected: false }, { isConnected: false }, { isConnected: true }];
    const isConnected = vi.fn(async () => answers.shift()!);
    expect(await probeWallet(isConnected, { attempts: 3, sleep: noSleep })).toBe(true);
    expect(isConnected).toHaveBeenCalledTimes(3);
  });

  it("treats a throwing probe like an unanswered one", async () => {
    let n = 0;
    const isConnected = vi.fn(async () => {
      if (n++ === 0) throw new Error("extension context invalidated");
      return { isConnected: true };
    });
    expect(await probeWallet(isConnected, { sleep: noSleep })).toBe(true);
  });

  it("is false only after every attempt went unanswered, backing off between attempts", async () => {
    const sleeps: number[] = [];
    const isConnected = vi.fn(async () => ({ isConnected: false }));
    const ok = await probeWallet(isConnected, { attempts: 3, delayMs: 500, sleep: async (ms) => void sleeps.push(ms) });
    expect(ok).toBe(false);
    expect(isConnected).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([500, 1000]);
  });
});
