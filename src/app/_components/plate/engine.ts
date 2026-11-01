// The plate's canvas: a dithered print of the range (rebuilt only when the scan
// or the viewport changes) plus a light living layer on top — spray lifting off
// the ridge, a column of light over the agent's route, the scan sweep, and
// "ink" rising through the range when the agent supplies. Imperative on
// purpose: it runs at 60fps and must not re-render React.

import type { Ridge } from "../../../lib/plate/layout";
import { fbm, seeded, clamp } from "../../../lib/plate/noise";

const CREAM: [number, number, number] = [243, 229, 204];
const FOG: [number, number, number] = [150, 140, 134];
const CREAM_CSS = "#f3e5cc";
const INK_CSS = "#1a1416";
/** Same scan, same print: the dither is seeded, not random per render. */
const SEED = 20260705;

export interface EngineScene {
  W: number;
  H: number;
  dpr: number;
  ridge: Ridge;
  /** The route summit's top, where the beam stands; null when nothing is eligible. */
  target: { x: number; y: number } | null;
  /** The caption hairline: nothing on the plate is drawn above it. */
  plateLine: number;
  /** Summit x positions, in the order the sweep should ping them. */
  pings: number[];
}

export interface EngineHooks {
  /** Sweep head position each frame (null when the sweep ends). */
  onSweep?: (x: number | null, yTop: number) => void;
  /** The sweep crossed summit `index` of `scene.pings`. */
  onPing?: (index: number) => void;
}

interface Speck { x: number; y: number; vx: number; vy: number; age: number; life: number; fog: number }
interface Ray { x: number; y: number; vy: number }
interface Ink { x0: number; y0: number; cx: number; cy: number; x1: number; y1: number; t: number; dur: number }
interface Twinkle { x: number; y: number; ph: number; sp: number }

const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;

export class PlateEngine {
  private ctx: CanvasRenderingContext2D;
  private off = document.createElement("canvas");
  private scene: EngineScene | null = null;
  private spray: Speck[] = [];
  private beam: Ray[] = [];
  private ink: Ink[] = [];
  private twinkle: Twinkle[] = [];
  private sweepState: { t0: number; dur: number; pinged: Set<number> } | null = null;
  private raf = 0;
  private last = 0;
  /** Offline: the print stays, everything alive stops. */
  frozen = false;
  /** prefers-reduced-motion: the print only. */
  reduced = false;

  constructor(private canvas: HTMLCanvasElement, private hooks: EngineHooks = {}) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d canvas unavailable");
    this.ctx = ctx;
  }

  setScene(scene: EngineScene) {
    this.scene = scene;
    const { W, H, dpr } = scene;
    this.canvas.width = Math.round(W * dpr);
    this.canvas.height = Math.round(H * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.imageSmoothingEnabled = false; // each dither cell stays a crisp square
    this.off.width = W;
    this.off.height = H;
    this.buildPrint();
    this.resetLiving();
    if (this.reduced) this.paint(performance.now(), 0);
  }

  /** The agent's gaze crossing the range. */
  sweep(dur = 3000) {
    if (!this.scene || this.reduced || this.frozen) return;
    this.sweepState = { t0: performance.now(), dur, pinged: new Set() };
  }

  /** Capital rising through the range into the route summit. */
  supply() {
    const s = this.scene;
    if (!s?.target || this.reduced || this.frozen) return;
    const { W, H } = s, t = s.target;
    for (let i = 0; i < 560; i++) {
      const x0 = t.x + gauss() * W * 0.13, y0 = H + 4 + Math.random() * 40;
      this.ink.push({
        x0, y0, cx: x0 * 0.55 + t.x * 0.45 + gauss() * 30, cy: H * (0.76 + Math.random() * 0.1),
        x1: t.x + gauss() * 2.5, y1: t.y + 3, t: -Math.random() * 0.9, dur: 2.4 + Math.random() * 1.6,
      });
    }
  }

  start() {
    if (this.raf) return;
    const loop = (now: number) => {
      const dt = Math.min(50, now - (this.last || now));
      this.last = now;
      this.paint(now, dt);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  // ── the print ────────────────────────────────────────────────────────────
  private buildPrint() {
    const s = this.scene!;
    const { W, H } = s, { ridge, hf, fog, minSummit } = s.ridge;
    const octx = this.off.getContext("2d")!;
    const img = octx.createImageData(W, H), d = img.data;
    const rnd = seeded(SEED);
    const put = (x: number, y: number, r: number, g: number, b: number, a: number) => {
      const i = ((y | 0) * W + (x | 0)) * 4;
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a;
    };
    const topY = Math.max(0, Math.floor(minSummit - 0.2 * H)), depth = 0.05 * H;
    for (let y = topY; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const t = y - ridge[x], n = fbm(x * 0.04, y * 0.006);
        let p: number;
        if (t >= 0) {
          // the body: streaky near the ridge, near-solid further down
          p = Math.min(0.975, (1 - Math.exp(-(t / depth) * (0.4 + 1.15 * n))) * (0.84 + 0.22 * n));
        } else {
          // spray above the ridge: taller summits throw more, in vertical tongues
          const spread = H * 0.016 * (0.4 + 2.5 * hf[x]) * (0.25 + 1.8 * n * n);
          p = 0.62 * Math.exp(t / spread);
        }
        const f = fog[x];
        if (f > 0) p *= 1 - 0.52 * f;
        if (rnd() < p) {
          const k = 0.84 + 0.16 * rnd();
          put(x, y,
            (CREAM[0] + (FOG[0] - CREAM[0]) * f) * k,
            (CREAM[1] + (FOG[1] - CREAM[1]) * f) * k,
            (CREAM[2] + (FOG[2] - CREAM[2]) * f) * k, 255);
        }
      }
    }
    // sky dust: the scattered specks that make the dark read as night
    const dust = Math.floor(W * H * 0.0015);
    for (let i = 0; i < dust; i++) {
      const x = (rnd() * W) | 0, y = (rnd() * H) | 0;
      if (y >= ridge[x] - 2 || y < s.plateLine) continue;
      put(x, y, CREAM[0], CREAM[1], CREAM[2], (40 + rnd() * 170) | 0);
    }
    // a thinner dust over the reading area keeps the sky continuous behind the text
    for (let i = 0; i < dust / 3; i++) {
      const x = (rnd() * W) | 0, y = (rnd() * s.plateLine) | 0;
      put(x, y, CREAM[0], CREAM[1], CREAM[2], (30 + rnd() * 110) | 0);
    }
    octx.putImageData(img, 0, 0);
  }

  // ── the living layer ─────────────────────────────────────────────────────
  private sprayPoint(p: Partial<Speck>, warm: boolean): Speck {
    const s = this.scene!, { hf, ridge, fog } = s.ridge;
    let x = 0;
    for (let k = 0; k < 8; k++) {
      x = (Math.random() * s.W) | 0;
      if (Math.random() < Math.pow(hf[x], 1.7) + 0.03) break;
    }
    const sp = p as Speck;
    sp.x = x + Math.random();
    sp.y = ridge[x] - Math.random() * 2;
    sp.vx = (Math.random() - 0.5) * 0.07;
    sp.vy = -(0.05 + Math.random() * 0.26) * (0.45 + hf[x]);
    sp.life = 220 + Math.random() * 460;
    sp.age = warm ? Math.random() * sp.life : 0;
    sp.fog = fog[x];
    if (warm) { sp.x += sp.vx * sp.age; sp.y += sp.vy * sp.age; }
    return sp;
  }

  private resetLiving() {
    const s = this.scene!;
    this.spray = Array.from({ length: Math.round(s.W * 0.75) }, () => this.sprayPoint({}, true));
    this.beam = [];
    this.ink = [];
    this.twinkle = Array.from({ length: 60 }, () => ({
      x: Math.random() * s.W,
      y: s.plateLine + Math.random() * Math.max(0, s.ridge.minSummit - s.plateLine - 30),
      ph: Math.random() * 6.28, sp: 0.4 + Math.random() * 1.2,
    }));
  }

  private paint(now: number, dt: number) {
    const s = this.scene;
    if (!s) return;
    const ctx = this.ctx, { W, H } = s, { ridge, minSummit } = s.ridge;
    const still = this.frozen || this.reduced;
    const f = still ? 0 : dt / 16.67;
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(this.off, 0, 0, W, H);
    if (this.reduced) return;

    // sweep: the dots it passes flare
    const sw = this.sweepState;
    if (sw && !this.frozen) {
      const k = (now - sw.t0) / sw.dur;
      if (k >= 1) {
        this.sweepState = null;
        this.hooks.onSweep?.(null, 0);
      } else {
        const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        const sx = -30 + (W + 60) * e;
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = 0.55; ctx.drawImage(this.off, sx - 3, 0, 6, H, sx - 3, 0, 6, H);
        ctx.globalAlpha = 0.16; ctx.drawImage(this.off, sx - 22, 0, 44, H, sx - 22, 0, 44, H);
        ctx.globalCompositeOperation = "source-over";
        const xi = clamp(Math.round(sx), 0, W - 1);
        const yTop = Math.max(minSummit - 0.1 * H, s.plateLine + 30);
        ctx.globalAlpha = 0.22; ctx.fillStyle = CREAM_CSS;
        ctx.fillRect(Math.round(sx), yTop, 1, ridge[xi] - yTop);
        this.hooks.onSweep?.(sx, yTop);
        s.pings.forEach((px, i) => {
          if (!sw.pinged.has(i) && sx >= px) { sw.pinged.add(i); this.hooks.onPing?.(i); }
        });
      }
    }

    ctx.fillStyle = CREAM_CSS;
    for (const p of this.spray) {
      p.age += f; p.x += p.vx * f; p.y += p.vy * f;
      if (p.age > p.life) this.sprayPoint(p, false);
      ctx.globalAlpha = Math.sin((Math.PI * p.age) / p.life) * (1 - 0.55 * p.fog) * 0.85;
      ctx.fillRect(p.x, p.y, 1, 1);
    }
    const ts = now / 1000;
    for (const t of this.twinkle) {
      ctx.globalAlpha = this.frozen ? 0.2 : 0.12 + 0.55 * Math.pow(Math.abs(Math.sin(ts * t.sp + t.ph)), 6);
      ctx.fillRect(t.x, t.y, 1, 1);
    }

    // the beam over the route: where the agent keeps the money. It stops at the
    // caption hairline — nothing from the plate crosses into the reading area.
    const tg = s.target;
    if (tg && !this.frozen) {
      for (let i = 0; i < 2; i++) if (this.beam.length < 260) this.beam.push({ x: tg.x + gauss() * 1.6, y: tg.y - 2, vy: -(0.3 + Math.random() * 0.9) });
      const reach = Math.max(10, Math.min(H * 0.17, tg.y - s.plateLine - 8));
      for (let i = this.beam.length - 1; i >= 0; i--) {
        const b = this.beam[i];
        b.y += b.vy * f; b.x += gauss() * 0.12 * f;
        const h = (tg.y - b.y) / reach;
        if (h > 1) { this.beam.splice(i, 1); continue; }
        ctx.globalAlpha = (1 - h) * 0.9;
        ctx.fillRect(b.x, b.y, 1, 1);
      }
    }

    // ink: dark inside the range, cream once it surfaces at the summit
    for (let i = this.ink.length - 1; i >= 0; i--) {
      const q = this.ink[i];
      q.t += this.frozen ? 0 : dt / 1000 / q.dur;
      if (q.t < 0) continue;
      if (q.t >= 1) {
        this.ink.splice(i, 1);
        if (tg && Math.random() < 0.7) this.beam.push({ x: tg.x + gauss() * 1.2, y: tg.y - 2, vy: -(0.9 + Math.random() * 1.4) });
        continue;
      }
      const e = q.t < 0.5 ? 2 * q.t * q.t : 1 - Math.pow(-2 * q.t + 2, 2) / 2, u = 1 - e;
      const x = u * u * q.x0 + 2 * u * e * q.cx + e * e * q.x1;
      const y = u * u * q.y0 + 2 * u * e * q.cy + e * e * q.y1;
      const inside = y > ridge[clamp(x | 0, 0, W - 1)] + 1.5, sz = inside ? 2.4 : 1.3;
      ctx.globalAlpha = 0.92;
      ctx.fillStyle = inside ? INK_CSS : CREAM_CSS;
      ctx.fillRect(x - sz / 2, y - sz / 2, sz, sz);
    }
    ctx.fillStyle = CREAM_CSS;
    ctx.globalAlpha = 1;
  }
}
