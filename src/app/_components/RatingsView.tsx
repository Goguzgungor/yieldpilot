"use client";

import { Fragment, useEffect, useState } from "react";
import { truncateAddress } from "./format";
import { stellarExpertUrl } from "./links";

// Shape of GET /api/ratings (src/lib/vigil/types.ts PoolRating, JSON-serialized).
interface Factor {
  key: string;
  value: number;
  weight: number;
  contribution: number;
  raw?: number | string | null;
  note: string;
}

interface Yield {
  assetId: string;
  symbol: string;
  supplyApr: number;
  borrowApr: number | null;
  suppliedUsd: number | null;
}

interface GradePath {
  target: "A" | "B";
  already: boolean;
  reachable: boolean;
  levers: string[];
  steps: string[];
  score: number | null;
  grade: string | null;
  blocker?: string;
}

interface Rating {
  poolId: string;
  name: string;
  protocol: "blend" | "defindex";
  score: number;
  uncappedScore?: number;
  grade: "A" | "B" | "C" | "D" | "E";
  status: number;
  statusLabel: string;
  eligibleForDeposit: boolean;
  factors: Factor[];
  reasons: string[];
  hardRules: string[];
  tvlUsd: number;
  reasonsHash: string;
  engineVersion: string;
  underlying?: string;
  yields?: Yield[];
  paths?: { A: GradePath; B: GradePath };
}

interface RatingsResponse {
  engineVersion: string;
  computedAt: number;
  cachedAt: number;
  stale: boolean;
  coverage: { poolsFound: number; rated: number; failed: { id: string; error: string }[] };
  ratings: Rating[];
  methodology: string;
  error?: string;
}

/** Grade bands from src/lib/vigil/score.ts GRADE_BANDS (lower bound of each). */
const BANDS: Array<[number, Rating["grade"]]> = [
  [80, "A"],
  [65, "B"],
  [50, "C"],
  [35, "D"],
  [0, "E"],
];

const FACTOR_LABELS: Record<string, string> = {
  pool_status: "Pool status",
  oracle_source: "Price source",
  oracle_freshness: "Price freshness",
  sdex_manipulation: "Price manipulation cost",
  backstop_coverage: "Backstop cover",
  utilization: "Utilization",
  collateral_concentration: "Collateral concentration",
  supply_caps: "Supply caps",
  underlying_pool: "Underlying pool",
};

/** Band centres for the scale letters (a letter labels its band, not its edge). */
const BAND_LABELS: Array<[number, Rating["grade"]]> = [
  [90, "A"],
  [72.5, "B"],
  [57.5, "C"],
  [42.5, "D"],
  [17.5, "E"],
];

/**
 * The engine's hard rules (src/lib/vigil/score.ts) in plain words, most severe
 * first, so the table leads with the reason that matters most.
 */
const RULES: Array<{ code: string; text: (rule: string) => string }> = [
  { code: "HR3", text: () => "Collateral price can be pushed cheaply on SDEX; borrowing against it would be profitable" },
  { code: "HR2", text: () => "A collateral price is missing or stale" },
  { code: "HR5", text: () => "A collateral price source could not be identified" },
  {
    code: "HR1",
    text: (rule) => {
      const status = Number(rule.match(/status (\d)/)?.[1]);
      if (status === 2 || status === 3) return "Pool is on ice: Blend has disabled borrowing";
      if (status === 4 || status === 5) return "Pool is frozen: Blend has disabled deposits";
      if (status === 6) return "Pool was never activated (setup)";
      return "Pool is not active";
    },
  },
  { code: "HR4", text: () => "Overall score is below 50" },
  { code: "HR6", text: () => "A collateral is priced by a weak source; an A needs robust feeds on every collateral" },
];

function mainReason(r: Rating): string {
  const viaPool = (t: string) =>
    r.protocol !== "defindex" ? t : t.startsWith("Pool ") ? `Underlying pool ${t.slice(5)}` : `Underlying pool: ${t}`;
  const rules = r.hardRules.length
    ? r.hardRules
    : r.reasons.filter((x) => /HR\d/.test(x)).map((x) => x.replace(/^underlying: /, ""));
  for (const { code, text } of RULES) {
    const hit = rules.find((x) => x.startsWith(code) || x.includes(`${code} `));
    if (hit) return viaPool(text(hit));
  }
  return viaPool(r.reasons[0]?.replace(/^underlying: /, "") ?? "");
}

function usd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

/** One-line summary for the table: how far B and A are. */
function pathSummary(r: Rating): string | null {
  const p = r.paths;
  if (!p) return null;
  const one = (g: GradePath) =>
    g.already ? `${g.target}: already` : g.reachable ? `${g.target}: ${g.steps.length} change${g.steps.length === 1 ? "" : "s"}` : `${g.target}: out of reach`;
  return p.A.already ? "Rated A" : `${one(p.B)} · ${one(p.A)}`;
}

function PathBlock({ path, label }: { path: GradePath; label: string }) {
  if (path.already) return null;
  return (
    <div className="rt-path">
      <div className="rt-path-head">{label}</div>
      {path.reachable ? (
        <>
          <ol>
            {path.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <div className="rt-path-result">
            The engine would then give {path.score} ({path.grade}).
          </div>
        </>
      ) : (
        <div className="rt-path-result">Out of reach. {path.blocker}</div>
      )}
    </div>
  );
}

function Paths({ r }: { r: Rating }) {
  const p = r.paths;
  if (!p || p.A.already) return null;
  const same = p.B.reachable && p.A.reachable && p.B.levers.join() === p.A.levers.join();
  return (
    <>
      <div className="rt-h">
        What would raise this rating{r.protocol === "defindex" ? " (changes in the underlying pool)" : ""}
      </div>
      <div className="rt-paths">
        {same ? (
          <PathBlock path={p.A} label={p.B.already ? "To reach A (80+)" : "To reach B and A (80+)"} />
        ) : (
          <>
            <PathBlock path={p.B} label="To reach B (65+)" />
            <PathBlock path={p.A} label="To reach A (80+)" />
          </>
        )}
      </div>
    </>
  );
}

function pct(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}

function when(epochSec: number): string {
  return new Date(epochSec * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** One pool on the screen: a 0–100 track with the final score and, when a rule capped it, the score before. */
function Track({ r }: { r: Rating }) {
  const uncapped = r.uncappedScore ?? r.score;
  const capped = uncapped > r.score;
  return (
    <div className="rt-track-row">
      <div className="rt-track-name">
        {r.name}
        <span className="rt-track-sub">{r.protocol === "defindex" ? "DeFindex" : truncateAddress(r.poolId, 4, 4)}</span>
      </div>
      <div
        className="rt-track"
        role="img"
        aria-label={`${r.name}: score ${r.score}${capped ? `, ${uncapped} before hard rules` : ""}, grade ${r.grade}`}
      >
        {BANDS.slice(0, 4).map(([min]) => (
          <span key={min} className="rt-band-tick" style={{ left: `${min}%` }} />
        ))}
        {capped && (
          <span className="rt-cap" style={{ left: `${r.score}%`, width: `${uncapped - r.score}%` }} />
        )}
        {capped && <span className="rt-ghost" style={{ left: `${uncapped}%` }} />}
        <span className={`rt-dot rt-g-${r.grade}`} style={{ left: `${r.score}%` }} />
      </div>
      <div className={`rt-track-grade rt-g-${r.grade}`}>{r.grade}</div>
    </div>
  );
}

function Detail({ r }: { r: Rating }) {
  return (
    <div className="rt-detail">
      {r.hardRules.length > 0 && (
        <div className="rt-rules">
          <div className="rt-h">Hard rules that capped this rating</div>
          <ul>
            {r.hardRules.map((h) => (
              <li key={h}>
                {h}
              </li>
            ))}
          </ul>
        </div>
      )}
      <Paths r={r} />
      {r.yields && r.yields.length > 0 && (
        <>
          <div className="rt-h">{r.protocol === "defindex" ? "Rate in the underlying pool (before DeFindex fees)" : "Current rates"}</div>
          <div className="rt-rates">
            <span className="rt-rates-head">Asset</span>
            <span className="rt-rates-head">Supply APR</span>
            <span className="rt-rates-head">Borrow APR</span>
            <span className="rt-rates-head">Supplied</span>
            {r.yields.map((y) => (
              <Fragment key={y.assetId}>
                <span>{y.symbol}</span>
                <span>{pct(y.supplyApr)}</span>
                <span>{y.borrowApr === null ? "—" : pct(y.borrowApr)}</span>
                <span>{y.suppliedUsd === null ? "—" : usd(y.suppliedUsd)}</span>
              </Fragment>
            ))}
          </div>
        </>
      )}
      <div className="rt-h">Factors</div>
      <div className="rt-factors">
        {r.factors.map((f) => (
          <Fragment key={f.key}>
            <div className="rt-f-name">
              {FACTOR_LABELS[f.key] ?? f.key}
              <span className="rt-f-weight">{Math.round(f.weight * 100)}%</span>
            </div>
            <div className="rt-f-bar" aria-hidden="true">
              <span style={{ width: `${f.value}%` }} />
            </div>
            <div className="rt-f-val">{f.value}</div>
            <div className="rt-f-note">{f.note}</div>
          </Fragment>
        ))}
      </div>
      <div className="rt-hash">
        reasonsHash <code>{r.reasonsHash}</code>
        {r.protocol === "blend" && (
          <a href={stellarExpertUrl(r.poolId)} target="_blank" rel="noreferrer">
            Pool on Stellar Expert ↗
          </a>
        )}
      </div>
    </div>
  );
}

export default function RatingsView() {
  const [data, setData] = useState<RatingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/ratings", { cache: "no-store" })
      .then(async (res) => {
        const body = (await res.json()) as RatingsResponse;
        if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
        if (!cancelled) setData(body);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, []);

  const ratings = data ? [...data.ratings].sort((a, b) => b.score - a.score || b.tvlUsd - a.tvlUsd) : [];
  const pools = ratings.filter((r) => r.protocol === "blend");
  const open_ = pools.filter((r) => r.eligibleForDeposit).length;

  return (
    <main className="rt-page">
      <header className="rt-head">
        <a href="/" className="rt-back">
          YieldPilot
        </a>
        <h1 className="rt-title">Pool risk ratings</h1>
        <p className="rt-lede">
          Every Blend V2 pool on Stellar mainnet and the DeFindex strategies that deposit into them, rated from on-chain
          configuration: who prices each collateral, what the backstop can cover, pool status and reserve settings.
          Higher is safer. A pool below grade C, or in any hard-rule state, should not receive new deposits.
        </p>
      </header>

      {!data && !error && (
        <div className="rt-screen rt-wait">
          Reading every Blend pool from mainnet. The first load of the hour takes about a minute and a half.
        </div>
      )}
      {error && (
        <div className="rt-screen rt-wait">
          Ratings could not be loaded: {error}. Reload the page to try again.
        </div>
      )}

      {data && (
        <>
          <section className="rt-screen" aria-label="Scores">
            <div className="rt-readout">
              <span>
                {open_} of {pools.length} Blend pools accept deposits under Vigil
              </span>
              <span className="rt-legend">
                <span className="rt-dot rt-dot--legend" /> score
                <span className="rt-ghost rt-ghost--legend" /> before hard rules
              </span>
            </div>
            <div className="rt-scale" aria-hidden="true">
              {BAND_LABELS.map(([centre, g]) => (
                <span key={g} style={{ left: `${centre}%` }}>
                  {g}
                </span>
              ))}
            </div>
            {ratings.map((r) => (
              <Track key={r.poolId} r={r} />
            ))}
          </section>

          <section className="rt-table" aria-label="Ratings">
            <div className="rt-row rt-row--head">
              <span>Pool</span>
              <span>Status</span>
              <span>Grade</span>
              <span>Score</span>
              <span>Deposits</span>
              <span>Supplied</span>
              <span>Best supply APR</span>
              <span>Main reason</span>
            </div>
            {ratings.map((r) => {
              const isOpen = open === r.poolId;
              return (
                <Fragment key={r.poolId}>
                  <button
                    type="button"
                    className={isOpen ? "rt-row rt-row--open" : "rt-row"}
                    aria-expanded={isOpen}
                    onClick={() => setOpen(isOpen ? null : r.poolId)}
                  >
                    <span className="rt-pool">
                      {r.name}
                      <small>{r.protocol === "defindex" ? "DeFindex strategy" : truncateAddress(r.poolId, 4, 4)}</small>
                    </span>
                    <span>{r.statusLabel.replace(/_/g, " ")}</span>
                    <span className={`rt-grade rt-g-${r.grade}`}>{r.grade}</span>
                    <span>
                      {r.score}
                      {r.uncappedScore !== undefined && r.uncappedScore > r.score && (
                        <small> / {r.uncappedScore}</small>
                      )}
                    </span>
                    <span className={r.eligibleForDeposit ? "rt-yes" : "rt-no"}>
                      {r.eligibleForDeposit ? "Allowed" : "Blocked"}
                    </span>
                    <span>{usd(r.tvlUsd)}</span>
                    <span>
                      {r.yields && r.yields.length > 0 ? (
                        <>
                          {pct(r.yields[0].supplyApr)}
                          <small> {r.yields[0].symbol}</small>
                        </>
                      ) : (
                        "—"
                      )}
                    </span>
                    <span className="rt-reason">
                      {mainReason(r)}
                      {pathSummary(r) && <small className="rt-reason-path">{pathSummary(r)}</small>}
                    </span>
                  </button>
                  {isOpen && <Detail r={r} />}
                </Fragment>
              );
            })}
          </section>

          <footer className="rt-foot">
            Computed {when(data.computedAt)} from mainnet: {data.coverage.rated} of {data.coverage.poolsFound} pools
            {data.coverage.failed.length ? ` (${data.coverage.failed.length} unreadable)` : ""}, engine{" "}
            {data.engineVersion}.{data.stale && " The latest refresh failed, so this is the last good run."} Read the{" "}
            <a href={data.methodology} target="_blank" rel="noreferrer">
              methodology
            </a>{" "}
            or use the{" "}
            <a href="/api/ratings">
              JSON API
            </a>
            .
          </footer>
        </>
      )}
    </main>
  );
}
