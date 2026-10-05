// Pure formatting helpers shared across the Living Network UI. USDC amounts are
// 7-decimal stroops stored as decimal strings (BigInt-safe).

import type { ActivityEntry } from "./types";

const STROOPS_PER_USDC = 10_000_000n;

/** Parse a stroop decimal string into a whole-USDC number (floored). */
export function stroopsToUsdc(stroops: string | null | undefined): number {
  if (!stroops) return 0;
  try {
    return Number(BigInt(stroops) / STROOPS_PER_USDC);
  } catch {
    return 0;
  }
}

/** "1,000" — grouped integer USDC from stroops. */
export function formatUsdc(stroops: string | null | undefined): string {
  return stroopsToUsdc(stroops).toLocaleString("en-US");
}

/** "$1,234,567" — grouped dollar TVL from stroops (no cents). */
export function formatTvl(stroops: string | null | undefined): string {
  return "$" + stroopsToUsdc(stroops).toLocaleString("en-US");
}

/** basis points -> "8.23%". */
export function formatApy(apyBps: number): string {
  return (apyBps / 100).toFixed(2) + "%";
}

/** basis points -> "90%". */
export function formatPct(bps: number): string {
  return Math.round(bps / 100) + "%";
}

/** G ABCD…WXYZ — truncate a Stellar G…/C… address for chrome. */
export function truncateAddress(addr: string | null | undefined, head = 4, tail = 4): string {
  if (!addr) return "";
  if (addr.length <= head + tail + 1) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

/**
 * "BLEND · CDMA…FPVAI" — the pill label. Pools are commonly named like
 * "Blend Fixed V2"; when a name is just a raw contract id we fall back to a
 * BLEND · <short id> label that matches the visual reference.
 */
export function poolPillLabel(name: string, poolId: string): string {
  const looksLikeId = /^[CG][A-Z0-9]{30,}$/.test(name);
  const core = looksLikeId || !name ? truncateAddress(poolId, 4, 5) : name;
  const cleaned = core.replace(/^blend\s*[·:-]?\s*/i, "").trim();
  return `BLEND · ${cleaned.toUpperCase()}`;
}

/** A single on-chain transaction the agent submitted, flattened from a log row. */
export interface AgentTx {
  ts: number; // epoch seconds (activity log granularity)
  kind: string; // "peruser" | "rebalance" | …
  message: string;
  hash: string;
  /** Supplied amount in stroops (decimal string), when the log row carried it. */
  amountStroops?: string;
  /** The user's smart account the supply moved from, when present. */
  smartWallet?: string;
}

/**
 * Pull the agent's REAL transactions out of the activity log. Money-moving log
 * rows (`peruser` supplies, legacy `rebalance`) carry `meta.hashes` (testnet tx
 * hashes of supplies into our Blend pool) plus optional `amount` / `smartWallet`.
 * Each hash becomes one {@link AgentTx}; rows without hashes are ignored. Order
 * is preserved (the activity log is already newest-first).
 */
export function extractAgentTxs(activity: ActivityEntry[], limit = 20): AgentTx[] {
  const out: AgentTx[] = [];
  for (const e of activity) {
    if (!e.meta) continue;
    let m: { hashes?: string[]; amount?: string; smartWallet?: string };
    try {
      m = JSON.parse(e.meta);
    } catch {
      continue;
    }
    if (!Array.isArray(m.hashes)) continue;
    for (const hash of m.hashes) {
      if (!hash) continue;
      out.push({
        ts: e.ts,
        kind: e.kind,
        message: e.message,
        hash,
        amountStroops: m.amount,
        smartWallet: m.smartWallet,
      });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** Compact relative time from an epoch-SECONDS timestamp, e.g. "2m ago". */
export function formatTimeAgo(tsSec: number, nowMs = Date.now()): string {
  const secs = Math.max(0, Math.floor(nowMs / 1000 - tsSec));
  if (secs < 10) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/** Map a Stellar getNetwork() value to a friendly chrome label. */
export function networkLabel(network: string | null | undefined): string {
  if (!network) return "Stellar";
  const n = network.toUpperCase();
  if (n === "PUBLIC") return "Mainnet";
  if (n === "TESTNET") return "Testnet";
  if (n === "FUTURENET") return "Futurenet";
  return network;
}

/** "05:48" under an hour, "14 h" under a day, else "2 d" — time until `targetMs`. */
export function formatUntil(targetMs: number, nowMs = Date.now()): string {
  const secs = Math.max(0, Math.round((targetMs - nowMs) / 1000));
  if (secs < 3600) return `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
  if (secs < 86400) return `${Math.round(secs / 3600)} h`;
  return `${Math.round(secs / 86400)} d`;
}
