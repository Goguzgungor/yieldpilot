"use client";

import dynamic from "next/dynamic";
import type { ComponentType } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiPosition, ApiScoredPool } from "./types";
import { poolPillLabel, truncateAddress } from "./format";

// Canvas/DOM-only lib — must never render on the server, so it's dynamically
// imported with ssr:false. The library ships its own (strict) NodeObject/
// LinkObject generics that fight our narrower GraphNode/GraphLink; we type the
// component loosely at the boundary and annotate accessor params ourselves.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), {
  ssr: false,
}) as unknown as ComponentType<any>;

// d3-force-3d ships collide — react-force-graph-2d depends on it transitively.
// Import at runtime to avoid SSR issues (ForceGraph2D is already client-only).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _forceCollide: ((r: (n: any) => number) => any) | null = null;
if (typeof window !== "undefined") {
  import("d3-force-3d").then((m) => {
    _forceCollide = m.forceCollide ?? null;
  });
}

// Screen-world palette (the canvas renders on the dark glass viewport).
const SCREEN_INK = "#e8eaf2";
const SCREEN_MUT = "#8a90a3";
const BLUE_BRIGHT = "#6d86ff";
const PILL_FILL = "#1a1e29";
const PILL_STROKE = "rgba(255,255,255,0.14)";
const PILL_FILL_DIM = "rgba(26,30,41,0.55)";
const PILL_STROKE_DIM = "rgba(255,255,255,0.07)";

/** Tracks the OS "reduce motion" preference so canvas particles calm down. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReduced(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return reduced;
}

// Deterministic radial layout (graph units). Pools sit on a ring of POOL_RADIUS
// around the pinned agent; dust fills a slightly larger disc so zoom-to-fit
// frames a stable, spacious extent.
const POOL_RADIUS = 90;
const DUST_RADIUS = 150;

export type GraphNode = {
  id: string;
  kind: "agent" | "pool" | "dust";
  label?: string;
  pool?: ApiScoredPool;
  best?: boolean;
  chosen?: boolean;
  // physics
  fx?: number;
  fy?: number;
  x?: number;
  y?: number;
};

type GraphLink = {
  source: string;
  target: string;
  chosen?: boolean;
  eligible?: boolean;
};

interface Props {
  pools: ApiScoredPool[];
  position: ApiPosition | null;
  scanning: boolean;
  selectedId: string | null;
  onSelect: (poolId: string | null) => void;
  /** Latest agent supply tx hash — drawn as a badge above the chosen pool. */
  chosenTxHash?: string | null;
}

// Deterministic faint dot-cloud (Giza texture) generated once per canvas size.
// Nodes are fixed so the simulation never moves them; coordinates span the full
// canvas in graph-space (centred on 0,0 like d3-force).
function makeDust(count: number, radius: number): GraphNode[] {
  const dust: GraphNode[] = [];
  let seed = 1337;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  // Distribute in a disc (sqrt → uniform area) centred on 0,0 in GRAPH units,
  // bounded near the pool ring so zoom-to-fit frames a sensible extent.
  for (let i = 0; i < count; i++) {
    const r = Math.sqrt(rand()) * radius;
    const a = rand() * Math.PI * 2;
    const fx = Math.cos(a) * r;
    const fy = Math.sin(a) * r;
    dust.push({ id: `dust-${i}`, kind: "dust", fx, fy, x: fx, y: fy });
  }
  return dust;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const radius = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** Approximate half-width of a pool pill in graph units (used for collision). */
function pillHalfWidth(label: string, ctx: CanvasRenderingContext2D): number {
  ctx.font = "600 3.4px var(--font-plex-mono, monospace)";
  const mark = "✷ ";
  const textW = ctx.measureText(mark + label).width;
  // padX is 5 on each side in the draw code → total w = textW + 10
  return (textW + 10) / 2 + 6; // +6 px gap so pills don't kiss
}

export default function NetworkGraph({
  pools,
  position,
  scanning,
  selectedId,
  onSelect,
  chosenTxHash,
}: Props) {
  const reducedMotion = usePrefersReducedMotion();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<any>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // TX pulse: record when a new supply TX lands so nodeCanvasObject can draw
  // staggered ripple rings during the next ~1.2 s of animation frames.
  const pulseRef = useRef<number>(0);
  useEffect(() => {
    if (!chosenTxHash) return;
    pulseRef.current = Date.now();
  }, [chosenTxHash]);

  // Status caption under the agent node (no more "idle USDC" — we surface what
  // the agent is actively doing instead).
  const agentLabel = useMemo(() => {
    if (!pools.length) return "scanning…";
    const eligible = pools.filter((p) => p.eligible).length;
    return `${pools.length} pool${pools.length === 1 ? "" : "s"} · ${eligible} eligible`;
  }, [pools]);

  const chosenPoolId = position?.chosenPoolId ?? null;

  // Size the graph to its container using ResizeObserver.
  // Guard against zero sizes — ForceGraph2D needs real pixel dimensions.
  const [dims, setDims] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const apply = () => {
      const w = el.clientWidth || el.offsetWidth;
      const h = el.clientHeight || el.offsetHeight;
      if (w > 0 && h > 0) {
        setDims((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
      }
    };
    // Retry a few times in case layout hasn't settled yet
    apply();
    const t1 = setTimeout(apply, 50);
    const t2 = setTimeout(apply, 200);
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      ro.disconnect();
    };
  }, []);

  // Dust spread to full canvas area (in graph coords centred on 0,0).
  // Dust lives in fixed graph-space (independent of canvas px) → stable framing.
  const dust = useMemo(() => makeDust(160, DUST_RADIUS), []);

  const { nodes, links } = useMemo(() => {
    // Best eligible pool by APY (matches backend bestPool()).
    const eligible = pools.filter((p) => p.eligible);
    const best = eligible.length
      ? eligible.reduce((a, b) => (b.apyBps > a.apyBps ? b : a))
      : null;

    // Highlight logic (option 1 — "wow moment"):
    //   Show the full blue chosen-treatment ONLY when the user's funds are
    //   actually deployed (position.poolId is set + amountUsdc > 0). Before
    //   any supply the graph is visually neutral so the glow is a reveal, not
    //   a permanent fixture. The "best" eligible pool gets a subtle dotted
    //   outline so the user can still identify it pre-deployment.
    const activePoolId =
      position?.poolId && Number(position.amountUsdc ?? "0") > 0
        ? position.poolId
        : null;
    const highlightId = activePoolId;

    // Pin the agent at the canvas centre in graph-space (0, 0).
    const agent: GraphNode = {
      id: "__agent__",
      kind: "agent",
      label: agentLabel,
      fx: 0,
      fy: 0,
      x: 0,
      y: 0,
    };
    // Pin pools at fixed radial positions around the centre (deterministic
    // "spokes" — far more reliable than force physics for a handful of nodes).
    const count = Math.max(pools.length, 1);
    const poolNodes: GraphNode[] = pools.map((p, i) => {
      const ang = -Math.PI / 2 + (i * 2 * Math.PI) / count;
      const fx = Math.cos(ang) * POOL_RADIUS;
      const fy = Math.sin(ang) * POOL_RADIUS;
      return {
        id: p.poolId,
        kind: "pool" as const,
        label: poolPillLabel(p.name, p.poolId),
        pool: p,
        best: best?.poolId === p.poolId,
        chosen: highlightId === p.poolId,
        fx,
        fy,
        x: fx,
        y: fy,
      };
    });
    const poolLinks: GraphLink[] = pools.map((p) => ({
      source: "__agent__",
      target: p.poolId,
      eligible: p.eligible,
      chosen: highlightId === p.poolId,
    }));

    return {
      nodes: [...dust, agent, ...poolNodes],
      links: poolLinks,
    };
  }, [pools, dust, agentLabel, chosenPoolId]);

  // Tune forces whenever the graph mounts or node count changes.
  // Runs after ForceGraph2D has created the d3 simulation.
  const applyForces = useCallback(() => {
    const fg = fgRef.current;
    if (!fg) return;
    try {
      // Every node is pinned (fx/fy) → positions are deterministic. Neutralise
      // the default forces so nothing nudges the layout or jitters.
      fg.d3Force("charge")?.strength(0);
      fg.d3Force("link")?.distance(0).strength(0);
      const center = fg.d3Force("center");
      if (center) center.strength(0);
      fg.d3VelocityDecay(0.6);
      void _forceCollide;
    } catch {
      /* force accessors differ across builds; non-fatal */
    }
  }, [pools]);

  useEffect(() => {
    applyForces();
  }, [applyForces, nodes.length]);

  // After the engine cools down, zoom-to-fit with generous padding so nodes
  // fill the entire canvas rather than clustering in a tiny centre spot.
  const zoomToFit = useCallback(() => {
    const fg = fgRef.current;
    if (!fg) return;
    try {
      fg.zoomToFit(500, 48);
    } catch {
      /* non-fatal if graph isn't ready */
    }
  }, []);

  // Re-fit on resize (dims change triggers a new ForceGraph2D render anyway,
  // but we also want to re-fit after layout has settled in the new canvas).
  useEffect(() => {
    if (dims.w > 0 && dims.h > 0) {
      const t = setTimeout(zoomToFit, 500);
      return () => clearTimeout(t);
    }
  }, [dims, nodes.length, zoomToFit]);

  // Reheat layout when pool set changes.
  useEffect(() => {
    const fg = fgRef.current;
    if (fg && typeof fg.d3ReheatSimulation === "function") {
      fg.d3ReheatSimulation();
    }
  }, [pools.length]);

  return (
    <div ref={wrapRef} style={{ position: "absolute", inset: 0 }}>
      {dims.w > 0 && dims.h > 0 && (
        <ForceGraph2D
          ref={fgRef}
          width={dims.w}
          height={dims.h}
          graphData={{ nodes, links }}
          backgroundColor="rgba(0,0,0,0)"
          cooldownTime={4500}
          warmupTicks={50}
          enableNodeDrag={true}
          enableZoomInteraction={true}
          minZoom={0.3}
          maxZoom={3}
          nodeRelSize={5}
          nodeVal={(n: GraphNode) =>
            n.kind === "dust" ? 0.4 : n.kind === "agent" ? 6 : 3
          }
          // Links: chosen = solid blue, ineligible = faint dashed grey, others = soft ink.
          linkColor={(l: GraphLink) =>
            l.chosen
              ? BLUE_BRIGHT
              : l.eligible
                ? "rgba(232,234,242,0.30)"
                : "rgba(232,234,242,0.10)"
          }
          linkWidth={(l: GraphLink) => (l.chosen ? 1.6 : 1)}
          linkLineDash={(l: GraphLink) =>
            !l.eligible && !l.chosen ? [4, 4] : null
          }
          linkDirectionalParticles={(l: GraphLink) => (l.chosen ? 4 : 0)}
          linkDirectionalParticleWidth={(l: GraphLink) => (l.chosen ? 3 : 0)}
          linkDirectionalParticleSpeed={reducedMotion ? 0.002 : scanning ? 0.012 : 0.006}
          linkDirectionalParticleColor={() => BLUE_BRIGHT}
          // After the engine cools down, zoom to fill the canvas.
          onEngineStop={zoomToFit}
          onNodeClick={(n: GraphNode) => {
            if (n.kind === "pool") onSelect(n.id);
            else onSelect(null);
          }}
          onBackgroundClick={() => onSelect(null)}
          nodePointerAreaPaint={(
            n: GraphNode,
            color: string,
            ctx: CanvasRenderingContext2D,
          ) => {
            // Hit area roughly matching the drawn shape.
            if (n.kind === "dust") return;
            ctx.fillStyle = color;
            if (n.kind === "agent") {
              ctx.beginPath();
              ctx.arc(n.x ?? 0, n.y ?? 0, 14, 0, 2 * Math.PI);
              ctx.fill();
              return;
            }
            ctx.font = "600 3.4px var(--font-plex-mono, monospace)";
            const text = "✷ " + (n.label ?? "");
            const w = ctx.measureText(text).width + 10;
            roundRect(
              ctx,
              (n.x ?? 0) - w / 2,
              (n.y ?? 0) - 7,
              w,
              14,
              4.5,
            );
            ctx.fill();
          }}
          nodeCanvasObject={(
            n: GraphNode,
            ctx: CanvasRenderingContext2D,
            globalScale: number,
          ) => {
            const x = n.x ?? 0;
            const y = n.y ?? 0;

            if (n.kind === "dust") {
              ctx.fillStyle = "rgba(232,234,242,0.12)";
              ctx.beginPath();
              ctx.arc(x, y, 0.7, 0, 2 * Math.PI);
              ctx.fill();
              return;
            }

            if (n.kind === "agent") {
              // Concentric blue ring (matches .center .ring in the reference).
              ctx.beginPath();
              ctx.arc(x, y, 13, 0, 2 * Math.PI);
              ctx.fillStyle = "rgba(109,134,255,0.07)";
              ctx.fill();
              ctx.beginPath();
              ctx.arc(x, y, 8.5, 0, 2 * Math.PI);
              ctx.fillStyle = "rgba(109,134,255,0.16)";
              ctx.fill();
              ctx.beginPath();
              ctx.arc(x, y, 5, 0, 2 * Math.PI);
              ctx.fillStyle = BLUE_BRIGHT;
              ctx.fill();
              // Label BELOW the ring — offset far enough to clear the ring.
              ctx.textAlign = "center";
              ctx.textBaseline = "top";
              ctx.font = "500 2.8px var(--font-plex-mono, monospace)";
              ctx.fillStyle = SCREEN_MUT;
              ctx.fillText("YIELDPILOT AGENT", x, y + 20);
              ctx.font = "700 3.8px var(--font-plex-mono, monospace)";
              ctx.fillStyle = SCREEN_INK;
              ctx.fillText(n.label ?? "", x, y + 25);
              return;
            }

            // Pool: black rounded pill with a mark, white mono text.
            // chosen  = funds actively deployed here → full blue treatment.
            // bestOnly = best eligible but no funds yet → subtle dotted outline.
            const pool = n.pool!;
            const isChosen = !!n.chosen;
            const isBestOnly = !!n.best && !isChosen;
            const isDim = !pool.eligible;
            const selected = n.id === selectedId;

            const fontPx = 3.4;
            ctx.font = `600 ${fontPx}px var(--font-plex-mono, monospace)`;
            const mark = "✷ ";
            const text = mark + (n.label ?? "");
            const padX = 6;
            const padY = 3.8;
            const textW = ctx.measureText(text).width;
            const w = textW + padX * 2;
            const h = fontPx + padY * 2;
            const rectX = x - w / 2;
            const rectY = y - h / 2;

            // Soft shadow / glow for chosen / selected.
            if (isChosen || selected) {
              ctx.save();
              ctx.shadowColor = "rgba(109,134,255,0.40)";
              ctx.shadowBlur = 12;
              ctx.shadowOffsetY = 4;
            }
            roundRect(ctx, rectX, rectY, w, h, 4.5);
            ctx.fillStyle = isDim ? PILL_FILL_DIM : PILL_FILL;
            ctx.fill();
            ctx.lineWidth = 0.5;
            ctx.strokeStyle = isDim ? PILL_STROKE_DIM : PILL_STROKE;
            ctx.stroke();
            if (isChosen || selected) ctx.restore();

            // Blue outline ring on chosen / selected.
            if (isChosen || selected) {
              roundRect(ctx, rectX - 0.7, rectY - 0.7, w + 1.4, h + 1.4, 5);
              ctx.lineWidth = 1;
              ctx.strokeStyle = BLUE_BRIGHT;
              ctx.stroke();
            } else if (isBestOnly) {
              // Subtle dotted outline: "this is where your money would go"
              // No glow, no particles — just a hint.
              ctx.save();
              ctx.setLineDash([2, 2.5]);
              roundRect(ctx, rectX - 0.6, rectY - 0.6, w + 1.2, h + 1.2, 5);
              ctx.lineWidth = 0.7;
              ctx.strokeStyle = "rgba(109,134,255,0.55)";
              ctx.stroke();
              ctx.restore();
            }

            // Tx badge above the CHOSEN pool — surfaces the agent's latest supply
            // tx hash so it's obvious the money actually moved INTO this pool.
            if (isChosen && chosenTxHash) {
              const bFont = 2.6;
              ctx.font = `700 ${bFont}px var(--font-plex-mono, monospace)`;
              const bText = "✓ TX " + truncateAddress(chosenTxHash, 4, 4);
              const bw = ctx.measureText(bText).width + 6;
              const bh = bFont + 3;
              const bx = x - bw / 2;
              const by = rectY - bh - 3;
              ctx.save();
              ctx.shadowColor = "rgba(109,134,255,0.5)";
              ctx.shadowBlur = 8;
              roundRect(ctx, bx, by, bw, bh, 2.5);
              ctx.fillStyle = BLUE_BRIGHT;
              ctx.fill();
              ctx.restore();
              ctx.textAlign = "center";
              ctx.textBaseline = "middle";
              // Near-black on the luminous badge — white fails contrast here.
              ctx.fillStyle = "#0c0e13";
              ctx.fillText(bText, x, by + bh / 2 + 0.2);
            }

            // TX pulse: 3 staggered ripple rings expanding outward when a new
            // supply TX lands. The graph is already animating (particles active)
            // so nodeCanvasObject is called every frame — no extra rAF needed.
            if (isChosen) {
              const pulseStart = pulseRef.current;
              if (pulseStart > 0) {
                const elapsed = Date.now() - pulseStart;
                for (let ring = 0; ring < 3; ring++) {
                  const ringElapsed = elapsed - ring * 230;
                  if (ringElapsed <= 0 || ringElapsed >= 950) continue;
                  const frac = ringElapsed / 950;
                  const radius = 9 + frac * 26;
                  const alpha = (1 - frac) * 0.45;
                  ctx.save();
                  ctx.beginPath();
                  ctx.arc(x, y, radius, 0, 2 * Math.PI);
                  ctx.strokeStyle = `rgba(109,134,255,${alpha.toFixed(2)})`;
                  ctx.lineWidth = 2.2 * (1 - frac * 0.65);
                  ctx.stroke();
                  ctx.restore();
                }
              }
            }

            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            ctx.font = `600 ${fontPx}px var(--font-plex-mono, monospace)`;
            // Mark glyph: blue accent for chosen, slightly brighter for best-only
            // (helps the user spot the target pool before deploying).
            ctx.fillStyle = isChosen
              ? "#a9b8ff"
              : isBestOnly
                ? "rgba(232,234,242,0.9)"
                : isDim
                  ? "rgba(232,234,242,0.45)"
                  : SCREEN_INK;
            ctx.fillText(mark, rectX + padX, y + 0.2);
            const markW = ctx.measureText(mark).width;
            ctx.fillStyle = isDim ? "rgba(232,234,242,0.55)" : SCREEN_INK;
            ctx.fillText(n.label ?? "", rectX + padX + markW, y + 0.2);

            // Endpoint dot near the agent-facing side (below the pill centre).
            const dotColor = isChosen ? BLUE_BRIGHT : isDim ? "rgba(232,234,242,0.35)" : SCREEN_INK;
            ctx.beginPath();
            ctx.arc(x, rectY + h + 2.5, 1.8, 0, 2 * Math.PI);
            ctx.fillStyle = dotColor;
            ctx.fill();
            if (isChosen) {
              ctx.beginPath();
              ctx.arc(x, rectY + h + 2.5, 3.4, 0, 2 * Math.PI);
              ctx.strokeStyle = "rgba(109,134,255,0.28)";
              ctx.lineWidth = 1.4;
              ctx.stroke();
            }

            // Collision hint: measure pill half-width so collision radius is accurate.
            // (We re-use globalScale to suppress text at very low zoom.)
            void globalScale; // referenced to avoid lint warn; used below ↓

            // Ineligible reason as a faint caption under the pill (only at zoom ≥ 1.1).
            if (isDim && pool.reason && globalScale > 1.1) {
              ctx.textAlign = "center";
              ctx.font = "400 2.4px var(--font-plex-mono, monospace)";
              ctx.fillStyle = SCREEN_MUT;
              ctx.fillText(pool.reason, x, rectY + h + 7);
            }

            // Expose pill half-width via node property for collision sizing.
            // Safe to write because react-force-graph merges node objects.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (n as any)._pillHalfW = pillHalfWidth(n.label ?? "", ctx);
          }}
        />
      )}
    </div>
  );
}
