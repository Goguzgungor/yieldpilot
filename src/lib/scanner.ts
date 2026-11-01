import { PoolV2, TokenMetadata } from "@blend-capital/blend-sdk";
import type { Network, Reserve } from "@blend-capital/blend-sdk";
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

export async function scanSource(source: YieldSource, poolIds: string[]): Promise<PoolYield[]> {
  const out: PoolYield[] = [];
  for (const id of poolIds) {
    try {
      const py = await source.readPool(id);
      if (py) out.push(py);
    } catch {
      // Skip unreadable pool; orchestrator logs the gap.
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
 * The USDC reserve is found by matching assetId against the configured usdcContractId.
 * If not found, falls back to TokenMetadata symbol matching.
 */
export function createBlendReader(
  rpcUrl: string,
  networkPassphrase: string,
  usdcContractId?: string,
): BlendReader {
  const network: Network = { rpc: rpcUrl, passphrase: networkPassphrase };

  return {
    async readReserve(poolId: string): Promise<RawReserve> {
      const pool = await PoolV2.load(network, poolId);

      // Attempt to load oracle for staleness detection (best-effort)
      const nowSec = Math.floor(Date.now() / 1000);
      let oraclePrices: Map<string, { price: bigint; timestamp: number }> | undefined;
      try {
        const oracle = await pool.loadOracle();
        oraclePrices = oracle.prices;
      } catch {
        // oracle load failing is non-fatal; oracleStale will be set to true
      }

      // Find USDC reserve: first by explicit contract ID, then by symbol
      let usdcReserve: Reserve | undefined;

      if (usdcContractId) {
        usdcReserve = pool.reserves.get(usdcContractId);
      }

      if (!usdcReserve) {
        // Fallback: scan all reserves and match by symbol via TokenMetadata
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
        throw new Error(`No USDC reserve found in pool ${poolId}`);
      }

      // Oracle staleness: missing price entry or price older than threshold
      let oracleStale = false;
      if (!oraclePrices) {
        oracleStale = true;
      } else {
        const priceData = oraclePrices.get(usdcReserve.assetId);
        oracleStale = !priceData || nowSec - priceData.timestamp > ORACLE_STALE_THRESHOLD_SEC;
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
