/**
 * Full Blend pool enumeration, per deployment (V2 and v2.1 each have a factory).
 *
 * A factory keeps a record of every pool it deployed, readable one pool at a
 * time (`is_pool(address)`) but not listable. So the list comes from the
 * factory's `deploy` events, and three sources together cover them:
 *
 *  1. The pools already known ({@link KNOWN_BLEND_POOLS}, then whatever the
 *     publisher has stored since): every pool either factory had deployed when
 *     its full deploy history was last read.
 *  2. The factory's `deploy` events over Soroban RPC, from the ledger the known
 *     set is complete to. The RPC keeps about 7 days of events, so this is
 *     gap-free as long as a run happens within that window; the publisher runs
 *     every 30 minutes.
 *  3. The factory's whole `deploy` history as indexed by Stellar Expert
 *     (`GET https://api.stellar.expert/explorer/public/contract/{factory}/events`,
 *     the method DefiLlama's Blend V2 adapter uses). Optional: since 2026-11-06
 *     that API answers 402 (it charges per call), and until 2026-11-17 Vigil
 *     depended on it and rated 3 pools instead of 13 while it was closed.
 *
 * The backstop reward zone is read as well (V2's is empty on mainnet).
 *
 * Every candidate, from any source, is then VERIFIED on-chain with the
 * factory's own `is_pool(address)`, so no source can inject a contract the
 * factory did not deploy. Candidates the verifier rejects are dropped; if the
 * verifier itself is unreachable, candidates from the factory's own history
 * are kept but marked unverified.
 */
import { scValToNative, xdr } from "@stellar/stellar-sdk";

/** What a source found, when it can say more than a list of ids. */
export interface PoolIdListing {
  ids: string[];
  /** True when these ids, with the pools already known, are every pool of the source's scope. */
  complete?: boolean;
  /** The ledger this listing is complete to. */
  syncedLedger?: number;
  /** Shown next to the source in `coverage.sources`, e.g. the ledgers read. */
  note?: string;
}

export interface PoolIdSource {
  name: string;
  /**
   * True if the ids come from the factory's own deploy history: they are kept
   * when verification is unavailable, and a plain list from such a source is
   * taken to be the whole history.
   */
  authoritative?: boolean;
  /** The deployment this source enumerates. The enumeration is complete when every scope is. */
  scope?: string;
  list(): Promise<string[] | PoolIdListing>;
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
  sources: { name: string; count: number; error?: string; note?: string }[];
  rejected: string[];
  /**
   * True when the list could not be shown to be complete: no source had a
   * deployment's whole deploy history, so a pool deployed since the last
   * complete read may be missing.
   */
  fallbackOnly: boolean;
  /** The ledger the enumeration is complete to, when every deployment's deploy events were read up to one. */
  syncedLedger?: number;
}

export async function discoverBlendPools(opts: {
  sources: PoolIdSource[];
  verifier?: PoolVerifier;
  fallbackIds?: string[];
}): Promise<DiscoveryResult> {
  const bySource = new Map<string, Set<string>>();
  const order: string[] = [];
  const reports: DiscoveryResult["sources"] = [];

  const add = (id: string, src: string) => {
    if (!/^C[A-Z2-7]{55}$/.test(id)) return;
    if (!bySource.has(id)) {
      bySource.set(id, new Set());
      order.push(id);
    }
    bySource.get(id)!.add(src);
  };

  // Completeness is judged per deployment (scope). Sources that name none share one
  // scope when no source names any, and otherwise only add ids.
  const named = opts.sources.flatMap((s) => (s.scope === undefined ? [] : [s.scope]));
  const scopes = new Set(named.length ? named : [""]);
  const completeScopes = new Set<string>();
  const syncedByScope = new Map<string, number>();
  for (const s of opts.sources) {
    const scope = s.scope ?? "";
    try {
      const listed = await s.list();
      const listing: PoolIdListing = Array.isArray(listed) ? { ids: listed } : listed;
      listing.ids.forEach((id) => add(id, s.name));
      reports.push({ name: s.name, count: listing.ids.length, ...(listing.note ? { note: listing.note } : {}) });
      if (listing.complete ?? !!s.authoritative) completeScopes.add(scope);
      if (listing.syncedLedger !== undefined) {
        syncedByScope.set(scope, Math.max(listing.syncedLedger, syncedByScope.get(scope) ?? 0));
      }
    } catch (e) {
      reports.push({ name: s.name, count: 0, error: e instanceof Error ? e.message : String(e) });
    }
  }
  const authoritativeOk = scopes.size > 0 && [...scopes].every((x) => completeScopes.has(x));
  const everySynced = authoritativeOk && [...scopes].every((x) => syncedByScope.has(x));
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
    ...(everySynced ? { syncedLedger: Math.min(...syncedByScope.values()) } : {}),
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

// ── Known pools ──────────────────────────────────────────────────────────────

/** The pools found so far, and the ledger up to which that list is every pool the factories deployed. */
export interface KnownPools {
  ids: string[];
  syncedLedger: number;
}

/** Where the publisher keeps {@link KnownPools} between runs (DB KV on the deployment, a file for the CLI). */
export interface KnownPoolsStore {
  load(): Promise<KnownPools | null>;
  save(known: KnownPools): Promise<void>;
}

/**
 * Every pool Blend's two mainnet factories had deployed at ledger 65,531,213
 * (2026-11-17 19:01 UTC): 12 from V2, 1 from v2.1.
 *
 * Where it comes from:
 *  - up to ledger 65,337,899 (2026-11-06 14:32 UTC, run 1793975537): each
 *    factory's whole `deploy` history, the last time Stellar Expert served it;
 *  - ledgers 65,410,254 to 65,531,213: both factories' `deploy` events read
 *    over RPC on 2026-11-17, none of them a new pool;
 *  - the 72,354 ledgers between: read by the deployment's half-hourly runs as
 *    each passed through the RPC's 7-day window. Their archived coverage shows
 *    no new pool, but those runs did not record a failed event read.
 *
 * Each id is checked with `is_pool` on every run, so a wrong entry is dropped.
 * The list only has to be complete, and from this ledger on the RPC scan keeps
 * it so.
 */
export const KNOWN_BLEND_POOLS: KnownPools = {
  syncedLedger: 65_531_213,
  ids: [
    "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD", // Fixed
    "CBNR7PYFY775UG7W37B4OJG2OBBUKLFW6VIBHFDKKLR2HECPRMRZMDK3", // YieldBlox (never launched)
    "CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS", // YieldBlox
    "CB4OFHAY2TAEYUVPOJS36S657C6NYMSIFUNCCA5AHYT46Y5XUID3O2ED", // Orbit (never launched)
    "CAE7QVOMBLZ53CDRGK3UNRRHG5EZ5NQA7HHTFASEMYBWHG6MDFZTYHXC", // Orbit
    "CBYOBT7ZCCLQCBUYYIABZLSEGDPEUWXCUXQTZYOG3YBDR7U357D5ZIRF", // Forex
    "CALRF5I2OCJCU577R6MZBCY5IIXNMAAG6PNMN7GUKEYIXBJCJN2FJRVI", // Etherfuse (never launched)
    "CADR6Q2UOCDJAGXMAB2E6SRT35STLZ2IGLZUCXJQG7TC2LNKCU5RTQVY", // Etherfuse (never launched)
    "CDMAVJPFXPADND3YRL4BSM3AKZWCTFMX27GLLXCML3PD62HEQS5FPVAI", // Etherfuse
    "CDZVHCO7LDUJZSME3PJPJXAKT7F6W5IXSOXTJ2QEK3Y2X2CDUREBUMUY", // Spectra PTs
    "CC4HHXPKR3FIXUQEC53MAK2IVWD6APAEBBXP5XCIW5FISN6PQOAC6UXG", // Solv
    "CAIYBZSBI6XXI3W7EDXDRWLUBK3RCAPHTK4DNX74DZGWE53KYWBHE236", // New Fixed (never launched)
    "CBAKAZUEJBAFA2DCGBRS2WKJT3FNIMJBHTFL76AY7XMAVEINQNNIQWAO", // Fixed v2.1
  ],
};

/** The stored set if it is at least as far along as the built-in one, with every built-in id kept. */
export function mergeKnownPools(stored: KnownPools | null | undefined, builtIn: KnownPools = KNOWN_BLEND_POOLS): KnownPools {
  const ok = !!stored && Array.isArray(stored.ids) && Number.isFinite(stored.syncedLedger);
  if (!ok) return { ids: [...builtIn.ids], syncedLedger: builtIn.syncedLedger };
  return {
    ids: [...new Set([...builtIn.ids, ...stored!.ids])],
    syncedLedger: Math.max(builtIn.syncedLedger, stored!.syncedLedger),
  };
}

/** The known set after a run: every pool `is_pool` confirmed is added, and the ledger moves up when the run was complete. */
export function nextKnownPools(prev: KnownPools, r: DiscoveryResult): KnownPools {
  const confirmed = r.candidates.filter((c) => c.verified === true).map((c) => c.poolId);
  const dropped = new Set(r.rejected);
  return {
    ids: [...new Set([...prev.ids, ...confirmed])].filter((id) => !dropped.has(id)),
    syncedLedger: Math.max(prev.syncedLedger, r.syncedLedger ?? 0),
  };
}

/** The pools already known. From the factories' own history, so kept if `is_pool` cannot be asked; never complete alone. */
export function knownPoolsSource(known: KnownPools): PoolIdSource {
  return {
    name: "known-pools",
    authoritative: true,
    async list() {
      return { ids: [...known.ids], complete: false, note: `complete to ledger ${known.syncedLedger}` };
    },
  };
}

/**
 * A factory's `deploy` events since the known set's ledger, over RPC. Complete
 * when the RPC still had the first ledger after it; otherwise the events it
 * could read are used and the gap is reported.
 */
export function deployEventsSource(opts: {
  scope: string;
  known: KnownPools;
  scan(fromLedger: number): Promise<{ pools: string[]; startLedger: number; endLedger: number }>;
}): PoolIdSource {
  return {
    name: `rpc:factory-deploy-events:${opts.scope}`,
    authoritative: true,
    scope: opts.scope,
    async list() {
      const from = opts.known.syncedLedger + 1;
      const scan = await opts.scan(from);
      const complete = scan.startLedger <= from;
      return {
        ids: scan.pools,
        complete,
        ...(complete ? { syncedLedger: scan.endLedger } : {}),
        note: complete
          ? `ledgers ${scan.startLedger}-${scan.endLedger}`
          : `ledgers ${scan.startLedger}-${scan.endLedger}; ${from}-${scan.startLedger - 1} are no longer on the RPC`,
      };
    },
  };
}
