import { describe, it, expect } from "vitest";
import { layoutPeaks, computeRidge, type PlatePool } from "./layout";

const G = { W: 1440, H: 900, base: 840, top: 400 };
const p = (id: string, apyBps: number, riskScore: number, eligible = true, tvlUsdc = 500_000): PlatePool =>
  ({ id, apyBps, riskScore, tvlUsdc, eligible });

const pools: PlatePool[] = [
  p("xlm", 142, 25, true, 60_000),
  p("fixed", 842, 45, true, 1_920_000),
  p("orbit", 510, 29),
  p("ybx", 1160, 67, false, 4_100_000),
  p("dfx-ybx", 1112, 70, false, 90_000),
];

describe("layoutPeaks", () => {
  const { peaks, capX } = layoutPeaks(pools, G, 65);
  const byId = Object.fromEntries(peaks.map((k) => [k.id, k]));

  it("orders summits left to right by risk", () => {
    expect(peaks.map((k) => k.id)).toEqual(["xlm", "orbit", "fixed", "ybx", "dfx-ybx"]);
    for (let i = 1; i < peaks.length; i++) expect(peaks[i].x).toBeGreaterThan(peaks[i - 1].x);
  });

  it("keeps every summit inside the plate", () => {
    for (const k of peaks) {
      expect(k.x).toBeGreaterThan(0);
      expect(k.x).toBeLessThan(G.W);
      expect(k.summit).toBeGreaterThanOrEqual(G.top);
      expect(k.summit).toBeLessThan(G.base);
    }
  });

  it("makes a higher APY a higher summit", () => {
    expect(byId.ybx.summit).toBeLessThan(byId.fixed.summit);
    expect(byId.fixed.summit).toBeLessThan(byId.orbit.summit);
    expect(byId.orbit.summit).toBeLessThan(byId.xlm.summit);
  });

  it("makes a deeper pool a wider summit", () => {
    expect(byId.fixed.w).toBeGreaterThan(byId.xlm.w);
  });

  it("puts the risk cap between the last pool under it and the first over it", () => {
    expect(capX).not.toBeNull();
    expect(capX!).toBeGreaterThan(byId.fixed.x);
    expect(capX!).toBeLessThan(byId.ybx.x);
  });

  it("lets the highest APY in the scan reach the top of the plate", () => {
    const hot = layoutPeaks([p("a", 500, 30), p("b", 3000, 40)], G, 65).peaks;
    expect(hot[1].summit).toBeCloseTo(G.top, 5);
    expect(hot[0].summit).toBeGreaterThan(G.top + (G.base - G.top) * 0.6);
  });

  it("does not inflate a scan of near-zero yields into a tall range", () => {
    const flat = layoutPeaks([p("a", 20, 30), p("b", 40, 40)], G, 65).peaks;
    for (const k of flat) expect(k.summit).toBeGreaterThan(G.top + (G.base - G.top) * 0.75);
  });

  it("centres a single pool and draws no cap when nothing crosses it", () => {
    const one = layoutPeaks([p("solo", 600, 30)], G, 65);
    expect(one.peaks[0].x).toBeCloseTo(G.W / 2, 5);
    expect(one.capX).toBeNull();
  });

  it("returns an empty range for an empty scan", () => {
    expect(layoutPeaks([], G, 65)).toEqual({ peaks: [], capX: null });
  });
});

describe("computeRidge", () => {
  const { peaks } = layoutPeaks(pools, G, 65);
  const r = computeRidge(peaks, G);

  it("rises to each summit (within the crag noise)", () => {
    for (const k of peaks) {
      const x = Math.round(k.x);
      expect(Math.abs(r.ridge[x] - k.summit)).toBeLessThan(G.H * 0.03);
    }
  });

  it("falls away toward the edges", () => {
    expect(r.ridge[0]).toBeGreaterThan(G.base);
    expect(r.ridge[G.W - 1]).toBeGreaterThan(G.base);
  });

  it("fogs the columns owned by excluded pools, not the eligible ones", () => {
    const at = (id: string) => r.fog[Math.round(peaks.find((k) => k.id === id)!.x)];
    expect(at("ybx")).toBeGreaterThan(0.9);
    expect(at("fixed")).toBeLessThan(0.1);
    expect(at("xlm")).toBeLessThan(0.1);
  });

  it("is deterministic", () => {
    const again = computeRidge(peaks, G);
    expect(Array.from(again.ridge.slice(0, 50))).toEqual(Array.from(r.ridge.slice(0, 50)));
  });

  it("draws a low, bare ground for an empty scan", () => {
    const bare = computeRidge([], G);
    expect(bare.minSummit).toBeGreaterThan(G.top);
  });
});
