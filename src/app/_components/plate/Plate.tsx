"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { ApiScoredPool } from "../types";
import { layoutPeaks, computeRidge, topOf } from "../../../lib/plate/layout";
import { declutter } from "../../../lib/plate/declutter";
import { PlateEngine } from "./engine";
import { formatApy, formatPct, stroopsToUsdc } from "../format";
import { poolTitle, protocolLabel, shortLabel, tvlCompact } from "../poolNames";

export type PlatePhase = "live" | "cold" | "offline";

interface Props {
  pools: ApiScoredPool[];
  riskCap: number;
  /** The route: the best eligible pool. */
  chosenId: string | null;
  selectedId: string | null;
  /** The connected user has USDC supplied on the route. */
  holding: boolean;
  phase: PlatePhase;
  /** y of the caption hairline: the plate's top edge. */
  plateLine: number;
  /** Increments when a real scan lands → a labelled sweep. */
  scanKey: number;
  /** Increments when a supply lands → ink rises into the route. */
  supplyKey: number;
  onSelect: (poolId: string) => void;
  onBackground: () => void;
}

interface Size { W: number; H: number; dpr: number }
interface Measured { leads: number[]; heights: number[] }

/** Only what changes the drawing — the 15s poll returns a new array every time. */
const poolsKey = (pools: ApiScoredPool[]) =>
  pools.map((p) => `${p.poolId}:${p.apyBps}:${p.riskScore}:${p.tvlUsdc}:${p.eligible ? 1 : 0}`).join("|");

export default function Plate(props: Props) {
  const { pools, riskCap, chosenId, selectedId, holding, phase, plateLine, scanKey, supplyKey, onSelect, onBackground } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<PlateEngine | null>(null);
  const sweepRef = useRef<HTMLDivElement>(null);
  const sweepLabelled = useRef(false);
  const labelRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [size, setSize] = useState<Size | null>(null);
  const [measured, setMeasured] = useState<Measured>({ leads: [], heights: [] });
  const [tip, setTip] = useState<{ pool: ApiScoredPool; x: number; y: number } | null>(null);

  useEffect(() => {
    const measure = () => setSize({ W: window.innerWidth, H: window.innerHeight, dpr: Math.min(2, window.devicePixelRatio || 1) });
    measure();
    let t: ReturnType<typeof setTimeout>;
    const onResize = () => { clearTimeout(t); t = setTimeout(measure, 160); };
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); clearTimeout(t); };
  }, []);

  const key = poolsKey(pools);
  const byId = useMemo(() => Object.fromEntries(pools.map((p) => [p.poolId, p])), [key]);

  const geo = useMemo(() => {
    if (!size || !plateLine) return null;
    const { W, H } = size;
    const g = { W, H, base: H * 0.935, top: Math.max(H * 0.5, plateLine + 74) };
    const shown = phase === "cold" ? [] : pools;
    const { peaks, capX } = layoutPeaks(
      shown.map((p) => ({ id: p.poolId, apyBps: p.apyBps, riskScore: p.riskScore, tvlUsdc: stroopsToUsdc(p.tvlUsdc), eligible: p.eligible })),
      g,
      riskCap,
    );
    const ridge = computeRidge(peaks, g);
    const tops = peaks.map((k) => topOf(ridge, k.x, k.w));
    return { ...g, peaks, capX, ridge, tops };
  }, [size?.W, size?.H, plateLine, key, riskCap, phase]);

  // ── engine lifecycle ─────────────────────────────────────────────────────
  useEffect(() => {
    const engine = new PlateEngine(canvasRef.current!, {
      onSweep: (x, yTop) => {
        const el = sweepRef.current;
        if (!el) return;
        if (x == null || !sweepLabelled.current) { el.classList.remove("on"); return; }
        el.style.left = `${x}px`;
        el.style.top = `${yTop}px`;
        el.classList.add("on");
      },
      onPing: (i) => {
        const el = labelRefs.current[i];
        if (!el) return;
        el.classList.add("ping");
        setTimeout(() => el.classList.remove("ping"), 900);
      },
    });
    engine.reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    engineRef.current = engine;
    engine.start();
    return () => engine.stop();
  }, []);

  const chosenIdx = geo ? geo.peaks.findIndex((k) => k.id === chosenId) : -1;
  const introDone = useRef(false);
  useEffect(() => {
    if (!geo || !size) return;
    engineRef.current?.setScene({
      W: geo.W, H: geo.H, dpr: size.dpr, ridge: geo.ridge, plateLine,
      target: chosenIdx >= 0 ? geo.tops[chosenIdx] : null,
      pings: geo.tops.map((t) => t.x),
    });
    // first read of the plate: a quiet, unlabelled pass of the sweep
    if (!introDone.current && geo.peaks.length) {
      introDone.current = true;
      sweepLabelled.current = false;
      engineRef.current?.sweep(2600);
    }
  }, [geo, chosenIdx, size?.dpr]);

  useEffect(() => { if (engineRef.current) engineRef.current.frozen = phase === "offline"; }, [phase]);

  useEffect(() => {
    if (!scanKey) return;
    sweepLabelled.current = true;
    engineRef.current?.sweep(3000);
  }, [scanKey]);

  useEffect(() => { if (supplyKey) engineRef.current?.supply(); }, [supplyKey]);

  // the first survey: the sweep keeps crossing the bare ground until pools arrive
  useEffect(() => {
    if (phase !== "cold") return;
    const run = () => { sweepLabelled.current = true; engineRef.current?.sweep(3800); };
    run();
    const id = setInterval(run, 4600);
    return () => clearInterval(id);
  }, [phase]);

  // ── labels: measure, then hang each on a leader long enough to clear the rest
  const measure = useCallback(() => {
    if (!geo) return;
    const boxes = geo.peaks.map((_, i) => {
      const t = labelRefs.current[i]?.querySelector<HTMLElement>(".t");
      return { x: geo.tops[i].x, anchorY: geo.tops[i].y - 6, w: t?.offsetWidth ?? 90, h: t?.offsetHeight ?? 16 };
    });
    const leads = declutter(boxes);
    setMeasured((m) =>
      m.leads.join() === leads.join() && m.heights.join() === boxes.map((b) => b.h).join() ? m : { leads, heights: boxes.map((b) => b.h) });
  }, [geo]);
  useLayoutEffect(measure, [measure, holding, chosenId]);
  useEffect(() => { void document.fonts?.ready.then(measure); }, [measure]);

  // ── pointer: read a summit like a survey plate ───────────────────────────
  const hitAt = (mx: number, my: number) => {
    if (!geo || my < plateLine) return null;
    let best = Infinity, hit: string | null = null;
    geo.peaks.forEach((k, i) => {
      const dx = Math.abs(mx - geo.tops[i].x) / k.w;
      if (dx < 1 && my > geo.tops[i].y - 46 && dx < best) { best = dx; hit = k.id; }
    });
    return hit as string | null;
  };
  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const id = hitAt(e.clientX, e.clientY);
    e.currentTarget.style.cursor = id ? "pointer" : "";
    setTip(id && byId[id] ? { pool: byId[id], x: e.clientX, y: e.clientY } : null);
  };
  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const id = hitAt(e.clientX, e.clientY);
    if (id) onSelect(id); else onBackground();
  };

  const selIdx = geo ? geo.peaks.findIndex((k) => k.id === selectedId) : -1;
  const capTop = geo ? Math.max(plateLine + 24, geo.ridge.minSummit - 20) : 0;

  return (
    <>
      <canvas ref={canvasRef} className="plate-canvas" aria-hidden="true" onMouseMove={onMove} onMouseLeave={() => setTip(null)} onClick={onClick} />
      <div className="plate-overlay">
        {geo?.peaks.map((k, i) => {
          const pool = byId[k.id];
          if (!pool) return null;
          const chosen = k.id === chosenId;
          const cls = ["pl", pool.eligible ? "" : "fog", chosen ? "chosen" : "", selIdx >= 0 ? (i === selIdx ? "sel" : "dim") : ""].filter(Boolean).join(" ");
          return (
            <button
              key={k.id}
              ref={(el) => { labelRefs.current[i] = el; }}
              className={cls}
              style={{ left: geo.tops[i].x, top: geo.tops[i].y - 6, "--lead": `${measured.leads[i] ?? 14}px` } as CSSProperties}
              onClick={() => onSelect(k.id)}
              aria-label={`${protocolLabel(pool)} ${poolTitle(pool)}, ${formatApy(pool.apyBps)} APY, risk ${pool.riskScore}, ${pool.eligible ? "eligible" : "excluded"}`}
            >
              <span className="t">
                <b>{shortLabel(pool)}</b> {formatApy(pool.apyBps)}
                {chosen && <span className="tagx">{holding ? "◆ YOUR USDC" : "◆ AGENT ROUTE"}</span>}
              </span>
              <i />
            </button>
          );
        })}
        {geo && geo.capX != null && (
          <div className="cap" style={{ left: geo.capX, top: capTop, height: Math.max(0, geo.ridge.ridge[Math.round(geo.capX)] - 4 - capTop) }}>
            <span>RISK CAP {riskCap}</span>
          </div>
        )}
        {geo && selIdx >= 0 && (() => {
          const t = geo.tops[selIdx];
          const labelTop = t.y - 6 - (measured.leads[selIdx] ?? 14) - 7 - (measured.heights[selIdx] ?? 16) - 6;
          return <div className="callout" style={{ left: t.x, top: plateLine, height: Math.max(0, labelTop - plateLine) }} />;
        })()}
        <div ref={sweepRef} className="sweep">{phase === "cold" ? "SURVEYING" : "SCANNING"}</div>
      </div>
      {tip && <PoolTip {...tip} chosen={tip.pool.poolId === chosenId} holding={holding} />}
    </>
  );
}

function PoolTip({ pool, x, y, chosen, holding }: { pool: ApiScoredPool; x: number; y: number; chosen: boolean; holding: boolean }) {
  const verdict = chosen
    ? holding ? "Eligible. Your USDC is supplied here." : "Eligible. The agent routes idle USDC here."
    : pool.eligible ? "Eligible. Lower yield than the current route." : `Excluded: ${pool.reason ?? "not eligible"}.`;
  const W = typeof window === "undefined" ? 1440 : window.innerWidth;
  const H = typeof window === "undefined" ? 900 : window.innerHeight;
  const left = x + 22 + 260 > W ? x - 260 - 22 : x + 22;
  const top = Math.max(12, Math.min(H - 230, y - 40));
  return (
    <div className="tip" style={{ left, top }}>
      <h6>{protocolLabel(pool)} · {poolTitle(pool)}</h6>
      <div className="v">{formatApy(pool.apyBps)}<small>APY</small></div>
      <dl>
        <div><dt>TVL</dt><dd>{tvlCompact(pool.tvlUsdc)}</dd></div>
        <div><dt>Util</dt><dd>{formatPct(pool.utilizationBps)}</dd></div>
        <div><dt>Risk</dt><dd>{pool.riskScore} / 100</dd></div>
      </dl>
      <p>{verdict}</p>
      <div className="click">Click to open</div>
    </div>
  );
}
