/** Pure(ish) export helpers — network access is injectable for tests. */
import { HORIZON_URL, type FetchLike } from "./chain";
import type { EventStatus, ManifestRecord } from "./manifest";
import { COHORT_ORDER, RUN_MIN, type Cohort, type Plan } from "./schedule";

export function collectHashes(recs: ManifestRecord[]): string[] {
  return [...new Set(recs.flatMap((r) => r.hashes))];
}

export type HorizonTx = { hash: string; created_at: string } & Record<string, unknown>;

export interface RunWindow {
  sinceMs: number;
  untilMs: number;
  sinceIso: string;
  untilIso: string;
}

const isoSeconds = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * The time span whose chain/off-chain data belongs to this run. It opens 2 min
 * before startedAt (clock skew only — the smoke run shares the load-test agent
 * and ends ~15 min before T0, so it must stay outside) and closes 15 min after
 * the later of the plan's end and the last finished event (driver lag).
 */
export function runWindow(meta: { startedAt: number; timeScale: number }, recs: ManifestRecord[]): RunWindow {
  const lastFinished = Math.max(0, ...recs.map((r) => (r.type === "event" ? r.finishedAt : 0)));
  const sinceMs = meta.startedAt - 120_000;
  const untilMs = Math.max(meta.startedAt + Math.round(RUN_MIN * 60_000 * meta.timeScale), lastFinished) + 900_000;
  return { sinceMs, untilMs, sinceIso: isoSeconds(sinceMs), untilIso: isoSeconds(untilMs) };
}

/**
 * Every tx of `address` inside the window, oldest first, following Horizon's
 * next links. include_failed: Horizon hides failed txs by default, and failed
 * supplies/authorizes/mints are exactly what a load test needs to see.
 */
export async function horizonAccountTxs(
  address: string,
  window: Pick<RunWindow, "sinceIso" | "untilIso">,
  fetchFn: FetchLike = fetch,
): Promise<HorizonTx[]> {
  const out: HorizonTx[] = [];
  let url = `${HORIZON_URL}/accounts/${address}/transactions?order=asc&limit=200&include_failed=true`;
  for (;;) {
    const res = await fetchFn(url);
    if (res.status === 404) return out;
    if (res.status !== 200) throw new Error(`horizon ${url} → HTTP ${res.status}`);
    const body = (await res.json()) as { _embedded: { records: HorizonTx[] }; _links: { next: { href: string } } };
    const page = body._embedded.records;
    if (!page.length) return out;
    for (const t of page) {
      if (t.created_at > window.untilIso) return out; // ascending order: nothing later belongs to this run
      if (t.created_at >= window.sinceIso) out.push(t);
    }
    url = body._links.next.href;
  }
}

export type PostJson = (url: string, body: unknown) => Promise<unknown>;

const postJson: PostJson = async (url, body) =>
  (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();

/** Raw getTransaction (envelope/result/meta XDR) — only RPC still serves Soroban meta. */
export async function rpcGetTransaction(rpcUrl: string, hash: string, post: PostJson = postJson): Promise<Record<string, unknown>> {
  const res = (await post(rpcUrl, { jsonrpc: "2.0", id: 1, method: "getTransaction", params: { hash } })) as {
    result?: Record<string, unknown>;
    error?: { message: string };
  };
  if (res.error) return { hash, status: "RPC_ERROR", error: res.error.message };
  return { hash, ...res.result };
}

export interface ActivityEntry {
  ts: number;
  kind: string;
  message: string;
  meta: Record<string, unknown> | null;
}

export function parseActivity(rows: Array<{ ts: number; kind: string; message: string; meta: string | null }>): ActivityEntry[] {
  return rows.map((r) => {
    let meta: Record<string, unknown> | null = null;
    try {
      meta = r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : null;
    } catch {
      meta = null;
    }
    return { ts: r.ts, kind: r.kind, message: r.message, meta };
  });
}

/** Tx hashes the server logged (faucet txHash, onboard hash, per-user supply hashes[]). */
export function activityHashes(entries: ActivityEntry[]): string[] {
  const out = new Set<string>();
  for (const a of entries) {
    for (const k of ["txHash", "hash"]) if (typeof a.meta?.[k] === "string") out.add(a.meta[k] as string);
    if (Array.isArray(a.meta?.hashes)) for (const h of a.meta.hashes) if (typeof h === "string") out.add(h);
  }
  return [...out];
}

export interface CohortSummary {
  wallets: number;
  onboarded: number;
  onboardFailed: number;
  mintedUsdc: number;
  supplies: number;
  suppliedUsdc: number;
  supplyErrors: number;
}

export interface Summary {
  activityIncluded: boolean;
  events: Record<EventStatus, number>;
  /** Worst startedAt − plannedAt: how far the serial driver fell behind the plan. */
  maxLagMs: number;
  cohorts: Record<Cohort, CohortSummary>;
  ticks: { ok: number; failed: number; avgDurationMs: number; maxDurationMs: number; serverTickFailures: number };
  /**
   * Faucet mints the server logged but the driver never recorded (a kill or reset
   * mid-request, then a replay). Their USDC is missing from mintedUsdc. null
   * without the activity log.
   */
  unrecordedMints: number | null;
}

const MINT_STEPS = new Set(["fund", "mint-sa", "mint-g"]);

export function summarize(plan: Plan, recs: ManifestRecord[], activity: ActivityEntry[] | null): Summary {
  const cohortOf = new Map(plan.wallets.map((w) => [w.index, w.cohort]));
  const cohorts = Object.fromEntries(
    COHORT_ORDER.map((c) => [c, { wallets: 0, onboarded: 0, onboardFailed: 0, mintedUsdc: 0, supplies: 0, suppliedUsdc: 0, supplyErrors: 0 }]),
  ) as Record<Cohort, CohortSummary>;
  for (const w of plan.wallets) cohorts[w.cohort].wallets++;

  const events: Record<EventStatus, number> = { ok: 0, failed: 0, skipped: 0 };
  const walletBySa = new Map<string, number>();
  const tickDurations: number[] = [];
  let tickFailed = 0;
  let maxLagMs = 0;

  for (const r of recs) {
    if (r.type === "step") {
      if (r.wallet !== undefined && MINT_STEPS.has(r.step)) cohorts[cohortOf.get(r.wallet)!].mintedUsdc += Number(r.data?.usdc ?? 0);
      continue;
    }
    events[r.status]++;
    maxLagMs = Math.max(maxLagMs, r.startedAt - r.plannedAt);
    if (r.kind === "tick") {
      if (r.status === "ok") tickDurations.push(Number(r.data?.durationMs ?? 0));
      else tickFailed++;
    }
    if (r.kind === "onboard" && r.wallet !== undefined) {
      const c = cohorts[cohortOf.get(r.wallet)!];
      if (r.status === "ok") {
        c.onboarded++;
        walletBySa.set(String(r.data?.smartWallet), r.wallet);
      } else c.onboardFailed++;
    }
  }

  let serverTickFailures = 0;
  for (const a of activity ?? []) {
    if (a.kind === "error" && a.message.startsWith("tick failed")) {
      serverTickFailures++;
      continue;
    }
    const sa = typeof a.meta?.smartWallet === "string" ? a.meta.smartWallet : undefined;
    const idx = sa ? walletBySa.get(sa) : undefined;
    if (idx === undefined) continue;
    const c = cohorts[cohortOf.get(idx)!];
    if (a.kind === "peruser" && typeof a.meta?.amount === "string") {
      c.supplies++;
      c.suppliedUsdc += Number(BigInt(a.meta.amount) / 10_000n) / 1000; // stroops → USDC, 3 decimals
    }
    if (a.kind === "error") c.supplyErrors++;
  }

  const recorded = new Set(collectHashes(recs));
  const unrecordedMints =
    activity === null
      ? null
      : activity.filter((a) => a.kind === "faucet" && typeof a.meta?.txHash === "string" && !recorded.has(a.meta.txHash)).length;

  const total = tickDurations.reduce((s, d) => s + d, 0);
  return {
    activityIncluded: activity !== null,
    events,
    maxLagMs,
    cohorts,
    ticks: {
      ok: tickDurations.length,
      failed: tickFailed,
      avgDurationMs: tickDurations.length ? Math.round(total / tickDurations.length) : 0,
      maxDurationMs: tickDurations.length ? Math.max(...tickDurations) : 0,
      serverTickFailures,
    },
    unrecordedMints,
  };
}
