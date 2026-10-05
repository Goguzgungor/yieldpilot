// Where each pool stands on the plate. Pure geometry, client-safe:
//   x      — left to right by risk (rank-spaced, nudged by the actual score, so
//            similar risks stay legible instead of piling onto one spot)
//   summit — height by APY
//   w      — width by depth (TVL, log scale)
// plus the dithered ridge line those summits produce.

import { clamp, fbm, hash, vnoise } from "./noise";

export interface PlatePool {
  id: string;
  apyBps: number;
  riskScore: number;
  /** Whole USDC (not stroops). */
  tvlUsdc: number;
  eligible: boolean;
}

export interface Peak extends PlatePool {
  x: number;
  summit: number;
  w: number;
  /** Shoulder height (fraction of the summit's rise) and width (× w). */
  sh: number;
  sw: number;
}

/** Plate frame in CSS px: summits live between `top` (highest) and `base`. */
export interface PlateGeometry { W: number; H: number; base: number; top: number; }

/**
 * Heights are relative to the scan: the highest APY reaches the top of the
 * plate (the labels carry the exact numbers). The floor keeps a scan of
 * near-zero yields from being blown up into a dramatic range.
 */
const MIN_CEIL_BPS = 600;

export function layoutPeaks(pools: PlatePool[], g: PlateGeometry, riskCap: number): { peaks: Peak[]; capX: number | null } {
  if (!pools.length) return { peaks: [], capX: null };
  const sorted = [...pools].sort((a, b) => a.riskScore - b.riskScore || a.apyBps - b.apyBps || a.id.localeCompare(b.id));
  const n = sorted.length, x0 = g.W * 0.1, x1 = g.W * 0.9;
  const rMin = sorted[0].riskScore, span = Math.max(1, sorted[n - 1].riskScore - rMin);
  const ceil = Math.max(MIN_CEIL_BPS, ...sorted.map((p) => p.apyBps));

  const peaks = sorted.map((p, i): Peak => {
    const rankT = n > 1 ? i / (n - 1) : 0.5;
    const riskT = n > 1 ? (p.riskScore - rMin) / span : 0.5;
    const x = x0 + (x1 - x0) * (rankT * 0.8 + riskT * 0.2);
    // a floor of 14% keeps a near-zero APY visible as a hill rather than nothing
    const summit = g.base - (g.base - g.top) * (0.14 + 0.86 * Math.max(0, p.apyBps) / ceil);
    const depth = clamp(Math.log10(Math.max(1, p.tvlUsdc / 4e4)), 0, 2.2); // 40k … ~6M
    return { ...p, x, summit, w: g.W * (0.018 + 0.016 * depth), sh: 0.16 + 0.14 * depth + 0.06 * hash(i, 9), sw: 1.7 + 0.9 * depth };
  });

  const firstOver = peaks.findIndex((k) => k.riskScore > riskCap);
  const capX =
    firstOver < 0 ? null
    : firstOver === 0 ? Math.max(g.W * 0.04, peaks[0].x - g.W * 0.05)
    : (peaks[firstOver - 1].x + peaks[firstOver].x) / 2;
  return { peaks, capX };
}

export interface Ridge {
  /** Ridge line y per CSS-px column. */
  ridge: Float32Array;
  /** Local height 0..1 (drives how much spray a column throws). */
  hf: Float32Array;
  /** 0..1: how much a column belongs to an excluded pool (drawn as fog). */
  fog: Float32Array;
  minSummit: number;
}

export function computeRidge(peaks: Peak[], g: PlateGeometry): Ridge {
  const { W, H, base } = g;
  const ridge = new Float32Array(W), hf = new Float32Array(W), owned = new Float32Array(W);
  const minS = peaks.length ? Math.min(...peaks.map((p) => p.summit)) : base - H * 0.1;

  for (let x = 0; x < W; x++) {
    // the ground falls away toward both edges: one massif, night in the lower corners
    const bx = base + H * 0.3 * Math.pow(Math.abs(x / W - 0.5) * 2, 3.2);
    let y = bx + (fbm(x * 0.0032, 3.1) - 0.5) * 0.06 * H;
    let owner = -1, ownerY = Infinity;
    peaks.forEach((p, i) => {
      const u = Math.abs(x - p.x) / p.w;
      const spire = p.summit + (bx - p.summit) * (1 - Math.exp(-u * 1.3));
      const shoulder = bx - (bx - p.summit) * p.sh * Math.exp(-Math.pow(Math.abs(x - p.x) / (p.w * p.sw), 1.6));
      const mine = Math.min(spire, shoulder);
      if (mine < ownerY) { ownerY = mine; owner = i; }
      if (mine < y) y = mine;
    });
    const h = clamp((base - y) / (base - minS), 0, 1);
    y += (fbm(x * 0.052, 7.7) - 0.5) * 0.026 * H * (0.2 + h) + (vnoise(x * 0.31, 1.3) - 0.5) * 0.005 * H;
    ridge[x] = y;
    hf[x] = clamp((base - y) / (base - minS), 0, 1);
    owned[x] = owner >= 0 && !peaks[owner].eligible ? 1 : 0;
  }

  // soften the fog edge so an excluded summit dissolves into its neighbours
  const fog = new Float32Array(W), R = 14;
  let acc = 0;
  for (let x = -R; x < W; x++) {
    if (x + R < W) acc += owned[x + R];
    if (x - R - 1 >= 0) acc -= owned[x - R - 1];
    if (x >= 0) fog[x] = acc / (Math.min(W - 1, x + R) - Math.max(0, x - R) + 1);
  }

  let minSummit = Infinity;
  for (let x = 0; x < W; x++) if (ridge[x] < minSummit) minSummit = ridge[x];
  return { ridge, hf, fog, minSummit };
}

/** The true top of a summit after crag noise: the highest ridge point near its centre. */
export function topOf(r: Ridge, x: number, w: number): { x: number; y: number } {
  const W = r.ridge.length;
  let bx = clamp(Math.round(x), 0, W - 1);
  for (let i = Math.max(0, Math.round(x - w * 0.35)); i < Math.min(W, Math.round(x + w * 0.35)); i++) if (r.ridge[i] < r.ridge[bx]) bx = i;
  return { x: bx, y: r.ridge[bx] };
}
