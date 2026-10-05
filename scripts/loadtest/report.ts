/** Pure(ish) export helpers — network access is injectable for tests. */
import { HORIZON_URL, type FetchLike } from "./chain";
import type { EventStatus, ManifestRecord } from "./manifest";
import { COHORT_ORDER, type Cohort, type Plan } from "./schedule";

export function collectHashes(recs: ManifestRecord[]): string[] {
  return [...new Set(recs.flatMap((r) => r.hashes))];
}

export type HorizonTx = { hash: string; created_at: string } & Record<string, unknown>;

/** Every tx of `address` since `sinceIso`, oldest first, following Horizon's next links. */
export async function horizonAccountTxs(address: string, sinceIso: string, fetchFn: FetchLike = fetch): Promise<HorizonTx[]> {
  const out: HorizonTx[] = [];
  let url = `${HORIZON_URL}/accounts/${address}/transactions?order=asc&limit=200`;
  for (;;) {
    const res = await fetchFn(url);
    if (res.status === 404) return out;
    if (res.status !== 200) throw new Error(`horizon ${url} → HTTP ${res.status}`);
    const body = (await res.json()) as { _embedded: { records: HorizonTx[] }; _links: { next: { href: string } } };
    const page = body._embedded.records;
    if (!page.length) return out;
    out.push(...page.filter((t) => t.created_at >= sinceIso));
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
  };
}
