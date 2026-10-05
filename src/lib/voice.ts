// The agent's state and the sentence it "says" on the dashboard, derived from
// the activity log. Pure and client-safe: no model call — every sentence is
// composed from what the agent actually did.

export interface ActivityRow { ts: number; kind: string; message: string; meta: string | null }

export type AgentState = "SURVEYING" | "SCANNING" | "SUPPLYING" | "HOLDING" | "OFFLINE";
export interface AgentStatus { state: AgentState; voice: string; hash?: string }

/** How long a scan or a supply stays "the current moment" before the agent reads as holding. */
const MOMENT_SEC = 45;

const PROTOCOL_NAMES: Record<string, string> = { blend: "Blend", defindex: "DeFindex" };

function joinNames(keys: string[]): string {
  const names = keys.map((k) => PROTOCOL_NAMES[k] ?? k);
  if (names.length <= 1) return names[0] ?? "Stellar";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** "1,250.00" from a decimal stroop string (7 decimals); "0.00" when unknown. */
export function usdc2(stroops: string | null | undefined): string {
  let v = 0n;
  try { v = BigInt(stroops ?? "0"); } catch { v = 0n; }
  const cents = v / 100_000n; // stroops → hundredths of a USDC
  return (Number(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export interface VoicePool { protocol: string; name: string; apyBps: number; eligible: boolean }

const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;
const bare = (p: VoicePool) => p.name.replace(/^DeFindex\s+/i, "").replace(/^Blend\s+/i, "").trim() || p.name;
// non-breaking around the dot: a route name never wraps mid-way
const routeLabel = (p: VoicePool) => `${PROTOCOL_NAMES[p.protocol] ?? p.protocol}\u00a0·\u00a0${bare(p)}`;

/**
 * The agent's standing sentence while it holds: the route, and the higher yield
 * it is deliberately passing over. Short enough to read at a glance — the full
 * rationale lives on the pool's page. Null for an empty scan.
 */
export function routeVoice(pools: VoicePool[]): string | null {
  if (!pools.length) return null;
  const ok = pools.filter((p) => p.eligible);
  if (!ok.length) return "No pool clears the risk cap right now, so the agent holds.";
  const best = ok.reduce((a, b) => (b.apyBps > a.apyBps ? b : a));
  const higher = pools.filter((p) => !p.eligible && p.apyBps > best.apyBps);
  const lead = `${routeLabel(best)} is the best eligible route at ${pct(best.apyBps)}.`;
  if (!higher.length) return lead;
  const skipped = higher.reduce((a, b) => (b.apyBps > a.apyBps ? b : a));
  return `${lead} ${bare(skipped)} pays ${pct(skipped.apyBps)} but sits past the cap.`;
}

function supplyOf(r: ActivityRow): { hash: string; amount?: string } | null {
  if (r.kind !== "peruser" && r.kind !== "rebalance") return null;
  if (!r.meta) return null;
  try {
    const m = JSON.parse(r.meta) as { hashes?: string[]; amount?: string };
    const hash = m.hashes?.find(Boolean);
    return hash ? { hash, amount: m.amount } : null;
  } catch {
    return null;
  }
}

export function agentStatus(i: {
  activity: ActivityRow[];
  nowSec: number;
  offline: boolean;
  coldStart: boolean;
  rationale: string | null;
  /** The standing route sentence (see routeVoice); preferred over the rationale while holding. */
  routeVoice?: string | null;
  poolCount: number;
  protocols: string[];
}): AgentStatus {
  if (i.offline) {
    return { state: "OFFLINE", voice: "Lost contact with the agent. Your funds are not affected; the page reconnects on its own." };
  }
  if (i.coldStart) {
    return { state: "SURVEYING", voice: "Surveying Stellar for the first time. The range appears as each pool is read." };
  }
  const watching = `${i.poolCount} mainnet pool${i.poolCount === 1 ? "" : "s"} across ${joinNames(i.protocols)}`;
  const latest = i.activity[0];
  if (latest && i.nowSec - latest.ts <= MOMENT_SEC) {
    const supply = supplyOf(latest);
    if (supply) {
      const amt = supply.amount ? `${usdc2(supply.amount)} idle USDC` : "idle USDC";
      return { state: "SUPPLYING", voice: `Supplied ${amt} into the exec pool.`, hash: supply.hash };
    }
    if (latest.kind === "scan") return { state: "SCANNING", voice: `Reading ${watching}.` };
  }
  return { state: "HOLDING", voice: i.routeVoice ?? i.rationale ?? `Watching ${watching}.` };
}
