"use client";

import type { ReactNode } from "react";
import type { ApiScoredPool } from "../types";
import type { AgentTx } from "../format";
import { formatApy, formatTimeAgo, truncateAddress } from "../format";
import { FREIGHTER_INSTALL_URL, testnetTxUrl } from "../links";
import { routeName } from "../poolNames";
import { usdc2 } from "../../../lib/voice";

const big = (s: string | null | undefined) => {
  try { return BigInt(s ?? "0"); } catch { return 0n; }
};

/** Holder: the one number that matters, where it works, and the last supplies. */
export function HolderView({ supplied, idle, route, riskCap, cold, txs, agent }: {
  supplied: string;
  idle: string | null;
  route: ApiScoredPool | null;
  riskCap: number;
  cold: boolean;
  txs: AgentTx[];
  agent: ReactNode;
}) {
  const s = big(supplied), i = big(idle);
  const where = route ? <b>{routeName(route).replace(/ /g, " ")}</b> : null;
  const apy = route ? <b>{formatApy(route.apyBps)}</b> : null;
  let lede: ReactNode;
  if (cold) lede = <>{usdc2((s + i).toString())} USDC waits in your smart account until the first survey finishes.</>;
  else if (!route) lede = <>No pool clears your risk cap of <b>{riskCap}</b> right now, so the agent holds.</>;
  else if (s === 0n && i === 0n) lede = <>Your smart account holds no USDC yet.</>;
  else if (s === 0n) lede = <>All of it is idle. The agent supplies it to {where} on its next tick.</>;
  else if (i > 0n) lede = <><b>{usdc2(supplied)}</b> earning {apy} a year in {where}. <b>{usdc2(idle)}</b> idle, supplied on the next tick.</>;
  else lede = <>Earning {apy} a year in {where}, the best route under your risk cap of <b>{riskCap}</b>.</>;

  return (
    <section className="view" aria-label="Your position">
      <div>
        <h6 className="k">Your position</h6>
        <div className="big">{usdc2((s + i).toString())}<em>USDC</em></div>
        <p className="lede">{lede}</p>
        {txs.length > 0 && (
          <ul className="ledger">
            {txs.slice(0, 3).map((t) => (
              <li key={t.hash}>
                <b>+{usdc2(t.amountStroops)} USDC</b>
                <span>{formatTimeAgo(t.ts)}</span>
                <a href={testnetTxUrl(t.hash)} target="_blank" rel="noreferrer">{truncateAddress(t.hash, 4, 4)} ↗</a>
              </li>
            ))}
          </ul>
        )}
      </div>
      {agent}
    </section>
  );
}

/** Visitor: the best safe yield right now, and the one thing to do about it. */
export function VisitorView({ route, installed, connecting, error, onConnect, agent }: {
  route: ApiScoredPool | null;
  installed: boolean | null;
  connecting: boolean;
  error: string | null;
  onConnect: () => void;
  agent: ReactNode;
}) {
  return (
    <section className="view" aria-label="Overview">
      <div>
        <h6 className="k">Best safe yield right now</h6>
        <div className="big">{route ? formatApy(route.apyBps) : "—"}<em>APY</em></div>
        <p className="lede">
          Every USDC pool on Stellar, watched. Your idle balance goes to the best one under the risk you choose,
          and never leaves your own smart account.
        </p>
        {installed === false ? (
          <a className="cta" href={FREIGHTER_INSTALL_URL} target="_blank" rel="noreferrer">Install Freighter to begin ↗</a>
        ) : (
          <button className="cta" onClick={onConnect} disabled={connecting}>
            {connecting ? "Connecting…" : "Connect Freighter to begin →"}
          </button>
        )}
        {error && <p className="err">{error}</p>}
      </div>
      {agent}
    </section>
  );
}

/** Connected, registration lookup in flight. */
export function CheckingView({ agent }: { agent: ReactNode }) {
  return (
    <section className="view" aria-label="Your position">
      <div>
        <h6 className="k">Your position</h6>
        <div className="big">—<em>USDC</em></div>
        <p className="lede">Checking your account…</p>
      </div>
      {agent}
    </section>
  );
}
