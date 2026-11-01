"use client";

import type { ApiScoredPool } from "../types";
import { formatApy, formatPct, truncateAddress } from "../format";
import { blendPoolUrl, stellarExpertUrl } from "../links";
import { poolTitle, protocolLabel, tvlCompact } from "../poolNames";

/** A summit, read like a survey entry: what it pays, how risky it is, and why the agent does or doesn't go there. */
export default function PoolView({ pool, route, holding, riskCap, rationale, onBack }: {
  pool: ApiScoredPool;
  route: ApiScoredPool | null;
  holding: boolean;
  riskCap: number;
  rationale: string | null;
  onBack: () => void;
}) {
  const isRoute = route?.poolId === pool.poolId;
  const chip = isRoute ? (holding ? "ELIGIBLE · YOUR ROUTE" : "ELIGIBLE · AGENT ROUTE") : pool.eligible ? "ELIGIBLE" : "EXCLUDED";
  let verdict: React.ReactNode;
  if (isRoute) {
    verdict = <>The highest yield under your risk cap of <b>{riskCap}</b>. {holding ? "Your USDC is supplied here." : "The agent routes idle USDC here."}</>;
  } else if (pool.eligible) {
    const gap = route ? ((route.apyBps - pool.apyBps) / 100).toFixed(2) : null;
    verdict = gap ? <>Eligible, <b>{gap} points</b> below the current route.</> : <>Eligible.</>;
  } else {
    verdict = <>Excluded: {pool.reason ?? "not eligible"}. The agent does not supply here.</>;
  }
  const kind = pool.protocol === "blend" ? "lending pool" : pool.protocol === "defindex" ? "strategy" : "pool";

  return (
    <section className="view" aria-label={`${protocolLabel(pool)} ${poolTitle(pool)}`}>
      <div>
        <h6 className="k">
          <button className="back" onClick={onBack}>← Overview</button>
          <span>{protocolLabel(pool)} · {kind}</span>
          <span className={pool.eligible ? "chip" : "chip fog"}>{chip}</span>
        </h6>
        <div className="ptitle">{poolTitle(pool)}<em>{formatApy(pool.apyBps)} APY</em></div>
        <p className="lede">{verdict}</p>
        <p className="links">
          {pool.protocol === "blend" && <a href={blendPoolUrl(pool.poolId)} target="_blank" rel="noreferrer">Open on Blend ↗</a>}
          <a href={stellarExpertUrl(pool.poolId)} target="_blank" rel="noreferrer">stellar.expert ↗</a>
          <span>{truncateAddress(pool.poolId, 8, 8)}</span>
        </p>
      </div>
      <div>
        <dl className="metrics">
          <div><dt>TVL</dt><dd>{tvlCompact(pool.tvlUsdc)}</dd></div>
          <div><dt>Utilization</dt><dd>{formatPct(pool.utilizationBps)}</dd></div>
          <div><dt>Oracle</dt><dd>{pool.oracleHealthy ? "Healthy" : "Flagged"}</dd></div>
          <div><dt>Risk</dt><dd>{pool.riskScore} / 100</dd></div>
        </dl>
        <div className="ruler" aria-label={`Risk ${pool.riskScore} of 100, cap ${riskCap}`}>
          {[0, 25, 50, 75, 100].map((v) => <span key={v} className="t" style={{ left: `${v}%` }}><span>{v}</span></span>)}
          <span className="rcap" style={{ left: `${riskCap}%` }}><span>CAP {riskCap}</span></span>
          <span className={pool.eligible ? "dot" : "dot fog"} style={{ left: `${Math.min(100, pool.riskScore)}%` }} />
        </div>
        {isRoute && rationale && (
          <div className="rationale"><b>◆ AGENT RATIONALE</b>{rationale}</div>
        )}
      </div>
    </section>
  );
}
