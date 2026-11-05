import { describe, it, expect, vi } from "vitest";
import { runTick, runPerUserExecution, type TickDeps, type PerUserDeps } from "./orchestrator";
import type { PoolYield, Position, UserRegistration } from "./types";

const pools: PoolYield[] = [
  { protocol: "blend", poolId: "C_A", name: "A", asset: "USDC", apyBps: 820, tvlUsdc: 100_000_0000000n, utilizationBps: 5000, oracleHealthy: true },
  { protocol: "blend", poolId: "C_B", name: "B", asset: "USDC", apyBps: 900, tvlUsdc: 100_000_0000000n, utilizationBps: 5000, oracleHealthy: true },
];

function deps(over: Partial<TickDeps> = {}): TickDeps {
  return {
    scan: vi.fn(async () => pools),
    tolerance: "balanced",
    getPosition: async () => ({ poolId: "C_A", amountUsdc: 1000_0000000n }),
    decide: vi.fn(async () => ({ action: "rebalance" as const, toPool: "C_B", amountUsdc: 1000_0000000n, rationale: "+0.8%" })),
    rebalance: vi.fn(async () => ({ hashes: ["h1", "h2"], success: true })),
    deposit: vi.fn(async () => ({ hashes: ["d"], success: true })),
    commitPosition: vi.fn(async () => {}),
    log: vi.fn(async () => {}),
    recordRebalance: vi.fn(async () => {}),
    rebalancedSince: async () => 0n,
    minYieldDeltaBps: 50, perTxCapStroops: 2000_0000000n, dailyCapStroops: 5000_0000000n,
    cooldownSec: 120, lastRebalanceAt: 0, now: 100000,
    ...over,
  };
}

describe("runTick dry run (the silent snapshot refresh)", () => {
  it("scans, gates and decides, but executes, commits, records and logs nothing", async () => {
    const gate = vi.fn((s) => s);
    const d = deps({ dryRun: true, gate });
    const r = await runTick(d);
    expect(d.scan).toHaveBeenCalled();
    expect(gate).toHaveBeenCalled();
    expect(d.decide).toHaveBeenCalled();
    expect(d.rebalance).not.toHaveBeenCalled();
    expect(d.deposit).not.toHaveBeenCalled();
    expect(d.commitPosition).not.toHaveBeenCalled();
    expect(d.recordRebalance).not.toHaveBeenCalled();
    expect(d.log).not.toHaveBeenCalled();
    expect(r).toEqual({ acted: false, reason: "dry-run" });
  });

  it("stays silent on a hold too", async () => {
    const d = deps({ dryRun: true, decide: vi.fn(async () => ({ action: "hold" as const, rationale: "nothing better" })) });
    expect(await runTick(d)).toEqual({ acted: false, reason: "dry-run" });
    expect(d.log).not.toHaveBeenCalled();
  });
});

describe("runTick guards", () => {
  it("executes rebalance when delta and caps pass", async () => {
    const d = deps();
    const r = await runTick(d);
    expect(d.rebalance).toHaveBeenCalledWith("C_A", "C_B", 1000_0000000n);
    expect(d.commitPosition).toHaveBeenCalledWith({ poolId: "C_B", amountUsdc: 1000_0000000n });
    expect(r.acted).toBe(true);
  });

  it("skips when yield delta below threshold", async () => {
    const d = deps({ decide: vi.fn(async () => ({ action: "rebalance" as const, toPool: "C_B", amountUsdc: 1000_0000000n, rationale: "tiny" })) });
    d.minYieldDeltaBps = 100;
    const r = await runTick(d);
    expect(d.rebalance).not.toHaveBeenCalled();
    expect(r.acted).toBe(false);
  });

  it("leaves a held pool that the gate made ineligible even when the new one pays less", async () => {
    const d = deps({
      decide: vi.fn(async () => ({ action: "rebalance" as const, toPool: "C_A", amountUsdc: 1000_0000000n, rationale: "A is the best eligible" })),
      getPosition: async () => ({ poolId: "C_B", amountUsdc: 1000_0000000n }),
      gate: (scored) => scored.map((p) => (p.poolId === "C_B" ? { ...p, eligible: false, reason: "Vigil C 57 < 60, the RiskGate minimum" } : p)),
    });
    const r = await runTick(d);
    expect(d.rebalance).toHaveBeenCalledWith("C_B", "C_A", 1000_0000000n);
    expect(r.acted).toBe(true);
    expect((d.log as ReturnType<typeof vi.fn>).mock.calls.some(([k, m]) => k === "rebalance" && /\(-80bps\): left B: Vigil C 57 < 60/.test(m))).toBe(true);
  });

  it("the gate decides eligibility: a gated-out target is not executed", async () => {
    const d = deps({ gate: (scored) => scored.map((p) => (p.poolId === "C_B" ? { ...p, eligible: false, reason: "Vigil NR" } : p)) });
    const r = await runTick(d);
    expect(d.rebalance).not.toHaveBeenCalled();
    expect(r.reason).toBe("ineligible-target");
  });

  it("skips during cooldown", async () => {
    const r = await runTick(deps({ lastRebalanceAt: 99950, now: 100000, cooldownSec: 120 }));
    expect(r.acted).toBe(false);
  });

  it("clamps amount to per-tx cap", async () => {
    const d = deps({ getPosition: async () => ({ poolId: "C_A", amountUsdc: 10_000_0000000n }),
      decide: vi.fn(async () => ({ action: "rebalance" as const, toPool: "C_B", amountUsdc: 10_000_0000000n, rationale: "big" })) });
    await runTick(d);
    expect(d.rebalance).toHaveBeenCalledWith("C_A", "C_B", 2000_0000000n);
  });

  it("deposits idle USDC into the best eligible pool (no rebalance)", async () => {
    const d = deps({
      getPosition: async () => ({ poolId: null, amountUsdc: 1000_0000000n }),
      decide: vi.fn(async () => ({ action: "rebalance" as const, toPool: "C_B", amountUsdc: 1000_0000000n, rationale: "deploy idle" })),
      deposit: vi.fn(async () => ({ hashes: ["d1"], success: true })),
    });
    const r = await runTick(d);
    expect(d.deposit).toHaveBeenCalledWith("C_B", 1000_0000000n);
    expect(d.rebalance).not.toHaveBeenCalled();
    expect(d.commitPosition).toHaveBeenCalledWith({ poolId: "C_B", amountUsdc: 1000_0000000n });
    expect(r.acted).toBe(true);
    expect(r.reason).toBe("deposited");
  });
});

// ── Per-user execution (ARMA model) ──────────────────────────────────────────

function user(owner: string, smartWallet: string): UserRegistration {
  return { owner, smartWallet, poolRuleId: 1, usdcRuleId: 2, createdAt: 0 };
}

function perUserDeps(over: Partial<PerUserDeps> = {}): PerUserDeps {
  const positions = new Map<string, Position>();
  return {
    users: [user("G_A", "C_SA_A"), user("G_B", "C_SA_B")],
    execPoolId: "C_EXEC",
    supplyForUser: vi.fn(async () => ({ hashes: ["hx"], success: true })),
    getUserPosition: async (sw) => positions.get(sw) ?? { poolId: null, amountUsdc: 0n },
    setUserPosition: vi.fn(async (sw, p) => {
      positions.set(sw, p);
    }),
    idleUsdcForUser: vi.fn(async () => 500_0000000n),
    log: vi.fn(async () => {}),
    perTxCapStroops: 2000_0000000n,
    ...over,
  };
}

describe("runPerUserExecution (ARMA per-user)", () => {
  it("no-ops (no supply attempted) when there are no registered users", async () => {
    const d = perUserDeps({ users: [] });
    const r = await runPerUserExecution(d, "C_BEST");
    expect(r).toEqual({ attempted: 0, supplied: 0, hashes: [], totalStroops: 0n });
    expect(d.supplyForUser).not.toHaveBeenCalled();
  });

  it("supplies each user's idle USDC into the exec pool and records position", async () => {
    const d = perUserDeps();
    const r = await runPerUserExecution(d, "C_BEST");
    expect(r.attempted).toBe(2);
    expect(r.supplied).toBe(2);
    expect(d.supplyForUser).toHaveBeenCalledTimes(2);
    // Each user supplies min(idle=500, cap=2000) = 500 USDC.
    expect(d.supplyForUser).toHaveBeenCalledWith(expect.objectContaining({ owner: "G_A" }), 500_0000000n);
    expect(d.setUserPosition).toHaveBeenCalledWith("C_SA_A", { poolId: "C_EXEC", amountUsdc: 500_0000000n });
  });

  it("caps the supplied amount at perTxCapStroops", async () => {
    const d = perUserDeps({
      users: [user("G_A", "C_SA_A")],
      idleUsdcForUser: vi.fn(async () => 10_000_0000000n), // 10k idle
      perTxCapStroops: 2000_0000000n,
    });
    await runPerUserExecution(d, null);
    expect(d.supplyForUser).toHaveBeenCalledWith(expect.anything(), 2000_0000000n);
  });

  it("skips users with no idle USDC (no supply attempted)", async () => {
    const supplyForUser = vi.fn(async () => ({ hashes: ["hx"], success: true }));
    const d = perUserDeps({
      users: [user("G_A", "C_SA_A"), user("G_B", "C_SA_B")],
      idleUsdcForUser: vi.fn(async (u) => (u.owner === "G_A" ? 0n : 300_0000000n)),
      supplyForUser,
    });
    const r = await runPerUserExecution(d, "C_BEST");
    expect(r.attempted).toBe(1);
    expect(r.supplied).toBe(1);
    expect(supplyForUser).toHaveBeenCalledTimes(1);
    expect(supplyForUser).toHaveBeenCalledWith(expect.objectContaining({ owner: "G_B" }), 300_0000000n);
  });

  it("one user's failure does not abort the others", async () => {
    const supplyForUser = vi.fn(async (u: UserRegistration) =>
      u.owner === "G_A"
        ? { hashes: [] as string[], success: false, error: "policy reject" }
        : { hashes: ["ok"], success: true },
    );
    const d = perUserDeps({ supplyForUser });
    const r = await runPerUserExecution(d, "C_BEST");
    expect(r.attempted).toBe(2);
    expect(r.supplied).toBe(1); // only G_B landed
    expect(r.hashes).toEqual(["ok"]);
    // The failing user's position is NOT committed.
    expect(d.setUserPosition).toHaveBeenCalledTimes(1);
    expect(d.setUserPosition).toHaveBeenCalledWith("C_SA_B", expect.anything());
  });

  it("accumulates onto an existing exec-pool position", async () => {
    const positions = new Map<string, Position>([["C_SA_A", { poolId: "C_EXEC", amountUsdc: 100_0000000n }]]);
    const d = perUserDeps({
      users: [user("G_A", "C_SA_A")],
      getUserPosition: async (sw) => positions.get(sw) ?? { poolId: null, amountUsdc: 0n },
      idleUsdcForUser: vi.fn(async () => 50_0000000n),
    });
    await runPerUserExecution(d, "C_BEST");
    expect(d.setUserPosition).toHaveBeenCalledWith("C_SA_A", { poolId: "C_EXEC", amountUsdc: 150_0000000n });
  });
});
