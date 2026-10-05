"use client";

import type { AgentStatus } from "../../../lib/voice";
import { formatTimeAgo, formatUntil, truncateAddress } from "../format";
import { testnetTxUrl } from "../links";
import type { PlatePhase } from "../plate/Plate";

interface Props {
  status: AgentStatus;
  phase: PlatePhase;
  now: number;
  nextTickAt: number | null;
  scanUpdatedAt: number | null;
  lastOkAt: number;
  poolCount: number;
  protocolCount: number;
}

/** The agent speaks for itself: its state, one sentence, and when it acts next. */
export default function AgentBlock({ status, phase, now, nextTickAt, scanUpdatedAt, lastOkAt, poolCount, protocolCount }: Props) {
  let meta: React.ReactNode;
  if (phase === "offline") {
    meta = <>Last contact <b>{lastOkAt ? formatTimeAgo(lastOkAt / 1000, now) : "never"}</b> · retrying every 3s</>;
  } else if (phase === "cold") {
    meta = <>First survey · <b>about a minute</b></>;
  } else {
    meta = (
      <>
        {nextTickAt != null && <>Next tick <b>{formatUntil(nextTickAt, now)}</b> · </>}
        {scanUpdatedAt != null && <>scanned <b>{formatTimeAgo(scanUpdatedAt / 1000, now)}</b> · </>}
        {poolCount} pools · {protocolCount} protocol{protocolCount === 1 ? "" : "s"}
      </>
    );
  }
  return (
    <div className="agent">
      <h6 className="k">
        Agent <span className="state"><i />{status.state}</span>
      </h6>
      <p className="voice" key={status.voice}>
        “{status.voice}”{" "}
        {status.hash && (
          <a href={testnetTxUrl(status.hash)} target="_blank" rel="noreferrer">{truncateAddress(status.hash, 4, 4)} ↗</a>
        )}
      </p>
      <p className="meta">{meta}</p>
    </div>
  );
}
