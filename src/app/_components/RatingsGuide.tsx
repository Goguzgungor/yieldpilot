"use client";

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import {
  cappedBy,
  depositFunnel,
  factorReadings,
  GUIDE_BANDS,
  GUIDE_CEILINGS,
  GUIDE_FACTORS,
  WEAK_FACTOR,
  weakOn,
  type GuideCeiling,
  type GuideRating,
} from "../../lib/vigil/guide";

/** Pools the guide points at, for the score list below to highlight. */
export interface GuideFocus {
  label: string;
  ids: Set<string>;
}

type Tab = "reads" | "caps" | "gates";

const TABS: Array<{ id: Tab; title: string; sub: string }> = [
  { id: "reads", title: "Reads the setup", sub: "Seven factors, weighted" },
  { id: "caps", title: "Caps the grade", sub: "Rules that set a ceiling" },
  { id: "gates", title: "Gates deposits", sub: "Separate from the grade" },
];

/** Band centres, for the letters under a scale. */
const LETTERS = GUIDE_BANDS.map(([min], i) => {
  const max = i === 0 ? 100 : GUIDE_BANDS[i - 1][0];
  return [(min + max) / 2, GUIDE_BANDS[i][1]] as const;
});

function pct(w: number): string {
  return `${Math.round(w * 100)}%`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The lowest score of a ceiling's grade: where a soft ceiling starts compressing. */
function bandFloor(c: GuideCeiling): number {
  return GUIDE_BANDS.find(([, g]) => g === c.grade)?.[0] ?? 0;
}

/** Jumps to the score list and turns the highlight on. */
function SeeBelow({ n, activate }: { n: number; activate: () => void }) {
  if (n === 0) return null;
  return (
    <a className="rg-below" href="#rt-scores" onClick={activate}>
      {n === 1 ? "Show it" : `Show all ${n}`} in the scores below ↓
    </a>
  );
}

interface PanelProps {
  ratings: GuideRating[] | null;
  pick: (id: string) => void;
  activate: () => void;
}

function ReadsPanel({ ratings, factorKey, pick, activate }: PanelProps & { factorKey: string }) {
  const f = GUIDE_FACTORS.find((x) => x.key === factorKey) ?? GUIDE_FACTORS[0];
  const readings = ratings ? factorReadings(ratings, f.key) : [];
  const weak = readings.filter((x) => x.value < WEAK_FACTOR).length;
  return (
    <>
      <div className="rg-weights" role="group" aria-label="The seven factors, sized by weight">
        {GUIDE_FACTORS.map((x) => (
          <button
            key={x.key}
            type="button"
            className={x.weight < 0.1 ? "rg-seg rg-seg--narrow" : "rg-seg"}
            style={{ flexGrow: x.weight }}
            aria-pressed={x.key === f.key}
            aria-label={`${x.label}, ${pct(x.weight)} of the score`}
            onClick={() => pick(x.key)}
          >
            <span className="rg-seg-pct">{pct(x.weight)}</span>
            <span className="rg-seg-name">{x.label}</span>
          </button>
        ))}
      </div>
      <div className="rg-split">
        <div>
          <div className="rg-kicker">Factor · {pct(f.weight)} of the score</div>
          <h3 className="rg-name">{f.label}</h3>
          <p className="rg-text">{f.reads}</p>
          <p className="rg-why">{f.why}</p>
        </div>
        <div className="rg-live">
          <div className="rg-kicker">Today, on every graded pool</div>
          {!ratings && <p className="rg-note">Live values appear when the ratings load.</p>}
          {readings.map((x) => (
            <div key={x.poolId} className={x.value < WEAK_FACTOR ? "rg-mini rg-mini--weak" : "rg-mini"}>
              <span className="rg-mini-name">{x.name}</span>
              <span className="rg-mini-bar" aria-hidden="true">
                <i style={{ width: `${x.value}%` }} />
              </span>
              <span className="rg-mini-val">{Math.round(x.value)}</span>
            </div>
          ))}
          {ratings && (
            <p className="rg-note">
              {weak === 0
                ? `No graded pool scores under ${WEAK_FACTOR} here.`
                : `${plural(weak, "pool")} under ${WEAK_FACTOR}, the mark on each bar.`}{" "}
              <SeeBelow n={weak} activate={activate} />
            </p>
          )}
        </div>
      </div>
    </>
  );
}

function CapsPanel({ ratings, ceilingId, pick, activate }: PanelProps & { ceilingId: string }) {
  const c = GUIDE_CEILINGS.find((x) => x.id === ceilingId) ?? GUIDE_CEILINGS[0];
  const hits = ratings ? cappedBy(ratings, c).filter((r) => r.score !== null) : [];
  return (
    <div className="rg-caps">
      <div role="group" aria-label="Ceilings">
        {GUIDE_CEILINGS.map((x) => {
          const n = ratings ? cappedBy(ratings, x).filter((r) => r.score !== null).length : null;
          return (
            <button key={x.id} type="button" className="rg-cap" aria-pressed={x.id === c.id} onClick={() => pick(x.id)}>
              <span className={`rg-cap-max rt-g-${x.grade}`}>{x.grade === "E" ? "E" : `≤ ${x.grade}`}</span>
              <span className="rg-cap-label">{x.label}</span>
              <span className="rg-cap-n">{n === null ? "" : n === 0 ? "none today" : `${n} today`}</span>
            </button>
          );
        })}
      </div>
      <div>
        <div className="rg-kicker">
          {c.grade === "E" ? "Grade E" : `At most ${c.grade}`} · score ≤ {c.cap}
          {c.closesDeposits ? " · closes deposits" : ""}
        </div>
        <div className="rg-scale" role="img" aria-label={`Scores above ${c.cap} are out of reach`}>
          <span className="rg-scale-line" />
          {GUIDE_BANDS.slice(0, 4).map(([min]) => (
            <span key={min} className="rg-scale-tick" style={{ left: `${min}%` }} />
          ))}
          {LETTERS.map(([centre, g]) => (
            <span key={g} className="rg-scale-letter" style={{ left: `${centre}%` }}>
              {g}
            </span>
          ))}
          <span className="rg-reach" style={{ left: `${c.cap}%` }}>
            <span>max {c.cap}</span>
          </span>
        </div>
        <p className="rg-text">{c.detail}</p>
        <p className="rg-why">
          {c.soft
            ? `A soft ceiling: scores above ${bandFloor(c)} are compressed into ${bandFloor(c)}–${c.cap}, so pools under it keep their order.`
            : `A hard cap: whatever the factors add up to, the score stops at ${c.cap}.`}
          {c.closesDeposits ? " The pool is also closed to deposits." : " It lowers the grade but does not close deposits on its own."}
        </p>
        {ratings && (
          <div className="rg-hits">
            {hits.length === 0 && <p className="rg-note">No graded pool hits this rule today.</p>}
            {hits.map((r) => {
              const score = r.score ?? 0;
              const before = Math.max(r.uncappedScore ?? score, score);
              return (
                <div key={r.poolId} className="rg-hit">
                  <span className="rg-mini-name">
                    {r.name}
                    {r.protocol === "defindex" && <small> DeFindex</small>}
                  </span>
                  <span
                    className="rg-hit-track"
                    role="img"
                    aria-label={`${r.name}: ${before} before the rules, ${score} after`}
                  >
                    <span className="rg-hit-cap" style={{ left: `${c.cap}%` }} />
                    {before > score && <span className="rt-cap" style={{ left: `${score}%`, width: `${before - score}%` }} />}
                    {before > score && <span className="rt-ghost" style={{ left: `${before}%` }} />}
                    <span className={`rt-dot rt-g-${gradeOf(score)}`} style={{ left: `${score}%` }} />
                  </span>
                  <span className="rg-mini-val">
                    {before > score ? `${before}→` : ""}
                    {score}
                  </span>
                </div>
              );
            })}
            <SeeBelow n={hits.length} activate={activate} />
          </div>
        )}
      </div>
    </div>
  );
}

function gradeOf(score: number): string {
  return GUIDE_BANDS.find(([min]) => score >= min)?.[1] ?? "E";
}

function GatesPanel({ ratings, gateId, pick }: Omit<PanelProps, "activate"> & { gateId: string }) {
  const steps = depositFunnel(ratings ?? []);
  const total = steps[0].poolIds.length || 1;
  return (
    <>
      <p className="rg-text rg-lead">
        The grade says how safe it is to supply. Whether you can supply at all is decided separately, so a C pool can
        take deposits and a well-built pool can be closed. Each step keeps the pools that pass it.
      </p>
      <div className="rg-gates" role="group" aria-label="Deposit gates">
        {steps.map((s) => {
          const n = s.poolIds.length;
          return (
            <button
              key={s.id}
              type="button"
              className={ratings && n === 0 ? "rg-gate rg-gate--zero" : "rg-gate"}
              aria-pressed={s.id === gateId}
              onClick={() => pick(s.id)}
            >
              <span className="rg-gate-n">{ratings ? n : "—"}</span>
              <span className="rg-gate-body">
                <b>{s.label}</b>
                <small>{s.detail}</small>
              </span>
              <span className="rg-gate-bar" aria-hidden="true">
                <i style={{ width: ratings ? `${(n / total) * 100}%` : 0 }} />
              </span>
            </button>
          );
        })}
      </div>
      {ratings && steps.at(-1)!.poolIds.length === 0 && (
        <p className="rg-note">No Blend pool passes every gate today, so YieldPilot holds and idle USDC stays idle. Withdrawals are never gated.</p>
      )}
    </>
  );
}

export default function RatingsGuide({
  ratings,
  onFocus,
  clearSignal,
}: {
  ratings: GuideRating[] | null;
  onFocus: (focus: GuideFocus | null) => void;
  /** Bumped by the page when the reader clears the highlight. */
  clearSignal: number;
}) {
  const [tab, setTab] = useState<Tab>("reads");
  const [factorKey, setFactorKey] = useState(GUIDE_FACTORS[0].key);
  const [ceilingId, setCeilingId] = useState("first-loss");
  const [gateId, setGateId] = useState("clears");
  // Nothing is highlighted until the reader picks something.
  const [touched, setTouched] = useState(false);

  useEffect(() => setTouched(false), [clearSignal]);

  const focus = useMemo<GuideFocus | null>(() => {
    if (!touched || !ratings) return null;
    if (tab === "reads") {
      const f = GUIDE_FACTORS.find((x) => x.key === factorKey)!;
      return { label: `weak on ${f.label.toLowerCase()} (under ${WEAK_FACTOR})`, ids: weakOn(ratings, f.key) };
    }
    if (tab === "caps") {
      const c = GUIDE_CEILINGS.find((x) => x.id === ceilingId)!;
      return { label: c.label.toLowerCase(), ids: new Set(cappedBy(ratings, c).map((r) => r.poolId)) };
    }
    const s = depositFunnel(ratings).find((x) => x.id === gateId)!;
    return { label: s.label.toLowerCase(), ids: new Set(s.poolIds) };
  }, [touched, ratings, tab, factorKey, ceilingId, gateId]);

  useEffect(() => onFocus(focus), [focus, onFocus]);

  const activate = () => setTouched(true);
  const choose = (set: (v: string) => void) => (v: string) => {
    set(v);
    activate();
  };

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = TABS[(i + step + TABS.length) % TABS.length];
    setTab(next.id);
    document.getElementById(`rg-tab-${next.id}`)?.focus();
  };

  return (
    <section className="rg" aria-label="How a grade is made">
      <div className="rg-tabs" role="tablist" aria-label="How a grade is made">
        {TABS.map((t, i) => (
          <button
            key={t.id}
            id={`rg-tab-${t.id}`}
            type="button"
            role="tab"
            className="rg-tab"
            aria-selected={tab === t.id}
            aria-controls="rg-panel"
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => onTabKey(e, i)}
          >
            <span className="rg-tab-n">{i + 1}</span>
            <span className="rg-tab-t">{t.title}</span>
            <span className="rg-tab-s">{t.sub}</span>
          </button>
        ))}
      </div>
      <div className="rg-panel" id="rg-panel" role="tabpanel" aria-labelledby={`rg-tab-${tab}`} key={tab}>
        {tab === "reads" && <ReadsPanel ratings={ratings} factorKey={factorKey} pick={choose(setFactorKey)} activate={activate} />}
        {tab === "caps" && <CapsPanel ratings={ratings} ceilingId={ceilingId} pick={choose(setCeilingId)} activate={activate} />}
        {tab === "gates" && <GatesPanel ratings={ratings} gateId={gateId} pick={choose(setGateId)} />}
      </div>
    </section>
  );
}
