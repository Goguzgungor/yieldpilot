/**
 * Full Blend pool enumeration, per deployment (V2 and v2.1 each have a factory).
 *
 * Why not the existing discovery (src/lib/discovery.ts)? It relies on the backstop reward zone
 * (currently EMPTY on mainnet — `reward_zone()` returns []) plus RPC `getEvents`, whose retention
 * window (~7 days) cannot see historical `deploy` events. Neither can enumerate all pools.
 *
 * Primary source: the PoolFactory's complete `deploy` event history as indexed by Stellar Expert
 * (`GET https://api.stellar.expert/explorer/public/contract/{factory}/events`). Each event body is
 * the deployed pool's ScAddress. This is the same method DefiLlama's Blend V2 adapter uses
 * (DefiLlama-Adapters projects/blend-pools-v2/index.js).
 *
 * Every candidate (from any source, including the curated list) is then VERIFIED on-chain with the
 * factory's own `is_pool(address)` (factory storage records every pool it deployed), so an indexer
 * error cannot inject a non-factory contract. Candidates the verifier rejects are dropped; if the
 * verifier itself is unreachable, factory-event candidates are kept but marked unverified.
 */
import { scValToNative, xdr } from "@stellar/stellar-sdk";

export interface PoolIdSource {
  name: string;
  /** True if this source is the factory's own deploy history (trusted when verification is unavailable). */
  authoritative?: boolean;
  list(): Promise<string[]>;
}

export interface PoolVerifier {
  /** true/false from factory `is_pool`; null when the check could not be performed. */
  isPool(poolId: string): Promise<boolean | null>;
}

export interface DiscoveryCandidate {
  poolId: string;
  sources: string[];
  verified: boolean | null;
}

export interface DiscoveryResult {
  poolIds: string[];
  candidates: DiscoveryCandidate[];
  sources: { name: string; count: number; error?: string }[];
  rejected: string[];
  /** True when no authoritative source answered and only fallback ids were used. */
  fallbackOnly: boolean;
}

export async function discoverBlendPools(opts: {
  sources: PoolIdSource[];
  verifier?: PoolVerifier;
  fallbackIds?: string[];
}): Promise<DiscoveryResult> {
  const bySource = new Map<string, Set<string>>();
  const order: string[] = [];
  const reports: DiscoveryResult["sources"] = [];
  let authoritativeOk = false;

  const add = (id: string, src: string) => {
    if (!/^C[A-Z2-7]{55}$/.test(id)) return;
    if (!bySource.has(id)) {
      bySource.set(id, new Set());
      order.push(id);
    }
    bySource.get(id)!.add(src);
  };

  for (const s of opts.sources) {
    try {
      const ids = await s.list();
      ids.forEach((id) => add(id, s.name));
      reports.push({ name: s.name, count: ids.length });
      if (s.authoritative) authoritativeOk = true;
    } catch (e) {
      reports.push({ name: s.name, count: 0, error: e instanceof Error ? e.message : String(e) });
    }
  }
  const fallback = opts.fallbackIds ?? [];
  fallback.forEach((id) => add(id, "curated"));
  reports.push({ name: "curated", count: fallback.length });

  const authoritativeNames = new Set(opts.sources.filter((s) => s.authoritative).map((s) => s.name));
  const candidates: DiscoveryCandidate[] = [];
  const rejected: string[] = [];
  for (const id of order) {
    const sources = [...bySource.get(id)!];
    let verified: boolean | null = null;
    if (opts.verifier) {
      try {
        verified = await opts.verifier.isPool(id);
      } catch {
        verified = null;
      }
    }
    if (verified === false) {
      rejected.push(id);
      continue;
    }
    // Unverifiable candidates are kept only if an authoritative source (factory history) or the
    // curated list vouches for them.
    if (verified === null && !sources.some((s) => authoritativeNames.has(s) || s === "curated")) {
      rejected.push(id);
      continue;
    }
    candidates.push({ poolId: id, sources, verified });
  }
  return {
    poolIds: candidates.map((c) => c.poolId),
    candidates,
    sources: reports,
    rejected,
    fallbackOnly: !authoritativeOk,
  };
}

/** Minimal JSON fetcher (injected so tests stay offline). */
export type FetchJson = (url: string) => Promise<unknown>;

interface ExpertEventsPage {
  _embedded?: { records?: { id: string; topics?: string[]; bodyXdr?: string }[] };
}

/** Decode a factory `deploy` event body (an ScVal address) to a C… contract id. */
export function decodeDeployBody(bodyXdr: string): string | null {
  try {
    const v = scValToNative(xdr.ScVal.fromXDR(bodyXdr, "base64"));
    return typeof v === "string" && v.startsWith("C") ? v : null;
  } catch {
    return null;
  }
}

/**
 * All pools ever deployed by the factory, from Stellar Expert's indexed `deploy` events.
 * Paginates ascending with the cursor until an empty / short page.
 */
export function stellarExpertDeploySource(opts: {
  factoryId: string;
  fetchJson: FetchJson;
  baseUrl?: string;
  pageLimit?: number;
  maxPages?: number;
}): PoolIdSource {
  const base = opts.baseUrl ?? "https://api.stellar.expert/explorer/public";
  const limit = opts.pageLimit ?? 200;
  const maxPages = opts.maxPages ?? 50;
  return {
    name: "stellar-expert:factory-deploy-events",
    authoritative: true,
    async list() {
      const out: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < maxPages; page++) {
        const url = `${base}/contract/${opts.factoryId}/events?order=asc&limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`;
        const res = (await opts.fetchJson(url)) as ExpertEventsPage;
        const records = res?._embedded?.records;
        if (!Array.isArray(records)) throw new Error("unexpected Stellar Expert response");
        for (const r of records) {
          if (r.topics?.[0] !== "deploy" || !r.bodyXdr) continue;
          const id = decodeDeployBody(r.bodyXdr);
          if (id && !out.includes(id)) out.push(id);
        }
        if (records.length < limit) break;
        cursor = records[records.length - 1].id;
      }
      return out;
    },
  };
}

/** Wrap any async id lister (e.g. backstop reward zone, RPC recent events) as a source. */
export function functionSource(name: string, list: () => Promise<string[]>, authoritative = false): PoolIdSource {
  return { name, authoritative, list };
}
