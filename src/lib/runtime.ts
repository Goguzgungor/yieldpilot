import {
  Keypair,
  Address,
  BASE_FEE,
  Contract,
  nativeToScVal,
  rpc,
  scValToNative,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { z } from "zod";
import { parseConfig, type Config } from "./config";
import { createDb, type Db } from "./db";
import * as registry from "./registry";
import { createBlendReader, createBlendSource, scanSource, type BlendReader } from "./scanner";
import { createDefindexSource } from "./defindex";
import { createBlendOnchainPoolSource, createPoolDiscovery, type PoolDiscovery } from "./discovery";
import { createSorobanClient, createExecutor, type Executor } from "./executor";
import { createKeypairWallet, createPolicySignerWallet } from "./wallet";
import { decide } from "./agent";
import { runTick, runPerUserExecution } from "./orchestrator";
import { scorePools, bestPool } from "./risk";
import type { UserRegistration, TxResult } from "./types";
import {
  serializePosition,
  serializeScoredPools,
  type SerializedPosition,
  type SerializedScoredPool,
} from "./serialize";
import type { Position, ScoredPool, Decision, YieldSource } from "./types";

/** Latest agent decision exposed to the UI (chosen pool + rationale + action). */
export interface LatestDecision {
  action: Decision["action"];
  chosenPoolId: string | null;
  rationale: string;
}

/**
 * Lazily-built process singleton wiring config → db → reader/discovery/wallet/
 * executor together, plus the shared mutable loop state.
 *
 * CRITICAL: nothing here runs at module import time. `parseConfig(process.env)`
 * (and all SDK client construction) only happens inside {@link getRuntime} on
 * first call. This keeps `next build` / route static-analysis from crashing when
 * env vars are absent, and keeps the agent loop from starting during the build
 * phase.
 */
export interface Runtime {
  cfg: Config;
  db: Db;
  blendSource: YieldSource;
  defindexSource: YieldSource | null;
  poolDiscovery: PoolDiscovery;
  executor: Executor;
  /** Backend agent keypair (the External ed25519 policy signer for every user). */
  agentKeypair: Keypair;
  /** Shared testnet RPC server for exec-side reads (USDC balances) + per-user txs. */
  execServer: rpc.Server;
  /**
   * Most recent SCORED scan result (riskScore/eligible/reason populated;
   * BigInts still as bigint — serialize at the edge). Empty until the first tick.
   */
  lastScan: ScoredPool[];
  /** Latest agent decision (chosen pool + rationale + action); null until first decide. */
  lastDecision: LatestDecision | null;
  lastRebalanceAt: number;
  /** Idempotency guard: true while a tick is in flight (never overlap ticks). */
  running: boolean;
  /** Discovered Blend pool ids (cached in-process); null until first resolved. */
  poolIds: string[] | null;
}

let runtime: Runtime | null = null;

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Build (once) and return the runtime singleton. Throws a clear error if the
 * environment is missing/invalid — but only when actually called, never at
 * import time.
 */
export function getRuntime(): Runtime {
  if (runtime) return runtime;

  let cfg: Config;
  try {
    cfg = parseConfig(process.env);
  } catch (e) {
    throw new Error(
      `YieldSeeker runtime init failed: invalid/missing environment. ${(e as Error).message}`,
    );
  }

  const db = createDb();

  // Scan side: mainnet reader (read-only, no signing).
  const reader = createBlendReader(cfg.scanRpcUrl, cfg.scanNetworkPassphrase, cfg.scanUsdcContractId);
  const blendSource = createBlendSource(reader);
  // Per-asset Blend readers (memoized) so DeFindex can read the USDC / EURC / XLM
  // reserve each strategy autocompounds into.
  const blendReaderByAsset = new Map<string, BlendReader>([[cfg.scanUsdcContractId, reader]]);
  const readerFor = (assetContractId: string): BlendReader => {
    let r = blendReaderByAsset.get(assetContractId);
    if (!r) {
      r = createBlendReader(cfg.scanRpcUrl, cfg.scanNetworkPassphrase, assetContractId);
      blendReaderByAsset.set(assetContractId, r);
    }
    return r;
  };
  const defindexSource = cfg.scanDefindexStrategies.length
    ? createDefindexSource(readerFor, cfg.scanDefindexStrategies)
    : null;

  // Dynamic on-chain pool discovery (Blend backstop reward zone + factory deploy
  // events), with the curated SCAN_BLEND_POOL_IDS as a fallback.
  const poolSource = createBlendOnchainPoolSource({
    rpcUrl: cfg.scanRpcUrl,
    networkPassphrase: cfg.scanNetworkPassphrase,
    backstopId: cfg.scanBackstopId,
    factoryId: cfg.scanPoolFactoryId,
  });
  const poolDiscovery = createPoolDiscovery(poolSource, cfg.scanBlendPoolIds);

  // Exec side: testnet signer + client (real txs, no real money).
  const agentKeypair = Keypair.fromSecret(cfg.agentSignerSecret);
  const execServer = new rpc.Server(cfg.execRpcUrl, {
    allowHttp: cfg.execRpcUrl.startsWith("http://"),
  });
  // Legacy single-wallet executor (keypair mode): the agent signs as itself and
  // supplies into SMART_WALLET_ADDRESS. In smart-account mode this executor is
  // unused — per-user executors are built per tick from the registry.
  const wallet = createKeypairWallet(agentKeypair, cfg.execNetworkPassphrase);
  const soroban = createSorobanClient({
    rpcUrl: cfg.execRpcUrl,
    networkPassphrase: cfg.execNetworkPassphrase,
    walletAddress: cfg.smartWalletAddress,
    usdcId: cfg.execUsdcContractId,
  });
  const executor = createExecutor(soroban, wallet);

  runtime = {
    cfg,
    db,
    blendSource,
    defindexSource,
    poolDiscovery,
    executor,
    agentKeypair,
    execServer,
    lastScan: [],
    lastDecision: null,
    lastRebalanceAt: 0,
    running: false,
    poolIds: null,
  };
  return runtime;
}

/**
 * Read a smart wallet's USDC balance (stroops) via the USDC SAC `balance(addr)`
 * read-only simulation. The agent key is only the (free) simulation source — no
 * signing. Returns 0n on any error so a single unreadable account can't abort
 * the per-user loop.
 */
async function readUsdcBalance(rt: Runtime, who: string): Promise<bigint> {
  try {
    const src = await rt.execServer.getAccount(rt.agentKeypair.publicKey());
    const tx = new TransactionBuilder(src, {
      fee: BASE_FEE,
      networkPassphrase: rt.cfg.execNetworkPassphrase,
    })
      .addOperation(
        new Contract(rt.cfg.execUsdcContractId).call(
          "balance",
          nativeToScVal(Address.fromString(who), { type: "address" }),
        ),
      )
      .setTimeout(30)
      .build();
    const sim = await rt.execServer.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) return 0n;
    const retval = (sim as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    if (!retval) return 0n;
    return BigInt(scValToNative(retval).toString());
  } catch {
    return 0n;
  }
}

/**
 * Build the per-user supply function: a policy-signer wallet for THIS user's
 * smart account (signing under their pool + USDC rule ids) wired into an
 * executor whose Blend `from/spender/to` is the user's smart wallet. Supplies
 * `amount` stroops of USDC into the exec pool via `SupplyCollateral`.
 */
function supplyForUser(rt: Runtime, user: UserRegistration, amount: bigint): Promise<TxResult> {
  const wallet = createPolicySignerWallet({
    smartWalletId: user.smartWallet,
    agentKeypair: rt.agentKeypair,
    rpcUrl: rt.cfg.execRpcUrl,
    networkPassphrase: rt.cfg.execNetworkPassphrase,
    verifier: rt.cfg.ed25519VerifierId,
    // Present both rule ids: pool.submit (root CallContract(POOL)) + nested
    // USDC.transfer (CallContract(USDC), spending-capped).
    contextRuleIds: [user.poolRuleId, user.usdcRuleId],
    server: rt.execServer,
  });
  const client = createSorobanClient({
    rpcUrl: rt.cfg.execRpcUrl,
    networkPassphrase: rt.cfg.execNetworkPassphrase,
    walletAddress: user.smartWallet, // funds move FROM the smart wallet
    usdcId: rt.cfg.execUsdcContractId,
  });
  return createExecutor(client, wallet).deposit(rt.cfg.execPoolId, amount);
}

/**
 * One scan→score→decide(→execute) cycle.
 *
 * `doExecute` gates the money-moving side: when false the cycle only refreshes
 * the cached scan + decision (used by the lazy/manual scan refresh, which must
 * be side-effect-free); when true it also runs the per-user supply (the daily
 * Cron / autonomous tick). Scan + decision are cached either way so the UI is
 * always fed.
 */
async function tick(rt: Runtime, doExecute: boolean): Promise<void> {
  if (rt.running) return; // idempotency: never overlap ticks
  rt.running = true;
  try {
    const now = Math.floor(Date.now() / 1000);
    const perUser = rt.cfg.walletMode === "smart-account";
    // In smart-account mode the legacy single-keypair-wallet execution is a
    // no-op: the real action is the PER-USER loop below (each user's own smart
    // account). We still run scan+score+decide ONCE here (it caches lastScan /
    // lastDecision for the UI and yields the chosen pool).
    const noopExec = async (): Promise<TxResult> => ({ hashes: [], success: true });
    const r = await runTick({
      scan: async () => {
        const poolIds = rt.poolIds && rt.poolIds.length ? rt.poolIds : rt.cfg.scanBlendPoolIds;
        const s = await scanSource(rt.blendSource, poolIds);
        if (rt.defindexSource) {
          const dfx = await scanSource(
            rt.defindexSource,
            rt.cfg.scanDefindexStrategies.map((x) => x.strategyId),
          );
          s.push(...dfx);
        }
        // Cache the SCORED pools (deterministic; matches what runTick scores
        // internally) so the UI gets riskScore/eligible/reason without a re-scan.
        rt.lastScan = scorePools(s, rt.cfg.tolerance);
        // Persist to Mongo so route handlers (separate serverless invocations)
        // read the latest snapshot regardless of which one writes vs. reads.
        const scanAt = Date.now();
        await rt.db.setKV("lastScan", JSON.stringify(serializeScoredPools(rt.lastScan)));
        await rt.db.setKV("lastScanAt", String(scanAt));
        return s;
      },
      tolerance: rt.cfg.tolerance,
      getPosition: () => rt.db.getPosition(),
      // Wrap `decide` so the chosen pool + rationale are captured for the UI.
      decide: async (ctx) => {
        const decision = decide(ctx);
        rt.lastDecision = {
          action: decision.action,
          chosenPoolId: decision.action === "rebalance" ? decision.toPool ?? null : null,
          rationale: decision.rationale,
        };
        // Persist decision to Mongo for cross-invocation visibility.
        await rt.db.setKV("lastDecision", JSON.stringify(rt.lastDecision));
        return decision;
      },
      // Execution always targets the single testnet exec pool regardless of which
      // mainnet pool had the best yield — multi-pool exec is future work. In
      // smart-account mode these are no-ops (the per-user loop does the work);
      // in keypair mode they only fire when this is an executing tick.
      rebalance: (_fromMainnet, _toMainnet, a) =>
        perUser || !doExecute ? noopExec() : rt.executor.deposit(rt.cfg.execPoolId, a),
      deposit: (_chosenMainnetPool, a) =>
        perUser || !doExecute ? noopExec() : rt.executor.deposit(rt.cfg.execPoolId, a),
      commitPosition: (p) => rt.db.setPosition(p),
      log: (k, m, meta) => rt.db.log(k, m, meta),
      recordRebalance: (a) => rt.db.recordRebalance(a),
      rebalancedSince: (s) => rt.db.rebalancedSince(s),
      minYieldDeltaBps: rt.cfg.minYieldDeltaBps,
      perTxCapStroops: rt.cfg.perTxCapStroops,
      dailyCapStroops: rt.cfg.dailyCapStroops,
      cooldownSec: rt.cfg.rebalanceCooldownSec,
      lastRebalanceAt: rt.lastRebalanceAt,
      now,
    });
    if (r.acted) rt.lastRebalanceAt = now;

    // ── PER-USER execution (ARMA model) ──────────────────────────────────────
    // The decision was made ONCE above; now supply each registered user's idle
    // USDC into the chosen exec pool via THEIR smart account. Only on executing
    // ticks (the daily Cron) — the lazy/manual scan refresh passes doExecute=false.
    if (perUser && doExecute) {
      const chosenPoolId = rt.lastDecision?.chosenPoolId ?? null;
      const result = await runPerUserExecution(
        {
          users: await registry.listUsers(),
          execPoolId: rt.cfg.execPoolId,
          supplyForUser: (user, amount) => supplyForUser(rt, user, amount),
          getUserPosition: (sw) => registry.getUserPosition(sw),
          setUserPosition: (sw, p) => registry.setUserPosition(sw, p),
          idleUsdcForUser: (user) => readUsdcBalance(rt, user.smartWallet),
          log: (k, m, meta) => rt.db.log(k, m, meta),
          perTxCapStroops: rt.cfg.perTxCapStroops,
        },
        chosenPoolId,
      );
      if (result.supplied > 0) {
        rt.lastRebalanceAt = now;
        // Mirror the per-user supply into the legacy singleton position so the
        // graph's `activePoolId` check triggers the blue glow + ripple animation.
        // IMPORTANT: use the MAINNET pool ID (the decision's chosen pool or best eligible)
        // — the testnet execPoolId never matches a displayed graph node.
        const prev = await rt.db.getPosition();
        if (!prev.poolId) {
          const mainnetPoolId =
            rt.lastDecision?.chosenPoolId ??
            bestPool(rt.lastScan)?.poolId ??
            rt.cfg.execPoolId;
          await rt.db.setPosition({
            poolId: mainnetPoolId,
            amountUsdc: result.totalStroops,
          });
        }
      }
    }
  } catch (e) {
    await rt.db.log("error", `tick failed: ${(e as Error).message}`);
  } finally {
    rt.running = false;
  }
}

/** Persist a discovery result to Mongo so future invocations skip the on-chain fetch. */
async function cacheDiscovery(rt: Runtime, poolIds: string[]): Promise<void> {
  await rt.db.setKV("discoveredPools", JSON.stringify(poolIds));
  await rt.db.setKV("discoveredAt", String(Date.now()));
}

/** Read the cached discovery result from Mongo, or null if none. */
async function readDiscoveryCache(
  rt: Runtime,
): Promise<{ poolIds: string[]; discoveredAt: number } | null> {
  const raw = await rt.db.getKV("discoveredPools");
  const atRaw = await rt.db.getKV("discoveredAt");
  if (!raw || !atRaw) return null;
  try {
    const poolIds = JSON.parse(raw) as string[];
    const discoveredAt = Number(atRaw);
    if (!Array.isArray(poolIds) || !Number.isFinite(discoveredAt)) return null;
    return { poolIds, discoveredAt };
  } catch {
    return null;
  }
}

/**
 * Resolve (once per warm process) the Blend pool ids to scan: in-memory cache →
 * Mongo discovery cache → fresh on-chain discovery → curated fallback. No
 * background refresh — on serverless any work after the response is frozen, so
 * the daily Cron is what re-discovers.
 */
async function ensurePoolIds(rt: Runtime): Promise<void> {
  if (rt.poolIds && rt.poolIds.length) return;

  const cached = await readDiscoveryCache(rt);
  if (cached && cached.poolIds.length) {
    rt.poolIds = cached.poolIds;
    await rt.db.log("discovery", `using ${cached.poolIds.length} cached pool id(s)`, {
      poolIds: cached.poolIds,
      source: "cache",
      discoveredAt: cached.discoveredAt,
    });
    return;
  }

  try {
    const discovered = await rt.poolDiscovery.discoverPoolIds();
    rt.poolIds = discovered;
    await cacheDiscovery(rt, discovered);
    const fromOnchain = !arraysEqual(discovered, rt.cfg.scanBlendPoolIds);
    await rt.db.log(
      "discovery",
      `discovered ${discovered.length} Blend pool(s) (${fromOnchain ? "on-chain" : "fallback"})`,
      { poolIds: discovered, source: fromOnchain ? "onchain" : "fallback" },
    );
  } catch (e) {
    rt.poolIds = rt.cfg.scanBlendPoolIds;
    await rt.db.log(
      "discovery",
      `pool discovery failed, using ${rt.poolIds.length} fallback pool(s): ${(e as Error).message}`,
      { poolIds: rt.poolIds, source: "fallback" },
    );
  }
}

/**
 * Full autonomous tick: ensure pool ids, then scan → score → decide → execute
 * (supply each registered user's idle USDC). This is what the daily Vercel Cron
 * (`POST /api/tick`) invokes. The original 30s `setInterval` loop is gone —
 * serverless has no persistent process to host it.
 */
export async function runAgentTick(): Promise<void> {
  const rt = getRuntime();
  await ensurePoolIds(rt);
  await tick(rt, true);
}

/**
 * Side-effect-free refresh: ensure pool ids, then scan → score → decide and
 * cache the result WITHOUT moving any funds. Used to populate the cache lazily.
 */
export async function runScanRefresh(): Promise<void> {
  const rt = getRuntime();
  await ensurePoolIds(rt);
  await tick(rt, false);
}

/**
 * Lazy "run on app start" behavior for serverless: if no scan has ever been
 * cached, run one side-effect-free refresh so the first dashboard load has data.
 * Thereafter the daily Cron keeps it fresh. Best-effort — failures are swallowed
 * so the dashboard still renders whatever (if anything) is cached.
 */
export async function ensureScanPopulated(): Promise<void> {
  const rt = getRuntime();
  try {
    const at = await rt.db.getKV("lastScanAt");
    if (!at) await runScanRefresh();
  } catch {
    /* serve cached data on any refresh error */
  }
}

/**
 * Continuous in-process loop for LONG-LIVED servers only (local `next dev` /
 * `next start`). No-op on Vercel, where there is no persistent process — the
 * daily Cron + lazy {@link ensureScanPopulated} drive ticks instead. Idempotent.
 */
export async function startLocalLoop(): Promise<void> {
  if (process.env.VERCEL) return; // serverless → Cron-driven, not loop-driven
  const rt = getRuntime();
  await ensurePoolIds(rt);
  await tick(rt, true);
  setInterval(() => {
    void tick(rt, true);
  }, rt.cfg.scanIntervalSec * 1000);
}

// ── Accessors for the route handlers ────────────────────────────────────────

export function getPosition(): Promise<Position> {
  return getRuntime().db.getPosition();
}

export async function getSerializedPosition(): Promise<SerializedPosition> {
  return serializePosition(await getRuntime().db.getPosition());
}

export function getRecentLog(n = 50) {
  return getRuntime().db.recentLog(n);
}

/**
 * Read an address's exec-side USDC balance in stroops (via the USDC SAC
 * `balance(addr)` read-only simulation). Used by `/api/faucet` to report the
 * recipient's balance after a mint. Returns 0n on any error.
 */
export function getUsdcBalanceStroops(who: string): Promise<bigint> {
  return readUsdcBalance(getRuntime(), who);
}

// ── Per-user registry accessors (ARMA model) ─────────────────────────────────

/** Zod shape for `POST /api/register` bodies. */
export const RegisterInput = z.object({
  owner: z.string().min(1),
  smartWallet: z.string().min(1),
  poolRuleId: z.coerce.number().int().nonnegative(),
  usdcRuleId: z.coerce.number().int().nonnegative(),
});
export type RegisterInputT = z.infer<typeof RegisterInput>;

/** Register (upsert) a user's smart account + agent rule ids; returns the row. */
export async function registerUser(input: RegisterInputT): Promise<UserRegistration> {
  const rt = getRuntime();
  // Preserve the original createdAt on re-register so loop ordering is stable.
  const existing = await registry.getUser(input.owner);
  const reg: UserRegistration = {
    owner: input.owner,
    smartWallet: input.smartWallet,
    poolRuleId: input.poolRuleId,
    usdcRuleId: input.usdcRuleId,
    createdAt: existing?.createdAt ?? Math.floor(Date.now() / 1000),
  };
  await registry.registerUser(reg);
  await rt.db.log("register", `registered user ${reg.owner.slice(0, 8)}… → SA ${reg.smartWallet}`, {
    smartWallet: reg.smartWallet,
    poolRuleId: reg.poolRuleId,
    usdcRuleId: reg.usdcRuleId,
  });
  return reg;
}

/** All registered users, each with their current per-user position (serialized). */
export async function listUsers(): Promise<Array<UserRegistration & { position: SerializedPosition }>> {
  const users = await registry.listUsers();
  return Promise.all(
    users.map(async (u) => ({
      ...u,
      position: serializePosition(await registry.getUserPosition(u.smartWallet)),
    })),
  );
}

/** One user's registration + position by owner, or null if not registered. */
export async function getUserWithPosition(
  owner: string,
): Promise<(UserRegistration & { position: SerializedPosition }) | null> {
  const u = await registry.getUser(owner);
  if (!u) return null;
  return { ...u, position: serializePosition(await registry.getUserPosition(u.smartWallet)) };
}

/**
 * Remove ONE user from the registry (the demo "disconnect this user" affordance),
 * so the onboarding re-appears for that owner. Returns true if the owner was
 * registered. Logs the removal for the activity ticker.
 */
export async function unregisterUser(owner: string): Promise<boolean> {
  const rt = getRuntime();
  const removed = await registry.removeUser(owner);
  if (removed) {
    await rt.db.log("reset", `unregistered user ${owner.slice(0, 8)}… (demo reset)`, { owner });
    // Clear the singleton position so the graph returns to neutral and the
    // next demo run gets a fresh "wow moment" when supply lands.
    await rt.db.setPosition({ poolId: null, amountUsdc: 0n });
  }
  return removed;
}

/**
 * Clear the ENTIRE registry (all users + positions) so the whole demo can be
 * re-run. Returns the number of users removed.
 */
export async function resetRegistry(): Promise<number> {
  const rt = getRuntime();
  const removed = await registry.clearRegistry();
  await rt.db.log("reset", `cleared registry — ${removed} user(s) removed (demo reset)`, { removed });
  return removed;
}

/**
 * Diagnostic accessor: the registry store id. With Mongo this is a constant
 * ("mongo:yieldseeker"); kept for the legacy sharing probe / `/api/reset` GET.
 */
export function registryStoreId(): string {
  return registry.registryStoreId();
}

/** Shape returned by `/api/scan`. */
export interface ScanSnapshot {
  pools: SerializedScoredPool[];
  /** Epoch-ms when the snapshot was last written; null on a true cold start. */
  updatedAt: number | null;
}

/**
 * Most-recent SCORED scan — reads from Mongo so it is consistent regardless of
 * which serverless invocation (Cron tick vs. route handler) wrote it. Falls back
 * to the in-memory copy when Mongo has no snapshot yet (very first request before
 * the first tick completes).
 *
 * Returns a {@link ScanSnapshot} with `updatedAt` so the UI can show how fresh
 * the cached data is.
 */
export async function getLastScan(): Promise<ScanSnapshot> {
  const rt = getRuntime();
  const raw = await rt.db.getKV("lastScan");
  const atRaw = await rt.db.getKV("lastScanAt");
  const updatedAt = atRaw ? Number(atRaw) || null : null;

  if (raw) {
    try {
      const pools = JSON.parse(raw) as SerializedScoredPool[];
      return { pools, updatedAt };
    } catch {
      // corrupt entry; fall through to in-memory copy
    }
  }
  return { pools: serializeScoredPools(rt.lastScan), updatedAt };
}

/**
 * Latest agent decision — reads from Mongo so it is consistent across serverless
 * invocations. Falls back to the in-memory copy / default when Mongo has no entry.
 */
export async function getDecision(): Promise<LatestDecision> {
  const rt = getRuntime();
  const raw = await rt.db.getKV("lastDecision");
  if (raw) {
    try {
      return JSON.parse(raw) as LatestDecision;
    } catch {
      // corrupt entry; fall through to in-memory copy
    }
  }
  return rt.lastDecision ?? { action: "hold", chosenPoolId: null, rationale: "" };
}
