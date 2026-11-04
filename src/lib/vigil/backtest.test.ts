import { describe, expect, it } from "vitest";
import { RECONSTRUCTED_USTRY_ASKS, YIELDBLOX_POOL, runYieldBloxBacktest, yieldBloxReconstruction } from "./backtest";
import { HARD_CAPS, ratePool } from "./score";

describe("YieldBlox backtest (RECONSTRUCTION of 2026-02-22T00:00Z)", () => {
  const bt = runYieldBloxBacktest();

  it("is labelled as a reconstruction", () => {
    const s = yieldBloxReconstruction();
    expect(s.poolId).toBe(YIELDBLOX_POOL);
    expect(s.provenance).toMatch(/RECONSTRUCTION/);
    expect(s.dataGaps.join(" ")).toMatch(/RECONSTRUCTION/);
  });

  it("would have rated the pool E / not eligible, driven by USTRY SDEX manipulation", () => {
    expect(bt.rating.grade).toBe("E");
    expect(bt.rating.eligibleForDeposit).toBe(false);
    expect(bt.rating.status).toBe(1); // it was Active, so status alone would not have blocked it
    expect(bt.rating.hardRules).toEqual(["HR3 SDEX-manipulable collateral (USTRY) ⇒ not eligible, grade E"]);
    expect(bt.ustry.profitable).toBe(true);
    expect(bt.ustry.rho!).toBeLessThan(0.05);
    expect(bt.ustry.roundsToHold).toBe(2); // max_dev=10 only forces a 2-round hold
  });

  it("modelled extractable value is consistent with what the attacker actually took", () => {
    expect(bt.ustry.extractableUsd).toBeGreaterThan(bt.actualExtractedUsd);
    expect(bt.ustry.extractableUsd).toBeLessThan(bt.actualExtractedUsd * 1.5);
  });

  it("the SDEX rule is what makes it E: without it the pool scores D, under the deposit line", () => {
    // v2.2 scores utilization on the most-borrowed reserve (USDC was 80% borrowed),
    // which alone took it to 49; v2.1's pool-wide average gave 56 (C). v2.6
    // doubles the liquidity weight and its USDC was thin in dollars too: 43.
    expect(bt.rating.uncappedScore!).toBeGreaterThan(HARD_CAPS.sdexManipulable);
    expect(bt.rating.uncappedScore!).toBe(43);
  });

  it("rho rises monotonically with ask depth; the flag clears only at ~$26M of asks", () => {
    const rhos = bt.sensitivity.map((x) => x.rho as number);
    for (let i = 1; i < rhos.length; i++) expect(rhos[i]).toBeGreaterThanOrEqual(rhos[i - 1]);
    expect(bt.sensitivity[0].profitable).toBe(true);
    expect(bt.sensitivity.at(-1)!.profitable).toBe(false);
  });

  it("re-pricing USTRY from a CEX feed removes the flag (the rule keys on price source, not the asset)", () => {
    const s = yieldBloxReconstruction({ ustryAsks: RECONSTRUCTED_USTRY_ASKS });
    const u = s.reserves.find((r) => r.symbol === "USTRY")!;
    u.source = { ...u.source, kind: "reflector_cex" };
    expect(ratePool(s).hardRules.some((h) => h.startsWith("HR3"))).toBe(false);
  });
});
