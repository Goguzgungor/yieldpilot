import { describe, expect, it } from "vitest";
import { mergeDepthHistory, historyFor, samplesOf, toSample } from "./depthHistory";
import { ENGINE_VERSION, HARD_CAPS, ratePool, softCeiling, THRESHOLDS } from "./score";
import { backstop, cid, depth, healthyPool, reserve, src, T0 } from "./testkit";
import type { PoolSnapshot } from "./types";
import { pathsToGrades } from "./whatif";

// v2.3 (after the 2026-11-02 blind reviews): a pool lent against with no
// first-loss capital is at most C, a pool one update_status call from Frozen
// is not eligible, and SDEX manipulation is rated on the thinnest book of the
// last 24 h instead of a single read.
const empty = backstop({ usdc: 0, blnd: 0, meetsThreshold: false });

describe("v2.3 scoring", () => {
  it("is versioned", () => {
    expect(ENGINE_VERSION).toMatch(/^vigil-risk-v2\.[3456]\./);
  });
});

describe("v2.3 HR9: no first-loss capital", () => {
  it("a pool with material borrows and an empty backstop is capped (at most B since v2.6, C before), still eligible, with HR7 folded into HR9", () => {
    const r = ratePool(healthyPool({ poolId: cid("fixed-v2-like"), status: 3, backstop: empty }));
    expect(r.grade).toBe("B");
    expect(r.score).toBeLessThanOrEqual(HARD_CAPS.noFirstLossCapital);
    expect(r.score).toBe(Math.round(softCeiling(r.uncappedScore!)));
    expect(r.hardRules.find((h) => h.startsWith("HR9"))).toMatch(/covers 0\.0% of .* borrowed, under 1\.0%/);
    expect(r.hardRules.some((h) => h.startsWith("HR7"))).toBe(false);
    expect(r.eligibleForDeposit).toBe(true);
  });

  it("the C ceiling is soft: two uninsured pools keep their order", () => {
    const a = ratePool(healthyPool({ poolId: cid("u1"), backstop: empty }));
    const b = ratePool(
      healthyPool({
        poolId: cid("u2"),
        backstop: empty,
        reserves: [
          reserve("USDC", { source: src("base"), supplied: 2_000_000, borrowed: 1_850_000, cFactor: 0.95, lFactor: 0.95 }),
          reserve("XLM", { priceUsd: 0.2, supplied: 10_000_000, borrowed: 6_000_000, cFactor: 0.75, lFactor: 0.75, maxUtil: 0.7 }),
        ],
      }),
    );
    expect(a.uncappedScore!).toBeGreaterThan(b.uncappedScore!);
    expect(a.score!).toBeGreaterThan(b.score!);
    for (const u of [50, 64, 75, 100]) expect(softCeiling(u, 64, 50)).toBeLessThanOrEqual(64);
    expect(softCeiling(49, 64, 50)).toBe(49);
  });

  it("a backstop under Blend's threshold that still covers ≥1% of the borrows stays HR7 (at most B)", () => {
    const r = ratePool(healthyPool({ poolId: cid("small-backstop"), backstop: backstop({ usdc: 50_000, blnd: 100_000, meetsThreshold: false }) }));
    expect(r.grade).toBe("B");
    expect(r.hardRules.some((h) => h.startsWith("HR7"))).toBe(true);
    expect(r.hardRules.some((h) => h.startsWith("HR9"))).toBe(false);
  });

  it("the queue counts: a funded backstop that is 99.9% queued to leave covers almost nothing", () => {
    const r = ratePool(healthyPool({ poolId: cid("leaving"), status: 3, backstop: backstop({ q4wPct: 0.999 }) }));
    expect(r.hardRules.some((h) => h.startsWith("HR9"))).toBe(true);
  });

  it("no material borrows ⇒ no HR9", () => {
    const r = ratePool(
      healthyPool({
        poolId: cid("idle"),
        backstop: empty,
        reserves: [reserve("USDC", { source: src("base"), supplied: 2_000_000, borrowed: 500 })],
      }),
    );
    expect(r.hardRules.some((h) => h.startsWith("HR9"))).toBe(false);
  });

  it("the path out of the HR9 ceiling is the backstop", () => {
    const p = pathsToGrades(healthyPool({ poolId: cid("fixed-path"), status: 3, backstop: empty }));
    expect(p.A).toMatchObject({ reachable: true, levers: ["backstop"] });
    expect(p.A.steps[0]).toMatch(/Refill the backstop/);
  });

  it("an NR pool does not list HR9", () => {
    const r = ratePool(healthyPool({ poolId: cid("nr"), status: 6, backstop: empty }));
    expect(r.grade).toBe("NR");
    expect(r.hardRules.some((h) => h.startsWith("HR9"))).toBe(false);
  });
});

describe("v2.3 HR8: one update_status call from Frozen", () => {
  const q = (status: number, q4wPct: number) => ratePool(healthyPool({ poolId: cid(`q${status}-${q4wPct}`), status, backstop: backstop({ q4wPct }) }));
  const hr8 = (r: ReturnType<typeof q>) => r.hardRules.find((h) => h.startsWith("HR8"));

  it("an On_Ice pool with 97.8% queued (YieldBlox today) is not eligible; its grade is untouched", () => {
    const r = q(3, 0.978);
    expect(r.eligibleForDeposit).toBe(false);
    expect(hr8(r)).toMatch(/97\.8% of the backstop is queued .* past the 60\.0% at which Blend's update_status freezes an On_Ice pool/);
    // Status is not graded: the same pool as Admin_Active (no freeze trigger) scores the same.
    const adminActive = ratePool(healthyPool({ poolId: cid("q3-0.978"), status: 0, backstop: backstop({ q4wPct: 0.978 }) }));
    expect(hr8(adminActive)).toBeUndefined();
    expect(r.score).toBe(adminActive.score);
  });

  it("follows Blend's status.rs: 60% for Active / On_Ice, 75% for Admin_On_Ice, never for Admin_Active", () => {
    expect(hr8(q(1, 0.6))).toBeDefined();
    expect(hr8(q(1, 0.59))).toBeUndefined();
    expect(hr8(q(3, 0.6))).toBeDefined();
    expect(hr8(q(2, 0.74))).toBeUndefined();
    expect(hr8(q(2, 0.75))).toMatch(/75\.0%/);
    expect(hr8(q(0, 0.95))).toBeUndefined();
    expect(THRESHOLDS.backstopQueueFrozen).toBe(0.6);
  });
});

describe("v2.3 rolling-window SDEX depth", () => {
  // healthyPool + an SDEX-priced collateral (USTRY) that is deep now.
  const withUstry = (o: Partial<PoolSnapshot> = {}): PoolSnapshot => {
    const s = healthyPool({ poolId: cid("window"), ...o });
    const u = reserve("USTRY", { supplied: 2_000, borrowed: 0, priceUsd: 1.06, supplyCap: 250_000, source: src("reflector_dex", { maxDevPct: 10 }) });
    s.reserves.push(u);
    s.dexDepth = { [u.assetId]: depth(u.assetId, [[1.07, 100_000_000]]) };
    return s;
  };
  const ustryId = withUstry().reserves[3].assetId;
  const thinThen = (hoursAgo: number, refPriceUsd = 1.06) => toSample(depth(ustryId, [[refPriceUsd, 4.9]]), T0 - hoursAgo * 3600, refPriceUsd);

  it("with no history the current book decides (v2.2 behaviour)", () => {
    const r = ratePool(withUstry());
    expect(r.factors.find((f) => f.key === "sdex_manipulation")!.value).toBeGreaterThan(75);
    expect(r.hardRules.some((h) => h.startsWith("HR3"))).toBe(false);
  });

  it("a thin book 3 h ago sets the factor even though the book is deep now: HR3, grade E", () => {
    const r = ratePool(withUstry({ dexDepthHistory: { [ustryId]: [thinThen(3)] } }));
    expect(r.factors.find((f) => f.key === "sdex_manipulation")!.value).toBe(0);
    expect(r.hardRules.some((h) => h.startsWith("HR3") && h.includes("USTRY"))).toBe(true);
    expect(r.grade).toBe("E");
    const note = r.factors.find((f) => f.key === "sdex_manipulation")!.note;
    expect(note).toMatch(/thinnest of 2 books in 24 h, read \d\d:\d\d UTC/);
  });

  it("a book older than 24 h no longer counts", () => {
    const r = ratePool(withUstry({ dexDepthHistory: { [ustryId]: [thinThen(25)] } }));
    expect(r.hardRules.some((h) => h.startsWith("HR3"))).toBe(false);
  });

  it("a past book is rescaled to today's price: same USD depth, same distance from the price", () => {
    // Read when USTRY was $0.53 (half today's): the same thin book, at half the prices.
    const half = toSample(depth(ustryId, [[0.53, 9.8]]), T0 - 3600, 0.53);
    const r = ratePool(withUstry({ dexDepthHistory: { [ustryId]: [half] } }));
    expect(r.hardRules.some((h) => h.startsWith("HR3"))).toBe(true);
  });

  it("the history is part of the inputs hash", () => {
    const a = ratePool(withUstry());
    const b = ratePool(withUstry({ dexDepthHistory: { [ustryId]: [toSample(depth(ustryId, [[1.07, 100_000_000]]), T0 - 3600, 1.06)] } }));
    expect(a.score).toBe(b.score);
    expect(a.reasonsHash).not.toBe(b.reasonsHash);
  });
});

describe("depth history store helpers", () => {
  const a = cid("asset-a");
  it("toSample keeps the levels the model can reach plus the first one past them", () => {
    const s = toSample(depth(a, [[1, 1], [50, 1], [100, 1], [150, 1], [200, 1]]), T0, 1);
    expect(s.asks.map((x) => x.price)).toEqual([1, 50, 100, 150]);
    expect(s).toMatchObject({ sampledAt: T0, refPriceUsd: 1 });
  });

  it("merge drops what left the window and stores at most one book per asset per 50 min", () => {
    const old = toSample(depth(a, [[1, 1]]), T0 - 90_000, 1);
    const recent = toSample(depth(a, [[1, 2]]), T0 - 1_200, 1);
    const fresh = toSample(depth(a, [[1, 3]]), T0, 1);
    expect(mergeDepthHistory({ [a]: [old, recent] }, [fresh], T0)[a]).toEqual([recent]);
    const later = toSample(depth(a, [[1, 4]]), T0 + 1_800, 1);
    expect(mergeDepthHistory({ [a]: [recent] }, [later], T0 + 1_800)[a]).toEqual([recent, later]);
  });

  it("samplesOf prices each book with the pool's oracle; historyFor picks the pool's assets", () => {
    const s = healthyPool({ poolId: cid("h") });
    const x = s.reserves[1];
    s.dexDepth = { [x.assetId]: depth(x.assetId, [[0.2, 10]]) };
    const [sample] = samplesOf(s);
    expect(sample).toMatchObject({ assetId: x.assetId, refPriceUsd: 0.2, sampledAt: T0 });
    expect(historyFor(s, { [x.assetId]: [sample], [a]: [sample] })).toEqual({ [x.assetId]: [sample] });
    expect(historyFor(s, {})).toBeUndefined();
  });
});
