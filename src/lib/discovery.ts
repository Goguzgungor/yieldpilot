import { BackstopConfig, poolFactoryEventFromEventResponse } from "@blend-capital/blend-sdk";
import { rpc } from "@stellar/stellar-sdk";
import { createRpcServer } from "./rpcServer";

/** Default TTL for the DB-cached pool-id list (60 minutes). */
export const DISCOVERY_TTL_MS = 60 * 60 * 1000;

/**
 * Pure helper: returns `true` when the cached discovery result is still
 * considered fresh.
 *
 * @param discoveredAtMs  Epoch-ms timestamp recorded when the pool ids were
 *                        last fetched from the chain (or 0 / NaN / undefined
 *                        when no cache exists yet).
 * @param nowMs           Current epoch-ms (defaults to `Date.now()`).
 * @param ttlMs           Maximum age before the cache is considered stale
 *                        (defaults to {@link DISCOVERY_TTL_MS}).
 */
export function isDiscoveryCacheFresh(
  discoveredAtMs: number | null | undefined,
  nowMs = Date.now(),
  ttlMs = DISCOVERY_TTL_MS,
): boolean {
  if (!discoveredAtMs || !Number.isFinite(discoveredAtMs)) return false;
  return nowMs - discoveredAtMs < ttlMs;
}

/**
 * The pool ids to scan after a re-discovery: every known id, then the newly
 * discovered ones, deduped. A known pool is never dropped (it may have only
 * left the reward zone); one without a USDC reserve is left out by the scan.
 */
export function mergePoolIds(known: string[], discovered: string[]): string[] {
  return [...new Set([...known, ...discovered])];
}

/**
 * A source of Blend pool contract ids. Implementations may read on-chain state,
 * call an API, or return a static list. Kept tiny so it can be faked in tests
 * without any network access.
 */
export interface PoolSource {
  listPools(): Promise<string[]>;
}

/**
 * Resolves the set of pool ids the scanner should look at. Wraps a (possibly
 * flaky) on-chain source with a curated fallback so the scanner always has
 * something to scan.
 */
export interface PoolDiscovery {
  discoverPoolIds(): Promise<string[]>;
}

/**
 * Wrap an on-chain {@link PoolSource} with a curated fallback list + dedupe.
 *
 * Behaviour:
 *   - source returns ids → return them (deduped).
 *   - source returns []   → return the curated fallback list.
 *   - source throws       → return the curated fallback list.
 */
export function createPoolDiscovery(source: PoolSource, fallbackPoolIds: string[]): PoolDiscovery {
  return {
    async discoverPoolIds() {
      try {
        const ids = await source.listPools();
        const merged = Array.from(new Set(ids.length ? ids : fallbackPoolIds));
        return merged.length ? merged : fallbackPoolIds;
      } catch {
        return fallbackPoolIds;
      }
    },
  };
}

/**
 * RPC `getEvents` only retains a limited ledger window (typically ~24h, a few
 * 100k ledgers). We page backwards from `latestLedger` toward this bound, but
 * never below the RPC-reported `oldestLedger`.
 */
const FACTORY_EVENT_LEDGER_LOOKBACK = 200_000;
const FACTORY_EVENT_PAGE_LIMIT = 200;
const FACTORY_EVENT_MAX_PAGES = 50;

/**
 * On-chain Blend pool source for **current-state** enumeration of active pools.
 *
 * Primary (authoritative for *active* pools): the Backstop's reward zone (`RZ`
 * ledger key) — a `Vec<Address>` of pools currently receiving BLND emissions.
 * Read via {@link BackstopConfig.load}, which is a single current-state ledger
 * read (no event-history retention concerns). This is the cleanest way to get
 * the live active set.
 *
 * Best-effort (catches pools deployed but not yet in the reward zone): the
 * PoolFactory `deploy` events, parsed via {@link poolFactoryEventFromEventResponse}.
 * Soroban RPC only retains a limited ledger window, so this can only see recent
 * deploys; failures/empties here are non-fatal and simply contribute nothing.
 *
 * Results from both paths are unioned and deduped (order: reward zone first,
 * then any extra factory deploys).
 */
export function createBlendOnchainPoolSource(opts: {
  rpcUrl: string;
  networkPassphrase: string;
  backstopId: string;
  factoryId: string;
}): PoolSource {
  const network = { rpc: opts.rpcUrl, passphrase: opts.networkPassphrase };

  return {
    async listPools(): Promise<string[]> {
      const seen = new Set<string>();
      const ordered: string[] = [];
      const add = (id: string) => {
        if (id && !seen.has(id)) {
          seen.add(id);
          ordered.push(id);
        }
      };

      // ── Primary: backstop reward zone (current state) ─────────────────────
      // If this throws, let it propagate so createPoolDiscovery falls back.
      const cfg = await BackstopConfig.load(network as any, opts.backstopId);
      for (const poolId of cfg.rewardZone ?? []) add(poolId);

      // ── Best-effort: PoolFactory deploy events over the retained window ───
      // Never let event-history gaps (or RPC quirks) break discovery: the
      // reward zone above is already a valid result, so swallow errors here.
      try {
        for (const id of await loadFactoryDeployedPools(network.rpc, opts.factoryId)) add(id);
      } catch {
        // event history unavailable / RPC error — ignore, reward zone stands
      }

      return ordered;
    },
  };
}

/**
 * Enumerate pool ids from PoolFactory `deploy` events within the RPC's retained
 * ledger window. Starts a ledger-range query near the latest ledger (clamped to
 * what the RPC retains, surfaced as `oldestLedger` on the response) and pages
 * forward via the cursor. Best-effort: deploys older than the retention window
 * are invisible, which is exactly why the reward zone is the primary source.
 */
async function loadFactoryDeployedPools(rpcUrl: string, factoryId: string): Promise<string[]> {
  const server = createRpcServer(rpcUrl);
  const { sequence: latestLedger } = await server.getLatestLedger();
  const startLedger = Math.max(1, latestLedger - FACTORY_EVENT_LEDGER_LOOKBACK);
  const filter = { type: "contract" as const, contractIds: [factoryId] };

  const pools = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < FACTORY_EVENT_MAX_PAGES; page++) {
    // First request uses a ledger range; subsequent pages use the returned cursor.
    const request: rpc.Api.GetEventsRequest = cursor
      ? { filters: [filter], cursor, limit: FACTORY_EVENT_PAGE_LIMIT }
      : { filters: [filter], startLedger, limit: FACTORY_EVENT_PAGE_LIMIT };

    let res: rpc.Api.GetEventsResponse;
    try {
      res = await server.getEvents(request);
    } catch {
      // Our startLedger likely predates retention. Retry once clamped to the
      // RPC's oldest retained ledger; if that also fails, give up (non-fatal).
      if (!cursor) {
        const probe = await server.getEvents({ filters: [filter], startLedger: latestLedger, limit: 1 });
        res = await server.getEvents({
          filters: [filter],
          startLedger: Math.max(startLedger, probe.oldestLedger),
          limit: FACTORY_EVENT_PAGE_LIMIT,
        });
      } else {
        break;
      }
    }

    // `getEvents` returns decoded ScVal events; re-encode to the raw shape the
    // SDK parser expects (it intentionally consumes RawEventResponse).
    for (const ev of res.events) {
      const parsed = poolFactoryEventFromEventResponse(toRawEvent(ev));
      if (parsed?.poolAddress) pools.add(parsed.poolAddress);
    }

    if (!res.cursor || res.events.length < FACTORY_EVENT_PAGE_LIMIT) break;
    cursor = res.cursor;
  }

  return Array.from(pools);
}

/** Re-encode a decoded EventResponse into the RawEventResponse shape the Blend SDK parser expects. */
function toRawEvent(ev: rpc.Api.EventResponse): rpc.Api.RawEventResponse {
  return {
    id: ev.id,
    type: ev.type,
    ledger: ev.ledger,
    ledgerClosedAt: ev.ledgerClosedAt,
    contractId: ev.contractId ? ev.contractId.contractId().toString() : "",
    topic: (ev.topic ?? []).map((t) => t.toXDR("base64")),
    value: ev.value.toXDR("base64"),
    txHash: ev.txHash,
    transactionIndex: (ev as any).transactionIndex,
    operationIndex: (ev as any).operationIndex,
    inSuccessfulContractCall: (ev as any).inSuccessfulContractCall,
  } as rpc.Api.RawEventResponse;
}
