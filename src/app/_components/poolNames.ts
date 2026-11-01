// How a scanned pool is named on the plate and in the reading area.

import type { ApiScoredPool } from "./types";
import { stroopsToUsdc, truncateAddress } from "./format";

export function protocolLabel(p: Pick<ApiScoredPool, "protocol">): string {
  if (p.protocol === "blend") return "Blend";
  if (p.protocol === "defindex") return "DeFindex";
  return p.protocol;
}

/** "Fixed", "USDC Fixed" — the pool's own name without its protocol prefix. */
export function poolTitle(p: Pick<ApiScoredPool, "name" | "poolId">): string {
  if (!p.name || /^[CG][A-Z0-9]{30,}$/.test(p.name)) return truncateAddress(p.poolId, 4, 4);
  return p.name.replace(/^DeFindex\s+/i, "").replace(/^Blend\s+/i, "").trim() || truncateAddress(p.poolId, 4, 4);
}

/** "Blend · Fixed" */
export function routeName(p: Pick<ApiScoredPool, "protocol" | "name" | "poolId">): string {
  return `${protocolLabel(p)} · ${poolTitle(p)}`;
}

/** Summit label: "FIXED", "DFX FIXED", "DFX EURC FIXED". */
export function shortLabel(p: Pick<ApiScoredPool, "protocol" | "name" | "poolId">): string {
  const t = poolTitle(p).toUpperCase();
  return p.protocol === "defindex" ? `DFX ${t.replace(/^USDC\s+/, "")}` : t;
}

/** "$1.92M", "$640k" from decimal stroops. */
export function tvlCompact(stroops: string): string {
  const v = stroopsToUsdc(stroops);
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${Math.round(v / 1e3)}k`;
  return `$${v}`;
}
