"use client";

import { useEffect, useRef, useState } from "react";
import {
  checkRating,
  flowFor,
  liveCodeFor,
  outcomeFor,
  type CheckId,
  type OnchainRating,
} from "../../lib/integrate/callFlow";
import { callRegistry, short, type RegistryCall, type RegistryRead } from "../../lib/integrate/registryCall";
import { VIGIL, depositVerdict, type PathId, type VerdictRating, type Where } from "../../lib/integrate/facts";

export interface CallPool extends VerdictRating {
  protocol: "blend" | "defindex";
}

const CONTRACT_URL = `https://stellar.expert/explorer/${VIGIL.network}/contract/${VIGIL.registryId}`;
const ADDRESS = /^C[A-Z2-7]{55}$/;

/** ①…④ light in turn: caller, check, registry, answer. 0 is idle. */
type Lit = 0 | 1 | 2 | 3 | 4;

function rustValue(v: OnchainRating | null): string {
  return v ? `Some(Rating { score: ${v.score}, publishers: ${v.publishers}, timestamp: ${v.timestamp} })` : "None";
}

function prettyBody(body: string): string {
  return JSON.stringify(JSON.parse(body), null, 2);
}

const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const pause = (ms: number) => (reducedMotion() ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)));

/** One pool per outcome at the current minimum, for the "Try" chips. */
function tryPools(pools: CallPool[], minScore: number) {
  const byScore = [...pools].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const v = (p: CallPool) => depositVerdict(p, minScore);
  return [
    ["allowed", byScore.find((p) => v(p).allowed)],
    ["under your minimum", byScore.find((p) => p.eligibleForDeposit && p.score !== null && !v(p).allowed)],
    ["held back (registry signs 0)", byScore.find((p) => p.score !== null && !p.eligibleForDeposit)],
    ["not rated (None)", byScore.find((p) => p.score === null)],
  ].filter((x): x is [string, CallPool] => Boolean(x[1]));
}

function OtherReads() {
  const [rows, setRows] = useState<Record<string, string>>({});
  const reads: Array<[RegistryRead, string]> = [
    [{ fn: "publishers" }, "Who may publish ratings"],
    [{ fn: "threshold" }, "Fresh submissions get_rating needs"],
    [{ fn: "max_age" }, "Seconds a submission counts for"],
  ];
  async function run(read: RegistryRead) {
    setRows((r) => ({ ...r, [read.fn]: "simulating on testnet…" }));
    try {
      const res = await callRegistry(read);
      const value = Array.isArray(res.value) ? `[${res.value.join(", ")}]` : String(res.value);
      setRows((r) => ({ ...r, [read.fn]: `${value} · ledger ${res.latestLedger} · ${res.ms} ms` }));
    } catch (e) {
      setRows((r) => ({ ...r, [read.fn]: (e as Error).message }));
    }
  }
  return (
    <details className="ig-ref ig-reads">
      <summary>The registry&rsquo;s other reads</summary>
      <div className="ig-errors">
        {reads.map(([read, what]) => (
          <div key={read.fn}>
            <button type="button" className="ig-btn" onClick={() => void run(read)}>
              {read.fn}()
            </button>
            <b>{what}</b>
            <span className="ig-read-out">{rows[read.fn] ?? "—"}</span>
          </div>
        ))}
      </div>
    </details>
  );
}

export default function IntegrateLiveCall({
  path,
  where,
  minScore,
  maxAge,
  pool,
  pools,
  onPickPool,
}: {
  path: PathId;
  where: Where;
  minScore: number;
  maxAge: number;
  /** The pool from step 02, or null before the live ratings load. */
  pool: CallPool | null;
  pools: CallPool[];
  onPickPool: (poolId: string) => void;
}) {
  const [address, setAddress] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [lit, setLit] = useState<Lit>(0);
  const [call, setCall] = useState<RegistryCall<OnchainRating | null> | null>(null);
  const [calledAt, setCalledAt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const run = useRef(0);
  const pendingAuto = useRef(false);

  const target = address ?? pool?.poolId ?? null;
  const targetName = address ? "Pasted address" : pool?.name ?? "";
  const flow = flowFor(path, where);
  const code = liveCodeFor(path, where);
  const busy = lit > 0 && lit < 4;

  // Picking a pool in step 02 replaces a pasted address.
  useEffect(() => setAddress(null), [pool?.poolId]);

  // A new target or path is a new call: clear the old answer.
  useEffect(() => {
    run.current++;
    setLit(0);
    setCall(null);
    setError(null);
  }, [target, path, where]);

  async function callNow(poolId: string) {
    const id = ++run.current;
    setError(null);
    setCall(null);
    setLit(1);
    await pause(350);
    if (run.current !== id) return;
    setLit(2);
    await pause(350);
    if (run.current !== id) return;
    setLit(3);
    try {
      const [res] = await Promise.all([callRegistry({ fn: "get_rating", pool: poolId }), pause(300)]);
      if (run.current !== id) return;
      setCall(res);
      setCalledAt(Math.floor(Date.now() / 1000));
      setLit(4);
    } catch (e) {
      if (run.current !== id) return;
      setError((e as Error).message);
      setLit(0);
    }
  }

  // A "Try" chip picks a pool and calls it once the pick has landed.
  useEffect(() => {
    if (pendingAuto.current && target) {
      pendingAuto.current = false;
      void callNow(target);
    }
  });

  if (!flow || !code) return null;

  const check = call ? checkRating(call.value, { path, minScore, maxAgeSecs: maxAge, nowSecs: calledAt }) : null;
  const byCheck = new Map(check?.checks.map((c) => [c.id, c]) ?? []);
  const lineClass = (step?: number, chk?: CheckId) => {
    if (chk && check) return `ig-line ig-line--${byCheck.get(chk)!.state}`;
    if (step && lit > 0 && lit < 4 && step === lit) return "ig-line ig-line--lit";
    if (step && lit === 4) return "ig-line ig-line--done";
    return "ig-line";
  };
  const node = (n: 1 | 2 | 3) => `ig-node${lit === n ? " ig-node--lit" : lit > n ? " ig-node--done" : ""}`;
  const chips = tryPools(pools, minScore);

  return (
    <div className="ig-call">
      <ol className="ig-flow" aria-label="Where the check runs">
        {flow.nodes.map((nd, i) => (
          <li key={nd.title} className={node((i + 1) as 1 | 2 | 3)}>
            <span className="ig-node-n">{["①", "②", "③"][i]}</span>
            <b>{nd.title}</b>
            <code>{nd.sub}</code>
          </li>
        ))}
      </ol>
      <p className={`ig-return${lit === 4 ? " ig-return--on" : ""}${check && !check.allowed ? " ig-return--fail" : ""}`} aria-live="polite">
        <span className="ig-node-n">④</span>
        {lit === 4 && call && check ? (
          <>
            <code>← {rustValue(call.value)}</code>
            <span>{outcomeFor(path, where, check)}</span>
          </>
        ) : lit === 3 ? (
          <span>simulating on {VIGIL.network}…</span>
        ) : (
          <span>the answer comes back here</span>
        )}
      </p>

      <div className="ig-call-grid">
        <div className="ig-call-side">
          <span className="rg-kicker">{pool?.protocol === "defindex" && !address ? "DeFindex strategy" : address ? "Any address" : "Blend pool"}</span>
          <span className="rg-name">{targetName || "Waiting for the live ratings…"}</span>
          {target && <code className="ig-addr">{target}</code>}
          <div className="ig-call-actions">
            <button type="button" className="ig-btn ig-btn--hi" disabled={!target || busy} onClick={() => target && void callNow(target)}>
              {busy ? "Calling…" : `Call get_rating on ${VIGIL.network}`}
            </button>
          </div>
          {chips.length > 0 && (
            <div className="ig-try">
              <span className="rg-kicker">Try</span>
              {chips.map(([label, p]) => (
                <button
                  key={label}
                  type="button"
                  className="ig-inline"
                  disabled={busy}
                  onClick={() => {
                    setAddress(null);
                    onPickPool(p.poolId);
                    pendingAuto.current = true;
                  }}
                >
                  {label}: {p.name}
                </button>
              ))}
            </div>
          )}
          <form
            className="ig-paste"
            onSubmit={(e) => {
              e.preventDefault();
              const a = typed.trim();
              if (!ADDRESS.test(a)) return setError("Paste a contract address: C followed by 55 characters.");
              setAddress(a);
              pendingAuto.current = true;
            }}
          >
            <input
              className="ig-input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="or paste any pool address (C…)"
              spellCheck={false}
              aria-label="Pool contract address"
            />
            <button type="submit" className="ig-btn" disabled={busy}>
              Call
            </button>
          </form>
          {error && <p className="ig-call-err">{error}</p>}

          <span className="rg-kicker ig-sent-k">Sent from your browser</span>
          {call ? (
            <>
              <p className="ig-sent">
                POST {call.url}
                <br />
                an unsigned transaction calling {short(VIGIL.registryId)}.{call.signature}. Simulated, never sent; no wallet, no
                fee.
              </p>
              <pre className="ig-pre ig-pre--wrap ig-pre--sm">{prettyBody(call.body)}</pre>
              <span className="rg-kicker">Returned</span>
              <pre className="ig-pre ig-pre--sm">{rustValue(call.value)}</pre>
              <p className="ig-sent">
                ledger {call.latestLedger} · {call.ms} ms ·{" "}
                <a href={CONTRACT_URL} target="_blank" rel="noreferrer">
                  the registry on stellar.expert ↗
                </a>
              </p>
            </>
          ) : (
            <p className="ig-sent">
              The request appears here: a simulateTransaction your browser sends to {VIGIL.rpcUrl}. {flow.stands}
            </p>
          )}
        </div>

        <div className="ig-call-code">
          <span className="rg-kicker">{code.label}</span>
          <pre className="ig-pre ig-code" tabIndex={0} aria-label={code.label}>
            {code.lines.map((l, i) => {
              const c = l.check && check ? byCheck.get(l.check) : null;
              const indent = l.text.match(/^\s*/)![0];
              return (
                <span key={i} className="ig-line-wrap">
                  <span className={lineClass(l.step, l.check)}>{l.text || " "}</span>
                  {c && (
                    <span className={`ig-line ig-anno ig-line--${c.state}`}>
                      {indent}
                      {c.state === "pass" ? "✓" : c.state === "fail" ? "✕" : "·"} {c.note}
                    </span>
                  )}
                </span>
              );
            })}
          </pre>
          <p className="rg-note">
            The constants come from step 02: minimum {minScore}, maximum age {maxAge / 3600} h.{" "}
            {path === "riskgate"
              ? `On-chain enforcement works on ${VIGIL.network} only, against YieldPilot's demo pool.`
              : `The registry is on ${VIGIL.network} and holds the mainnet pools' scores, so a backend can read it today.`}
          </p>
        </div>
      </div>
      <OtherReads />
    </div>
  );
}
