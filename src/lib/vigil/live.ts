/**
 * Live, read-only mainnet readers for the Vigil engine (Soroban RPC + Horizon + Stellar Expert).
 *
 * Nothing here signs or submits: every contract read is a `simulateTransaction` of a view call
 * from a dummy source account. Tests never import this module — they inject fakes into engine.ts.
 */
import { PoolV2, type Network } from "@blend-capital/blend-sdk";
import { Account, Address, Contract, TransactionBuilder, contract, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { ContractInfo, AggregatorConfig } from "./oracle";
import { attributeSources, classifyPoolOracle, isAggregatorInterface } from "./oracle";
import type { AssetKey, BackstopSnapshot, DexDepth, PoolSnapshot, ReserveSnapshot } from "./types";
import { SDEX_PRICED_KINDS } from "./types";
import { THRESHOLDS } from "./score";
import type { PoolVerifier } from "./discovery";

/** One Blend deployment: a pool factory and the backstop its pools insure into. */
export interface BlendDeployment {
  /** Label shown on ratings, e.g. "v2" or "v2.1". */
  name: string;
  factoryId: string;
  backstopId: string;
}

export interface LiveConfig {
  rpcUrl: string;
  passphrase: string;
  horizonUrl?: string;
  /** Blend V2 runs two deployments on mainnet (V2, and v2.1 since 2026-09-30); every one is read. */
  deployments: BlendDeployment[];
  /** Delay between RPC calls (ms) to stay polite with public RPC. */
  callDelayMs?: number;
  fetchImpl?: typeof fetch;
  /** Classic USDC used as the SDEX quote asset. */
  usdcClassic?: { code: string; issuer: string };
}

const DUMMY_SOURCE = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
const REFLECTOR_DEX = "CALI2BYU2JE6WVRUFYTS6MSBNEHGJ35P4AVCZYF3B6QOE3QKOB2PLE6M";
const REFLECTOR_CEX = "CAFJZQWSED6YAWZU3GWRTOCNPPCGBN32L7QV43XX5LZLFTK6JLN34DLN";
const MAINNET_USDC = { code: "USDC", issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" };
const HORIZON_MAX_LEVELS = 200;

type Native = unknown;

export function createLiveReaders(cfg: LiveConfig) {
  const server = new rpc.Server(cfg.rpcUrl);
  const network: Network = { rpc: cfg.rpcUrl, passphrase: cfg.passphrase };
  const horizon = cfg.horizonUrl ?? "https://horizon.stellar.org";
  const doFetch = cfg.fetchImpl ?? fetch;
  const delay = cfg.callDelayMs ?? 150;
  const usdc = cfg.usdcClassic ?? MAINNET_USDC;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function fetchJson(url: string): Promise<unknown> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const res = await doFetch(url);
      if (res.status === 429 || res.status >= 500) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      return res.json();
    }
    throw new Error(`rate-limited: ${url}`);
  }

  /** Simulate a read-only call. Returns the raw retval, or throws with the host error. */
  async function simRaw(contractId: string, fn: string, ...args: xdr.ScVal[]): Promise<xdr.ScVal | null> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      await sleep(delay);
      try {
        const tx = new TransactionBuilder(new Account(DUMMY_SOURCE, "0"), { fee: "100", networkPassphrase: cfg.passphrase })
          .addOperation(new Contract(contractId).call(fn, ...args))
          .setTimeout(30)
          .build();
        const sim = await server.simulateTransaction(tx);
        if (rpc.Api.isSimulationError(sim)) throw new Error(String(sim.error).split("\n")[0].slice(0, 160));
        return sim.result?.retval ?? null;
      } catch (e) {
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        if (/HostError/.test(msg)) throw e; // deterministic contract error — no retry
        await sleep(1000 * (attempt + 1));
      }
    }
    throw lastErr;
  }
  async function sim(contractId: string, fn: string, ...args: xdr.ScVal[]): Promise<Native> {
    const r = await simRaw(contractId, fn, ...args);
    return r ? scValToNative(r) : null;
  }
  async function trySim(contractId: string, fn: string, ...args: xdr.ScVal[]): Promise<Native | undefined> {
    try {
      return await sim(contractId, fn, ...args);
    } catch {
      return undefined;
    }
  }

  const stellarAsset = (id: string) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Stellar"), new Address(id).toScVal()]);
  const otherAsset = (sym: string) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Other"), xdr.ScVal.scvSymbol(sym)]);

  // ── caches ────────────────────────────────────────────────────────────────
  const infoCache = new Map<string, Promise<ContractInfo>>();
  const tokenCache = new Map<string, Promise<{ symbol: string; classic?: ReserveSnapshot["classic"]; notToken?: boolean }>>();

  function readContractInfo(id: string): Promise<ContractInfo> {
    if (!infoCache.has(id)) infoCache.set(id, loadContractInfo(id));
    return infoCache.get(id)!;
  }

  async function loadContractInfo(id: string): Promise<ContractInfo> {
    let functions: string[] | null = null;
    try {
      const wasm = await server.getContractWasmByContractId(id);
      functions = contract.Spec.fromWasm(wasm)
        .funcs()
        .map((f) => f.name().toString());
    } catch {
      functions = null;
    }
    let creator: string | null = null;
    let wasmHash: string | null = null;
    let verifiedRepo: string | null = null;
    try {
      const se = (await fetchJson(`https://api.stellar.expert/explorer/public/contract/${id}`)) as {
        creator?: string;
        wasm?: string;
        validation?: { repository?: string };
      };
      creator = se.creator ?? null;
      wasmHash = se.wasm ?? null;
      verifiedRepo = se.validation?.repository ?? null;
    } catch {
      /* metadata is best-effort */
    }
    const has = (f: string) => functions?.includes(f) ?? false;
    const base = has("base") ? toAssetKey(await trySim(id, "base")) : null;
    const admin = has("admin") ? asString(await trySim(id, "admin")) : null;
    const resolution = has("resolution") ? asNumber(await trySim(id, "resolution")) : null;
    const lastTimestamp = has("last_timestamp") ? asNumber(await trySim(id, "last_timestamp")) : null;
    let assets: AssetKey[] | null = null;
    if (has("assets") && !isAggregatorInterface(functions)) {
      const a = await trySim(id, "assets");
      assets = Array.isArray(a) ? a.slice(0, 40).map(toAssetKey).filter((x): x is AssetKey => !!x) : null;
    }
    return { id, functions, creator, wasmHash, verifiedRepo, base, admin, resolutionSec: resolution, assets, lastTimestamp };
  }

  async function readAggregatorConfig(id: string): Promise<AggregatorConfig | null> {
    try {
      const oraclesN = (await sim(id, "oracles")) as { address: string; index: number; resolution: number; decimals: number }[];
      const rawCfg = await simRaw(id, "asset_configs");
      const assetConfigs: AggregatorConfig["assetConfigs"] = [];
      for (const e of rawCfg?.map() ?? []) {
        const asset = toAssetKey(scValToNative(e.key()));
        const v = scValToNative(e.val()) as { asset: Native; oracle_index: number; max_dev: number };
        const sourceAsset = toAssetKey(v.asset);
        if (asset && sourceAsset) assetConfigs.push({ asset, sourceAsset, oracleIndex: Number(v.oracle_index), maxDevPct: Number(v.max_dev) });
      }
      const base = toAssetKey(await sim(id, "base"));
      const maxAge = asNumber(await sim(id, "max_age"));
      const decimals = asNumber(await sim(id, "decimals"));
      const assetsN = await sim(id, "assets");
      if (!base) return null;
      return {
        base,
        maxAgeSec: maxAge ?? 0,
        decimals: decimals ?? 7,
        oracles: (oraclesN ?? []).map((o) => ({ address: o.address, index: Number(o.index), resolutionSec: Number(o.resolution), decimals: Number(o.decimals) })),
        assetConfigs,
        assets: Array.isArray(assetsN) ? assetsN.map(toAssetKey).filter((x): x is AssetKey => !!x) : [],
      };
    } catch {
      return null;
    }
  }

  function tokenMeta(assetId: string) {
    if (!tokenCache.has(assetId)) {
      tokenCache.set(
        assetId,
        (async () => {
          const name = asString(await trySim(assetId, "name"));
          const sym = asString(await trySim(assetId, "symbol"));
          if (name === "native") return { symbol: "XLM", classic: { native: true as const } };
          if (name && /^[A-Za-z0-9]{1,12}:G[A-Z2-7]{55}$/.test(name)) {
            const [code, issuer] = name.split(":");
            return { symbol: sym ?? code, classic: { code, issuer } };
          }
          return { symbol: sym ?? assetId.slice(0, 6), notToken: !name && !sym };
        })(),
      );
    }
    return tokenCache.get(assetId)!;
  }

  async function lastPrice(oracleId: string, key: xdr.ScVal): Promise<{ price: bigint; timestamp: number } | null> {
    try {
      const v = (await sim(oracleId, "lastprice", key)) as { price?: bigint; timestamp?: bigint } | null;
      if (!v || v.price === undefined || v.timestamp === undefined) return null;
      return { price: BigInt(v.price), timestamp: Number(v.timestamp) };
    } catch {
      return null;
    }
  }

  async function orderBook(classic: NonNullable<ReserveSnapshot["classic"]>, assetId: string): Promise<DexDepth | null> {
    const sel =
      "native" in classic
        ? "selling_asset_type=native"
        : `selling_asset_type=${classic.code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12"}&selling_asset_code=${classic.code}&selling_asset_issuer=${classic.issuer}`;
    const buy = `buying_asset_type=credit_alphanum4&buying_asset_code=${usdc.code}&buying_asset_issuer=${usdc.issuer}`;
    if (!("native" in classic) && classic.code === usdc.code && classic.issuer === usdc.issuer) return null;
    try {
      const ob = (await fetchJson(`${horizon}/order_book?${sel}&${buy}&limit=${HORIZON_MAX_LEVELS}`)) as { asks?: { price: string; amount: string }[] };
      const asks = (ob.asks ?? []).map((a) => ({ price: Number(a.price), amount: Number(a.amount) })).sort((a, b) => a.price - b.price);
      return { assetId, quote: "USDC", asks, truncated: asks.length >= HORIZON_MAX_LEVELS, source: `${horizon}/order_book (vs USDC)` };
    } catch {
      return null;
    }
  }

  async function backstopData(backstopId: string, poolId: string): Promise<BackstopSnapshot | null> {
    try {
      const v = (await sim(backstopId, "pool_data", new Address(poolId).toScVal())) as {
        tokens: bigint;
        shares: bigint;
        q4w_pct: bigint;
        blnd: bigint;
        usdc: bigint;
      };
      return {
        tokens: Number(v.tokens) / 1e7,
        shares: Number(v.shares) / 1e7,
        q4wPct: Number(v.q4w_pct) / 1e7,
        blnd: Number(v.blnd) / 1e7,
        usdc: Number(v.usdc) / 1e7,
        meetsThreshold: meetsBackstopThreshold(BigInt(v.blnd), BigInt(v.usdc)),
      };
    } catch {
      return null;
    }
  }

  async function chainTime(): Promise<{ timestamp: number; ledger?: number }> {
    try {
      const l = await server.getLatestLedger();
      const t = Number(l.closeTime);
      return { timestamp: Number.isFinite(t) && t > 0 ? t : Math.floor(Date.now() / 1000), ledger: l.sequence };
    } catch {
      return { timestamp: Math.floor(Date.now() / 1000) };
    }
  }

  /** Build the full scoring snapshot for one pool. */
  async function snapshot(poolId: string): Promise<PoolSnapshot> {
    const dataGaps: string[] = [];
    const asOf = await chainTime();
    const pool = await PoolV2.load(network, poolId);
    const m = pool.metadata;
    const oracleInfo = await readContractInfo(m.oracle);
    const oracleKind = classifyPoolOracle(oracleInfo);
    const aggregator = oracleKind === "blend_aggregator" || oracleKind === "aggregator_compatible" ? await readAggregatorConfig(m.oracle) : null;
    if ((oracleKind === "blend_aggregator" || oracleKind === "aggregator_compatible") && !aggregator) dataGaps.push(`aggregator config unreadable on ${m.oracle}`);

    const feeds: Record<string, ContractInfo> = {};
    for (const o of aggregator?.oracles ?? []) feeds[o.address] = await readContractInfo(o.address);

    let oracleDecimals = 7;
    const dec = asNumber(await trySim(m.oracle, "decimals"));
    if (dec !== null) oracleDecimals = dec;
    else dataGaps.push(`decimals() failed on pool oracle ${m.oracle}`);

    const reserves = [...pool.reserves.values()];
    const prices: Record<string, { price: bigint; timestamp: number } | null> = {};
    const metas: Record<string, { symbol: string; classic?: ReserveSnapshot["classic"] }> = {};
    for (const r of reserves) {
      metas[r.assetId] = await tokenMeta(r.assetId);
      if ((metas[r.assetId] as { notToken?: boolean }).notToken) dataGaps.push(`reserve ${r.assetId.slice(0, 6)}… answers neither name() nor symbol() — not a token contract`);
      prices[r.assetId] = await lastPrice(m.oracle, stellarAsset(r.assetId));
      if (!prices[r.assetId]) dataGaps.push(`no lastprice for ${metas[r.assetId].symbol} (${r.assetId.slice(0, 6)}…) from ${m.oracle.slice(0, 6)}…`);
    }

    // Opaque adapters: infer the source by exact (value, timestamp) match against known feeds.
    const priceMatches: Record<string, string | undefined> = {};
    if (oracleKind === "opaque") {
      for (const r of reserves) {
        const p = prices[r.assetId];
        if (!p) continue;
        const candidates: [string, xdr.ScVal][] = [[REFLECTOR_DEX, stellarAsset(r.assetId)]];
        const sym = metas[r.assetId].symbol;
        if (/^[A-Z]{2,6}$/.test(sym)) candidates.push([REFLECTOR_CEX, otherAsset(sym)]);
        outer: for (const [feedId, key] of candidates) {
          // Read feed then pool oracle back-to-back; retry once if an oracle round ticked in between.
          for (let attempt = 0; attempt < 2; attempt++) {
            const fp = await lastPrice(feedId, key);
            const pp = await lastPrice(m.oracle, stellarAsset(r.assetId));
            if (!fp || !pp) break;
            if (fp.timestamp !== pp.timestamp) continue;
            const a = Number(pp.price) / 10 ** oracleDecimals;
            const b = Number(fp.price) / 1e14; // Reflector feeds report 14 decimals
            // Same round; equal up to the adapter's own precision (it may truncate 14 → 7 decimals).
            if (Math.abs(a - b) <= Math.max(Math.abs(b) * 1e-9, 1.01 * 10 ** -oracleDecimals)) {
              priceMatches[r.assetId] = feedId;
              if (!feeds[feedId]) feeds[feedId] = await readContractInfo(feedId);
              break outer;
            }
            break;
          }
        }
      }
    }

    const sources = attributeSources({
      poolOracle: oracleInfo,
      oracleKind,
      aggregator,
      feeds,
      reserveAssetIds: reserves.map((r) => r.assetId),
      pricePresent: Object.fromEntries(reserves.map((r) => [r.assetId, !!prices[r.assetId]])),
      priceMatches,
    });

    const out: ReserveSnapshot[] = reserves.map((r) => {
      const c = r.config as typeof r.config & { supply_cap?: bigint; enabled?: boolean };
      const scale = 10 ** c.decimals;
      const capRaw = c.supply_cap;
      const supplyCap = capRaw === undefined || capRaw >= 2n ** 62n ? null : Number(capRaw) / scale;
      const p = prices[r.assetId];
      return {
        assetId: r.assetId,
        symbol: metas[r.assetId].symbol,
        classic: metas[r.assetId].classic,
        decimals: c.decimals,
        cFactor: c.c_factor / 1e7,
        lFactor: c.l_factor / 1e7,
        maxUtil: c.max_util / 1e7,
        supplyCap,
        enabled: c.enabled ?? true,
        supplied: r.totalSupplyFloat(),
        borrowed: r.totalLiabilitiesFloat(),
        priceUsd: p ? Number(p.price) / 10 ** oracleDecimals : null,
        priceTimestamp: p ? p.timestamp : null,
        source: sources[r.assetId],
        supplyApr: Number.isFinite(r.supplyApr) ? r.supplyApr : null,
        borrowApr: Number.isFinite(r.borrowApr) ? r.borrowApr : null,
      };
    });

    const dexDepth: Record<string, DexDepth> = {};
    for (const r of out) {
      if (!(r.enabled && r.cFactor >= THRESHOLDS.minCollateralFactor && SDEX_PRICED_KINDS.has(r.source.kind))) continue;
      if (!r.classic) {
        dataGaps.push(`${r.symbol} is SDEX-priced but not a classic asset (no SDEX book)`);
        continue;
      }
      const ob = await orderBook(r.classic, r.assetId);
      if (ob) dexDepth[r.assetId] = ob;
      else dataGaps.push(`SDEX order book unavailable for ${r.symbol}`);
    }

    // The backstop named in the pool's own config: V2 and v2.1 pools insure into different ones.
    const backstop = await backstopData(m.backstop, poolId);
    if (!backstop) dataGaps.push(`backstop pool_data unreadable on ${m.backstop}`);
    const deployment = cfg.deployments.find((x) => x.backstopId === m.backstop)?.name;
    if (!deployment) dataGaps.push(`pool's backstop ${m.backstop} is not a known Blend deployment`);

    return {
      poolId,
      name: m.name,
      protocol: "blend",
      status: m.status,
      admin: m.admin,
      oracleId: m.oracle,
      oracleKind,
      backstopRate: m.backstopRate / 1e7,
      reserves: out,
      backstopId: m.backstop,
      ...(deployment ? { deployment } : {}),
      backstop,
      dexDepth,
      asOf,
      dataGaps,
      provenance: `live mainnet (${cfg.rpcUrl}, ${horizon})`,
    };
  }

  /**
   * Factory `is_pool(address)` — the factory's own record of pools it deployed. True if any
   * deployment's factory deployed it, false if every factory answered no, null if one could not
   * be asked and none said yes.
   */
  const verifier: PoolVerifier = {
    async isPool(poolId: string) {
      let unknown = false;
      for (const dep of cfg.deployments) {
        try {
          if ((await sim(dep.factoryId, "is_pool", new Address(poolId).toScVal())) === true) return true;
        } catch {
          unknown = true;
        }
      }
      return unknown ? null : false;
    },
  };

  /** A backstop's reward zone (the V2 one is empty on mainnet; kept as a discovery source). */
  async function rewardZone(backstopId: string): Promise<string[]> {
    const v = await sim(backstopId, "reward_zone");
    return Array.isArray(v) ? (v as string[]) : [];
  }

  /** DeFindex Blend strategy: on-chain Config (pool, asset) and managed amount. */
  async function readStrategy(strategyId: string): Promise<{ pool: string | null; asset: string | null; managedTokens: number | null }> {
    try {
      const key = xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: new Address(strategyId).toScAddress(),
          key: xdr.ScVal.scvLedgerKeyContractInstance(),
          durability: xdr.ContractDataDurability.persistent(),
        }),
      );
      const res = await server.getLedgerEntries(key);
      const inst = res.entries[0]?.val.contractData().val().instance();
      let pool: string | null = null;
      let asset: string | null = null;
      let managedTokens: number | null = null;
      for (const e of inst?.storage() ?? []) {
        const k = scValToNative(e.key());
        const v = scValToNative(e.val()) as Record<string, unknown>;
        const name = Array.isArray(k) ? String(k[0]) : String(k);
        if (name === "Config" && v) {
          pool = typeof v.pool === "string" ? v.pool : null;
          asset = typeof v.asset === "string" ? v.asset : null;
        }
        if (name === "Reserves" && v && v.total_b_tokens !== undefined && v.b_rate !== undefined) {
          // b_rate has 12 decimals in Blend v2; amounts are 7-decimal token units.
          managedTokens = (Number(v.total_b_tokens) * Number(v.b_rate)) / 1e12 / 1e7;
        }
      }
      return { pool, asset, managedTokens };
    } catch {
      return { pool: null, asset: null, managedTokens: null };
    }
  }

  return { snapshot, verifier, rewardZone, readStrategy, fetchJson, readContractInfo };
}

/** Blend v2 backstop threshold (pool/src/pool/status.rs calc_pool_backstop_threshold): floor(blnd)^4 · floor(usdc) ≥ 1e25. */
export function meetsBackstopThreshold(blndStroops: bigint, usdcStroops: bigint): boolean {
  const b = blndStroops / 10_000_000n;
  const u = usdcStroops / 10_000_000n;
  return b * b * b * b * u >= 10n ** 25n;
}

function toAssetKey(v: Native): AssetKey | null {
  if (Array.isArray(v) && v.length === 2) {
    if (v[0] === "Stellar" && typeof v[1] === "string") return { type: "Stellar", address: v[1] };
    if (v[0] === "Other" && typeof v[1] === "string") return { type: "Other", symbol: v[1] };
  }
  return null;
}
function asString(v: Native): string | null {
  return typeof v === "string" ? v : null;
}
function asNumber(v: Native): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  return null;
}
