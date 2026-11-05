"use client";

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import {
  DEFAULT_MAX_AGE_SECS,
  DEFAULT_MIN_SCORE,
  MAX_AGE_CHOICES,
  PATHS,
  VIGIL,
  depositVerdict,
  gradeOf,
  passingAt,
  pickExamples,
  type PathId,
  type Verdict,
  type VerdictRating,
  type Where,
} from "../../lib/integrate/facts";
import { RISKGATE_ERRORS, buildBrief, snippetFor } from "../../lib/integrate/brief";
import { snippet } from "../../lib/integrate/snippets";
import { GUIDE_BANDS } from "../../lib/vigil/guide";

/** What the page reads from GET /api/ratings. */
interface LiveRating extends VerdictRating {
  protocol: "blend" | "defindex";
  hardRules?: string[];
}

interface Live {
  engineVersion: string;
  computedAt: number;
  ratings: LiveRating[];
}

const PATH_IDS: PathId[] = ["api", "registry", "riskgate"];

/** Band centres, for the letters under the minimum-score slider. */
const LETTERS = GUIDE_BANDS.map(([min], i) => {
  const max = i === 0 ? 100 : GUIDE_BANDS[i - 1][0];
  return [(min + max) / 2, GUIDE_BANDS[i][1]] as const;
});

function ago(unix: number): string {
  const m = Math.max(0, Math.round((Date.now() / 1000 - unix) / 60));
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

function utc(unix: number): string {
  return `${new Date(unix * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** The first hard rule's cause, without the engine's "⇒ consequence" tail. */
function heldBecause(r: LiveRating): string {
  const rule = r.hardRules?.[0];
  return rule ? rule.split(" ⇒ ")[0] : "a hard rule";
}

/** What the chosen path's code does with this verdict. */
function outcome(path: PathId, where: Where, v: Verdict, minScore: number): string {
  if (path === "api") {
    return v.allowed ? "depositAllowed returns true: your backend may pick this pool." : "depositAllowed returns false: your backend skips this pool.";
  }
  if (path === "registry" && where === "contract") {
    return v.allowed
      ? "require_rated passes and your contract deposits."
      : `require_rated panics with ${v.code === 4114 ? "RatingUnavailable" : "ScoreTooLow"} and the deposit reverts.`;
  }
  if (path === "registry") {
    return v.allowed
      ? "depositAllowed(pool) returns { allowed: true }."
      : `depositAllowed(pool) returns { allowed: false, reason: "${v.code === 4114 ? "no rating (4114)" : `score ${v.onchain} < ${minScore} (4115)`}" }.`;
  }
  return v.allowed
    ? "The smart account lets the deposit through."
    : `The deposit fails on-chain with Error(Contract, #${v.code}). Withdrawals still work.`;
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="ig-btn"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1600);
        } catch {
          // Clipboard blocked (permissions, insecure origin): the text stays selectable.
        }
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}

/** A two- or three-way switch. */
function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<[T, string]>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="ig-seg" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={String(v)} type="button" role="radio" aria-checked={value === v} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

function readParams(): { path?: PathId; where?: Where; min?: number; age?: number; pool?: string } {
  if (typeof window === "undefined") return {};
  const q = new URLSearchParams(window.location.search);
  const path = q.get("path") as PathId | null;
  const where = q.get("where") as Where | null;
  const min = Number(q.get("min"));
  const age = Number(q.get("age"));
  return {
    path: path && PATH_IDS.includes(path) ? path : undefined,
    where: where === "backend" || where === "contract" ? where : undefined,
    min: Number.isInteger(min) && min >= 1 && min <= 100 ? min : undefined,
    age: (MAX_AGE_CHOICES as readonly number[]).includes(age) ? age : undefined,
    pool: q.get("pool") ?? undefined,
  };
}

export default function IntegrateView() {
  const [path, setPath] = useState<PathId>("api");
  const [where, setWhere] = useState<Where>("backend");
  const [minScore, setMinScore] = useState(DEFAULT_MIN_SCORE);
  const [maxAge, setMaxAge] = useState<number>(DEFAULT_MAX_AGE_SECS);
  const [poolId, setPoolId] = useState<string | null>(null);
  const [view, setView] = useState<"brief" | "code">("brief");
  const [live, setLive] = useState<Live | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);

  // Choices live in the URL, so a PM can send a colleague the exact brief.
  useEffect(() => {
    const p = readParams();
    if (p.path) setPath(p.path);
    if (p.where) setWhere(p.where);
    if (p.min) setMinScore(p.min);
    if (p.age) setMaxAge(p.age);
    if (p.pool) setPoolId(p.pool);
    setRestored(true);
  }, []);

  useEffect(() => {
    if (!restored) return;
    const q = new URLSearchParams({ path, min: String(minScore), age: String(maxAge) });
    if (path === "registry") q.set("where", where);
    if (poolId) q.set("pool", poolId);
    window.history.replaceState(null, "", `${window.location.pathname}?${q}`);
  }, [restored, path, where, minScore, maxAge, poolId]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/ratings")
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
        if (!cancelled) setLive(body as Live);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, []);

  const rated = useMemo(
    () => (live ? live.ratings.filter((r) => r.score !== null).sort((a, b) => (b.score ?? 0) - (a.score ?? 0)) : []),
    [live],
  );
  const unrated = live ? live.ratings.length - rated.length : 0;
  const selected: LiveRating | null = rated.find((r) => r.poolId === poolId) ?? rated[0] ?? null;
  const examples = useMemo(
    () => (live ? pickExamples(live.ratings, minScore, selected?.poolId ?? null) : undefined),
    [live, minScore, selected],
  );

  const brief = buildBrief({
    path,
    where,
    minScore,
    maxAgeSecs: maxAge,
    examples,
    asOf: live ? utc(live.computedAt) : undefined,
  });
  const code = snippet(snippetFor(path, where), { minScore, maxAgeSecs: maxAge });
  const info = PATHS[path];

  function onTabKey(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = PATH_IDS[(i + step + PATH_IDS.length) % PATH_IDS.length];
    setPath(next);
    document.getElementById(`ig-tab-${next}`)?.focus();
  }

  const verdict = selected ? depositVerdict(selected, minScore) : null;

  return (
    <main className="rt-page ig-page">
      <header className="rt-head">
        <a href="/" className="rt-back">
          YieldPilot
        </a>
        <h1 className="rt-title">Integrate Vigil</h1>
        <p className="rt-lede">
          Keep your users' money out of weak lending pools on Stellar. Choose how your product connects, set the
          minimum score a pool needs, check the rule on a live pool, then hand the brief to your AI coding assistant.
          The grades come from the <a href="/ratings">pool ratings</a>.
        </p>
        <p className="ig-live" role="status">
          {live ? (
            <>
              <span>Live</span> {rated.length} rated pools · {passingAt(rated, minScore)} take deposits at {minScore} ·
              computed {ago(live.computedAt)} · {live.engineVersion}
            </>
          ) : error ? (
            <>Live ratings could not be loaded ({error}). Everything below still works; the examples need them.</>
          ) : (
            <>Reading the live ratings. The first load of the hour takes about a minute and a half.</>
          )}
        </p>
      </header>

      <section className="ig-step" aria-labelledby="ig-h1">
        <h2 className="ig-h" id="ig-h1">
          <span>01</span>Choose how you connect
        </h2>
        <div className="rg-tabs" role="tablist" aria-label="Integration path">
          {PATH_IDS.map((id, i) => (
            <button
              key={id}
              id={`ig-tab-${id}`}
              type="button"
              role="tab"
              className="rg-tab"
              aria-selected={path === id}
              aria-controls="ig-panel"
              tabIndex={path === id ? 0 : -1}
              onClick={() => setPath(id)}
              onKeyDown={(e) => onTabKey(e, i)}
            >
              <span className="rg-tab-n">{i + 1}</span>
              <span className="rg-tab-t">{PATHS[id].title}</span>
              <span className="rg-tab-s">{PATHS[id].sub}</span>
            </button>
          ))}
        </div>
        <div className="rg-panel ig-path" id="ig-panel" role="tabpanel" aria-labelledby={`ig-tab-${path}`} key={path}>
          <p className="rg-text ig-gives">{info.gives}</p>
          <dl className="ig-facts">
            <div>
              <dt>Does not</dt>
              <dd>{info.doesNot}</dd>
            </div>
            <div>
              <dt>Effort</dt>
              <dd>{info.effort}</dd>
            </div>
            <div>
              <dt>Works on</dt>
              <dd>{info.network}</dd>
            </div>
            <div>
              <dt>You trust</dt>
              <dd>{info.trust}</dd>
            </div>
          </dl>
          {path === "registry" && (
            <div className="ig-where">
              <span className="rg-kicker">The check runs in</span>
              <Segmented
                label="Where the check runs"
                value={where}
                options={[
                  ["backend", "Your backend · TypeScript"],
                  ["contract", "Your Soroban contract · Rust"],
                ]}
                onChange={setWhere}
              />
            </div>
          )}
        </div>
      </section>

      <section className="ig-step" aria-labelledby="ig-h2">
        <h2 className="ig-h" id="ig-h2">
          <span>02</span>Set your rule
        </h2>
        <div className="rg-split">
          <div>
            <label className="ig-label" htmlFor="ig-min">
              Minimum score <output htmlFor="ig-min">{minScore}</output>
              <small>grade {gradeOf(minScore)}</small>
            </label>
            <input
              id="ig-min"
              className="ig-range"
              type="range"
              min={1}
              max={100}
              value={minScore}
              onChange={(e) => setMinScore(Number(e.target.value))}
            />
            <div className="ig-scale" aria-hidden="true">
              {GUIDE_BANDS.slice(0, -1).map(([min]) => (
                <i key={min} style={{ left: `${min}%` }} />
              ))}
              {LETTERS.map(([centre, g]) => (
                <span key={g} style={{ left: `${centre}%` }}>
                  {g}
                </span>
              ))}
            </div>
            <p className="rg-note">
              A pool needs at least this score to receive a deposit. YieldPilot's own wallets use{" "}
              <button type="button" className="ig-inline" onClick={() => setMinScore(DEFAULT_MIN_SCORE)}>
                {DEFAULT_MIN_SCORE}
              </button>
              . It starts at 1: the registry signs 0 for pools Vigil holds back, so a minimum of 0 would let them in.
            </p>

            <span className="ig-label">Maximum rating age</span>
            <Segmented
              label="Maximum rating age"
              value={maxAge}
              options={MAX_AGE_CHOICES.map((s) => [s, `${s / 3600} hour${s === 3600 ? "" : "s"}`] as [number, string])}
              onChange={setMaxAge}
            />
            <p className="rg-note">
              A new rating is signed every {VIGIL.publishEveryMin} minutes. The registry stops counting one after 2 hours,
              so a longer limit would change nothing. If publishing stops, deposits stop too: the rule fails closed.
            </p>
          </div>

          <div className="rg-live">
            <span className="rg-kicker">
              {live ? `At ${minScore}: ${passingAt(rated, minScore)} of ${rated.length} rated pools take deposits` : "Live pools"}
            </span>
            {rated.map((r) => {
              const v = depositVerdict(r, minScore);
              return (
                <button
                  key={r.poolId}
                  type="button"
                  className="ig-pool"
                  aria-pressed={selected?.poolId === r.poolId}
                  onClick={() => setPoolId(r.poolId)}
                >
                  <span className="ig-pool-name">
                    {r.name}
                    {r.protocol === "defindex" && <small> strategy</small>}
                  </span>
                  <span className={`rt-grade rt-g-${r.grade}`}>
                    {r.grade} {r.score}
                  </span>
                  <span className={v.allowed ? "rt-yes" : "rt-no"}>{v.allowed ? "Allowed" : `Refused #${v.code}`}</span>
                </button>
              );
            })}
            {live && unrated > 0 && (
              <p className="rg-note">
                {unrated} more pools are not rated (never launched, or too little supplied to measure). Nothing is
                published for them, so a deposit is refused with #4114.
              </p>
            )}
          </div>
        </div>
      </section>

      <section className="ig-step" aria-labelledby="ig-h3">
        <h2 className="ig-h" id="ig-h3">
          <span>03</span>See the rule on a live pool
        </h2>
        {selected && verdict ? (
          <div className="ig-check">
            <div className="ig-check-pool">
              <span className="rg-kicker">{selected.protocol === "defindex" ? "DeFindex strategy" : "Blend pool"}</span>
              <span className="rg-name">{selected.name}</span>
              <code className="ig-addr">{selected.poolId}</code>
            </div>
            <ol className="ig-gates">
              <li className="ig-pass">
                <b>Rated</b>
                <span>
                  {selected.grade} {selected.score}
                </span>
              </li>
              <li className={selected.eligibleForDeposit ? "ig-pass" : "ig-fail"}>
                <b>Vigil allows deposits</b>
                <span>
                  {selected.eligibleForDeposit
                    ? "No hard rule holds it back"
                    : `Held back: ${heldBecause(selected)}. The registry holds 0.`}
                </span>
              </li>
              <li className={verdict.allowed ? "ig-pass" : "ig-fail"}>
                <b>At or above your minimum</b>
                <span>
                  On-chain {verdict.onchain} {verdict.allowed ? "≥" : "<"} {minScore}
                  {verdict.allowed ? "" : ` (#${verdict.code})`}
                </span>
              </li>
            </ol>
            <p className={`ig-outcome ${verdict.allowed ? "ig-outcome--pass" : "ig-outcome--fail"}`}>
              <b>{verdict.allowed ? "Deposit allowed." : "Deposit refused."}</b> {outcome(path, where, verdict, minScore)}
            </p>
            {path !== "api" && (
              <p className="rg-note">
                The registry is on {VIGIL.network} and holds this mainnet pool's score, so a backend can read it
                today. On-chain enforcement works on {VIGIL.network} only, against YieldPilot's demo pool.
              </p>
            )}
          </div>
        ) : (
          <p className="rg-note">{error ? "Needs the live ratings." : "Waiting for the live ratings…"}</p>
        )}
      </section>

      <section className="ig-step" aria-labelledby="ig-h4">
        <h2 className="ig-h" id="ig-h4">
          <span>04</span>Hand it to your AI
        </h2>
        <p className="rg-text rg-lead">
          Paste the brief into Claude Code, Cursor or any assistant that can read your repository. It carries your
          choices, the addresses, starting code and a done-when list, and points the assistant to the{" "}
          <a href="/integrate.md">full guide</a>, which it can fetch itself.
        </p>
        <div className="ig-toolbar">
          <Segmented
            label="Show"
            value={view}
            options={[
              ["brief", "Brief for your AI"],
              ["code", "Code only"],
            ]}
            onChange={setView}
          />
          <span className="ig-toolbar-actions">
            <CopyButton text={view === "brief" ? brief : code.code} label={view === "brief" ? "Copy brief" : "Copy code"} />
            {view === "brief" && (
              <button type="button" className="ig-btn" onClick={() => download(`vigil-${path}.md`, brief)}>
                Download .md
              </button>
            )}
          </span>
        </div>
        {view === "code" && <p className="ig-file">{code.file}</p>}
        <pre className={view === "brief" ? "ig-pre ig-pre--wrap" : "ig-pre"} tabIndex={0} aria-label={view === "brief" ? "Brief for your AI" : "Code"}>
          {view === "brief" ? brief : code.code}
        </pre>
      </section>

      <section className="ig-step" aria-labelledby="ig-h5">
        <h2 className="ig-h" id="ig-h5">
          <span>05</span>Reference
        </h2>
        <details className="ig-ref" open>
          <summary>Addresses</summary>
          <dl className="ig-addrs">
            {(
              [
                ["Ratings API", VIGIL.apiRatings],
                ["Run archive", VIGIL.apiRuns],
                [`RiskRegistry · ${VIGIL.network}`, VIGIL.registryId],
                [`RiskGate · ${VIGIL.network}`, VIGIL.guardId],
                ["Rated testnet demo pool", VIGIL.demoPoolId],
                ["RPC", VIGIL.rpcUrl],
              ] as const
            ).map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>
                  <code>{v}</code>
                  <CopyButton text={v} />
                </dd>
              </div>
            ))}
          </dl>
        </details>
        <details className="ig-ref">
          <summary>RiskGate errors</summary>
          <p className="rg-note">A refused call fails with Error(Contract, #code).</p>
          <div className="ig-errors">
            {RISKGATE_ERRORS.map(([c, name, meaning]) => (
              <div key={c}>
                <code>{c}</code>
                <b>{name}</b>
                <span>{meaning}</span>
              </div>
            ))}
          </div>
        </details>
        <details className="ig-ref">
          <summary>Limits today</summary>
          <ul className="ig-list">
            <li>
              The registry and RiskGate are on {VIGIL.network}. A mainnet contract cannot call them yet; on mainnet, read
              the API or the {VIGIL.network} registry from your backend.
            </li>
            <li>
              One publisher signs the ratings (threshold {VIGIL.threshold}). The registry takes up to 16 and returns their
              median.
            </li>
            <li>RiskGate guards Blend pool calls and token transfers; it refuses DeFindex vault calls.</li>
            <li>There is no published SDK: the code uses @stellar/stellar-sdk or soroban-sdk directly.</li>
          </ul>
        </details>
        <p className="rt-foot ig-foot">
          Everything on this page as Markdown: <a href="/integrate.md">/integrate.md</a>. How a score is made: the{" "}
          <a href={VIGIL.methodology} target="_blank" rel="noreferrer">
            methodology
          </a>
          . Every contract function, event and encoding: the{" "}
          <a href={VIGIL.contractsReadme} target="_blank" rel="noreferrer">
            contracts reference
          </a>
          .
        </p>
      </section>
    </main>
  );
}
