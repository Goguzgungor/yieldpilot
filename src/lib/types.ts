export type RiskTolerance = "conservative" | "balanced" | "aggressive";

export interface PoolYield {
  protocol: string;        // yield source protocol, e.g. "blend" | "defindex"
  poolId: string;          // pool / strategy contract id
  name: string;
  asset: string;           // yield asset symbol, e.g. "USDC" | "EURC" | "XLM"
  apyBps: number;          // total supply APY in basis points (e.g. 860 = 8.6%)
  tvlUsdc: bigint;         // USDC TVL in stroops (7 decimals)
  utilizationBps: number;  // 0..10000
  oracleHealthy: boolean;  // false => flagged risky
  /**
   * Blend pool status, when known: 0 Admin_Active, 1 Active, 2 Admin_On_Ice,
   * 3 On_Ice (borrowing disabled), 4 Admin_Frozen, 5 Frozen (deposits
   * disabled), 6 Setup. Anything >= 2 means the pool is in a risk state.
   */
  poolStatus?: number;
}

/** One protocol's adapter: reads a pool/strategy id into a normalized PoolYield. */
export interface YieldSource {
  readonly protocol: string;
  readPool(poolId: string): Promise<PoolYield | null>;
}

export interface ScoredPool extends PoolYield {
  riskScore: number;       // 0 (safe) .. 100 (risky)
  eligible: boolean;       // passes tolerance filter
  reason?: string;         // why ineligible
}

export interface Position {
  poolId: string | null;   // null = idle / unallocated
  amountUsdc: bigint;      // stroops
}

/**
 * A registered per-user smart account (ARMA model). The backend agent is an
 * External ed25519 policy signer on `smartWallet` under two context rules:
 *   - `poolRuleId`: CallContract(POOL) — Blend pool method calls
 *   - `usdcRuleId`: CallContract(USDC) — capped by the spending-limit policy
 * `owner` is the user's classic G-address (the Default-rule owner signer).
 */
export interface UserRegistration {
  owner: string;
  smartWallet: string;
  poolRuleId: number;
  usdcRuleId: number;
  createdAt: number; // epoch seconds
}

export interface Decision {
  action: "hold" | "rebalance";
  toPool?: string;
  amountUsdc?: bigint;
  rationale: string;
}

export interface TxResult {
  hashes: string[];
  success: boolean;
  error?: string;
}
