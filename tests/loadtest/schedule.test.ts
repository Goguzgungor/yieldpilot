import { describe, expect, it } from "vitest";
import { assignCohorts, buildPlan, COHORT_SIZES, type PlanEvent } from "../../scripts/loadtest/schedule";
import { assertSameWallets, deriveWallet } from "../../scripts/loadtest/wallets";

const SEED_HEX = "11".repeat(32);

describe("deriveWallet", () => {
  it("is deterministic per (seed, index) and distinct across indices", () => {
    const a = deriveWallet(SEED_HEX, 0).publicKey();
    expect(deriveWallet(SEED_HEX, 0).publicKey()).toBe(a);
    const all = new Set(Array.from({ length: 97 }, (_, i) => deriveWallet(SEED_HEX, i).publicKey()));
    expect(all.size).toBe(97);
    expect(deriveWallet("22".repeat(32), 0).publicKey()).not.toBe(a);
  });
  it("rejects a malformed seed", () => {
    expect(() => deriveWallet("abc", 0)).toThrow(/32 bytes/);
  });
});

describe("assertSameWallets", () => {
  it("refuses to resume when LOADTEST_SEED changed", () => {
    const stored = [{ index: 0, owner: deriveWallet(SEED_HEX, 0).publicKey() }];
    expect(() => assertSameWallets(stored, (i) => deriveWallet(SEED_HEX, i).publicKey())).not.toThrow();
    expect(() => assertSameWallets(stored, (i) => deriveWallet("22".repeat(32), i).publicKey())).toThrow(
      /LOADTEST_SEED changed/,
    );
  });
});

describe("buildPlan", () => {
  const plan = buildPlan({ walletCount: 97, seed: 42 });
  const of = <K extends PlanEvent["kind"]>(k: K) =>
    plan.events.filter((e): e is Extract<PlanEvent, { kind: K }> => e.kind === k);
  const onboardAt = new Map(of("onboard").map((e) => [e.wallet, e.atMin]));
  const cohort = (i: number) => plan.wallets[i].cohort;

  it("is reproducible from its seed", () => {
    expect(buildPlan({ walletCount: 97, seed: 42 })).toEqual(plan);
    expect(buildPlan({ walletCount: 97, seed: 43 }).events).not.toEqual(plan.events);
  });

  it("splits 97 wallets into the fixed cohorts", () => {
    const counts = Object.fromEntries(
      Object.keys(COHORT_SIZES).map((c) => [c, plan.wallets.filter((w) => w.cohort === c).length]),
    );
    expect(counts).toEqual(COHORT_SIZES);
  });

  it("onboards every wallet once: 25 in the first hour, none after T+20h", () => {
    expect(of("onboard")).toHaveLength(97);
    expect(onboardAt.size).toBe(97);
    expect(of("onboard").filter((e) => e.atMin < 60)).toHaveLength(25);
    expect(Math.max(...onboardAt.values())).toBeLessThanOrEqual(1200);
  });

  it("ticks every 20 min (72) and snapshots every 2 h (13)", () => {
    expect(of("tick").map((e) => e.atMin)).toEqual(Array.from({ length: 72 }, (_, k) => 10 + 20 * k));
    expect(of("snapshot")).toHaveLength(13);
  });

  it("acts on a wallet only after it onboarded, and before the last tick", () => {
    for (const e of [...of("topup"), ...of("unregister")]) {
      expect(e.atMin).toBeGreaterThan(onboardAt.get(e.wallet)!);
      expect(e.atMin).toBeLessThanOrEqual(1430);
    }
  });

  it("gives each cohort its behaviour", () => {
    for (const e of of("onboard")) {
      if (cohort(e.wallet) === "whale") expect(e.fundUsdc).toBe(5000);
      if (cohort(e.wallet) === "dust") expect(e.fundUsdc).toBe(1);
    }
    for (const e of of("topup")) {
      expect(["drip", "whale", "churn"]).toContain(cohort(e.wallet));
      expect(e.via).toBe(cohort(e.wallet) === "drip" ? "transfer" : "faucet");
    }
    const unreg = new Map(of("unregister").map((e) => [e.wallet, e.atMin]));
    expect(unreg.size).toBe(10);
    expect([...unreg.keys()].every((i) => cohort(i) === "churn")).toBe(true);
    for (const e of of("topup").filter((t) => cohort(t.wallet) === "churn")) {
      expect(e.atMin).toBeGreaterThan(unreg.get(e.wallet)!);
    }
  });

  it("never asks the faucet for more than its 5000 USDC cap", () => {
    for (const e of plan.events) {
      if (e.kind === "onboard") expect(e.fundUsdc).toBeLessThanOrEqual(5000);
      if (e.kind === "topup") expect(e.usdc).toBeLessThanOrEqual(5000);
    }
  });

  it("is sorted by time, user actions before the tick of the same minute", () => {
    const order = { onboard: 0, topup: 1, unregister: 2, tick: 3, snapshot: 4 };
    for (let i = 1; i < plan.events.length; i++) {
      const a = plan.events[i - 1];
      const b = plan.events[i];
      expect(a.atMin < b.atMin || (a.atMin === b.atMin && order[a.kind] <= order[b.kind])).toBe(true);
    }
  });

  it("covers every cohort in a 5-wallet smoke plan", () => {
    expect(new Set(assignCohorts(5))).toEqual(new Set(Object.keys(COHORT_SIZES)));
  });
});
