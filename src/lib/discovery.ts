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
 * How far back the agent's own discovery looks for factory `deploy` events:
 * about 42 hours of ledgers. Its pool list is kept in the DB and re-read about
 * hourly, so a short window is enough; the full history is Vigil's job
 * (src/lib/vigil/discovery.ts).
 */
const FACTORY_EVENT_LEDGER_LOOKBACK = 30_000;
const FACTORY_EVENT_PAGE_LIMIT = 200;
/** The RPC reads 10,000 ledgers per `getEvents` call; its 7-day window is 13 calls. */
const FACTORY_EVENT_MAX_CALLS = 40;

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

/** The part of the RPC client a deploy-event scan needs (faked in tests). */
export type EventsRpc = Pick<rpc.Server, "getLatestLedger" | "getEvents">;

export interface FactoryDeployScan {
  /** Pools named by the factory's `deploy` events in the ledgers read. */
  pools: string[];
  /** First ledger read: the one asked for, or the oldest the RPC still has if that is later. */
  startLedger: number;
  /** Last ledger read. */
  endLedger: number;
}

/** The ledger an event cursor (`<TOID>-<event index>`) points at; null if it is not in that form. */
export function ledgerOfCursor(cursor: string): number | null {
  const m = /^(\d+)-/.exec(cursor);
  if (!m) return null;
  const ledger = Number(BigInt(m[1]) >> 32n);
  return Number.isSafeInteger(ledger) && ledger > 0 ? ledger : null;
}

/**
 * Pool ids from the PoolFactory's `deploy` events, from `fromLedger` (or
 * `lookback` ledgers back) to the latest ledger. The RPC keeps about 7 days of
 * events, so the scan starts at its oldest ledger when the one asked for is
 * older, and says so in `startLedger`.
 *
 * One `getEvents` call reads at most 10,000 ledgers and then returns a cursor,
 * with or without events. The scan follows the cursor until it reaches the
 * latest ledger. Until 2026-11-17 it stopped at the first short page, so it
 * only ever read the oldest 14 hours of the window.
 */
export async function scanFactoryDeploys(
  server: EventsRpc,
  factoryId: string,
  opts: { fromLedger?: number; lookback?: number; maxCalls?: number } = {},
): Promise<FactoryDeployScan> {
  const { sequence: latestLedger } = await server.getLatestLedger();
  const filter = { type: "contract" as const, contractIds: [factoryId] };
  // Every response carries the retained range; ask at the tip, which is always inside it.
  const probe = await server.getEvents({ filters: [filter], startLedger: latestLedger, limit: 1 });
  const wanted = opts.fromLedger ?? (opts.lookback ? latestLedger - opts.lookback : probe.oldestLedger);
  const startLedger = Math.min(latestLedger, Math.max(wanted, probe.oldestLedger, 1));

  const pools = new Set<string>();
  let cursor: string | undefined;
  let endLedger = startLedger - 1;
  const maxCalls = opts.maxCalls ?? FACTORY_EVENT_MAX_CALLS;
  for (let call = 0; call < maxCalls; call++) {
    const res = await server.getEvents(
      cursor
        ? { filters: [filter], cursor, limit: FACTORY_EVENT_PAGE_LIMIT }
        : { filters: [filter], startLedger, limit: FACTORY_EVENT_PAGE_LIMIT },
    );
    // `getEvents` returns decoded ScVal events; re-encode to the raw shape the
    // SDK parser expects (it intentionally consumes RawEventResponse).
    for (const ev of res.events) {
      const parsed = poolFactoryEventFromEventResponse(toRawEvent(ev));
      if (parsed?.poolAddress) pools.add(parsed.poolAddress);
    }
    const at = res.cursor ? ledgerOfCursor(res.cursor) : null;
    // No cursor, or one that did not move: the RPC has nothing further to read.
    if (!res.cursor || res.cursor === cursor || at === null) {
      endLedger = res.latestLedger;
      break;
    }
    endLedger = Math.min(at, res.latestLedger);
    if (at >= res.latestLedger) break;
    cursor = res.cursor;
  }
  return { pools: Array.from(pools), startLedger, endLedger };
}

/** The agent's best-effort view of recent deploys: the last {@link FACTORY_EVENT_LEDGER_LOOKBACK} ledgers. */
async function loadFactoryDeployedPools(rpcUrl: string, factoryId: string): Promise<string[]> {
  const scan = await scanFactoryDeploys(createRpcServer(rpcUrl), factoryId, { lookback: FACTORY_EVENT_LEDGER_LOOKBACK });
  return scan.pools;
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
