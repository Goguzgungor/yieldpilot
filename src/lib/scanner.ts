import { PoolV2, TokenMetadata } from "@blend-capital/blend-sdk";
import type { Network, PoolOracle, Reserve } from "@blend-capital/blend-sdk";
import { PermanentReadError, withRetry } from "./rpcRetry";
import type { PoolYield, YieldSource } from "./types";

export interface RawReserve {
  poolId: string;
  name: string;
  supplyApr: number;        // fraction, e.g. 0.086
  totalSupplyUsdc: bigint;  // raw token units (7 decimals for USDC SAC)
  utilization: number;      // 0..1
  oracleStale: boolean;
  poolStatus?: number;      // Blend pool status (see PoolYield.poolStatus)
}

export interface BlendReader {
  readReserve(poolId: string): Promise<RawReserve>;
}

/** Waits before each retry of a rate-limited read: ~14 s covers the public RPC's ~16 s window with the read itself. */
export const SCAN_RETRY_DELAYS_MS = [2_000, 4_000, 8_000];
/** Most a single scanSource call waits on retries, so a dead RPC can't stall the tick. */
export const SCAN_RETRY_BUDGET_MS = 30_000;

export interface ScanOptions {
  retryDelaysMs?: number[];
  retryBudgetMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Called for every pool left out of the result; defaults to a console warning (Vercel runtime logs). */
  onError?: (poolId: string, err: unknown) => void;
}

const warnDropped = (poolId: string, err: unknown) =>
  console.warn(`[scan] ${poolId} left out: ${err instanceof Error ? err.message : String(err)}`);

/**
 * Read each pool, retrying rate limits and dropped connections. A pool that
 * still fails is left out of the result and reported through `onError`.
 */
export async function scanSource(source: YieldSource, poolIds: string[], opts: ScanOptions = {}): Promise<PoolYield[]> {
  const out: PoolYield[] = [];
  const budget = { remainingMs: opts.retryBudgetMs ?? SCAN_RETRY_BUDGET_MS };
  const onError = opts.onError ?? warnDropped;
  for (const id of poolIds) {
    try {
      const py = await withRetry(() => source.readPool(id), {
        delaysMs: opts.retryDelaysMs ?? SCAN_RETRY_DELAYS_MS,
        sleep: opts.sleep,
        budget,
      });
      if (py) out.push(py);
    } catch (e) {
      onError(id, e);
    }
  }
  return out;
}

/** Wrap a Blend reserve reader as a YieldSource (maps RawReserve -> PoolYield). */
export function createBlendSource(reader: BlendReader): YieldSource {
  return {
    protocol: "blend",
    async readPool(poolId: string): Promise<PoolYield | null> {
      const r = await reader.readReserve(poolId);
      if (!r) return null;
      return {
        protocol: "blend",
        poolId: r.poolId,
        name: r.name,
        asset: "USDC",
        apyBps: Math.round(r.supplyApr * 10000),
        tvlUsdc: r.totalSupplyUsdc,
        utilizationBps: Math.round(r.utilization * 10000),
        oracleHealthy: !r.oracleStale,
        poolStatus: r.poolStatus,
      };
    },
  };
}

/** Stale if oracle price is > 1 hour old */
const ORACLE_STALE_THRESHOLD_SEC = 3600;

/**
 * One scan reads the same pools through several readers (the USDC reader, a
 * reader per DeFindex asset, the strategy TVL reader); sharing the loads keeps
 * the scan under the public RPC's rate limit. A failed load is forgotten so the
 * retry fetches it again.
 */
export interface PoolCache {
  pool(poolId: string): Promise<PoolV2>;
  oracle(poolId: string): Promise<PoolOracle>;
}

export function createPoolCache(opts: {
  network?: Network;
  loadPool?: (poolId: string) => Promise<PoolV2>;
  ttlMs?: number;
}): PoolCache {
  const ttlMs = opts.ttlMs ?? 30_000;
  const loadPool = opts.loadPool ?? ((id: string) => PoolV2.load(opts.network!, id));
  const entries = new Map<string, { at: number; pool: Promise<PoolV2>; oracle?: Promise<PoolOracle> }>();
  const entry = (poolId: string) => {
    const hit = entries.get(poolId);
    if (hit && Date.now() - hit.at < ttlMs) return hit;
    const fresh = { at: Date.now(), pool: loadPool(poolId) } as { at: number; pool: Promise<PoolV2>; oracle?: Promise<PoolOracle> };
    entries.set(poolId, fresh);
    fresh.pool.catch(() => {
      if (entries.get(poolId) === fresh) entries.delete(poolId);
    });
    return fresh;
  };
  return {
    pool: (poolId) => entry(poolId).pool,
    oracle(poolId) {
      const e = entry(poolId);
      if (!e.oracle) {
        const oracle = e.pool.then((p) => p.loadOracle());
        e.oracle = oracle;
        oracle.catch(() => {
          if (e.oracle === oracle) e.oracle = undefined;
        });
      }
      return e.oracle;
    },
  };
}

/**
 * Network adapter — confirmed against Blend SDK 3.2.2 types and testnet spike (Task 5).
 *
 * Confirmed API:
 *   - PoolV2.load(Network, poolId) where Network = { rpc: string, passphrase: string }
 *   - pool.reserves: Map<string, Reserve>  (keyed by assetId)
 *   - pool.metadata.name: string
 *   - pool.metadata.status: number (0/1 active, 2/3 on ice, 4/5 frozen, 6 setup)
 *   - pool.loadOracle(): Promise<PoolOracle>
 *   - reserve.supplyApr: number (fraction, direct field)
 *   - reserve.totalSupply(): bigint (method)
 *   - reserve.getUtilizationFloat(): number (method)
 *   - reserve.assetId: string
 *   - oracle.prices: Map<string, PriceData>, PriceData.timestamp (seconds)
 *   - TokenMetadata.load(network, assetId).symbol: string
 *
 * The reserve is found by its asset contract id. Only without a configured id
 * does it fall back to matching the token symbol "USDC" (one metadata read per
 * reserve, and any token can call itself USDC). A pool without the reserve
 * throws a PermanentReadError, which the scan does not retry.
 */
export function createBlendReader(
  rpcUrl: string,
  networkPassphrase: string,
  usdcContractId?: string,
  cache?: PoolCache,
): BlendReader {
  const network: Network = { rpc: rpcUrl, passphrase: networkPassphrase };
  const pools = cache ?? createPoolCache({ network });

  return {
    async readReserve(poolId: string): Promise<RawReserve> {
      const pool = await pools.pool(poolId);

      let usdcReserve: Reserve | undefined;
      if (usdcContractId) {
        usdcReserve = pool.reserves.get(usdcContractId);
      } else {
        for (const [assetId, reserve] of pool.reserves) {
          try {
            const meta = await TokenMetadata.load(network, assetId);
            if (meta.symbol === "USDC") {
              usdcReserve = reserve;
              break;
            }
          } catch {
            // skip
          }
        }
      }

      if (!usdcReserve) {
        throw new PermanentReadError(`No ${usdcContractId ? `${usdcContractId.slice(0, 6)}… ` : "USDC "}reserve found in pool ${poolId}`);
      }

      // Oracle staleness (best-effort): a failed oracle load, a missing price
      // entry or a price older than the threshold all count as stale.
      const nowSec = Math.floor(Date.now() / 1000);
      let oracleStale = true;
      try {
        const priceData = (await pools.oracle(poolId)).prices.get(usdcReserve.assetId);
        oracleStale = !priceData || nowSec - priceData.timestamp > ORACLE_STALE_THRESHOLD_SEC;
      } catch {
        // oracle load failing is non-fatal; oracleStale stays true
      }

      return {
        poolId,
        name: pool.metadata.name,
        supplyApr: usdcReserve.supplyApr,             // confirmed direct field (number)
        totalSupplyUsdc: usdcReserve.totalSupply(),   // confirmed method returning bigint
        utilization: usdcReserve.getUtilizationFloat(), // confirmed method returning number 0..1
        oracleStale,
        poolStatus: pool.metadata.status,
      };
    },
  };
}
