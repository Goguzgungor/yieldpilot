# YieldSeeker · Multiple Yield Sources (read-side) + DeFindex — Design Spec

- **Date:** 2026-06-02
- **Status:** Design approved; the next step is the implementation plan (writing-plans)
- **Context source:** Deep-research report (Stellar yield sources, 25 sources / 25 cross-verified claims) + the current code map
- **Related spec:** `2026-06-02-yieldseeker-stellar-mvp-design.md` (this implements the §2 note "+DeFindex if needed" there)

> **Design update (2026-06-03 — plan phase):** Research settled how DeFindex is read. `@defindex/sdk` is **not used** — it turned out to be a client for a central HTTP API (`api.defindex.io` + API key), and its mainnet support is not documented; this goes against the project's "read mainnet from RPC" model. Instead, the DeFindex **USDC strategy contract** (`CDB2WMKQ…`; not a vault — vaults are created dynamically by the factory, so there is no canonical address) is read directly. **APY / utilization / oracle health** are taken from the **underlying Blend fixed-pool** the strategy autocompounds into (mapped in config with `blendPoolId`; that pool is already scanned). **On-chain TVL** is read from the strategy getter with `simulateTransaction`; the getter is verified with a small spike (`scripts/verify-defindex-strategy.ts`), and if it is not found, the read falls back gracefully to `fallbackTvlUsdc` in the config. **Result:** the "vault fairness" problem in §8 **goes away** (utilization is now a real value from the underlying Blend) → `risk.ts` **does not change**. The §7 config field becomes `SCAN_DEFINDEX_STRATEGIES` (JSON: `{strategyId, blendPoolId, name, fallbackTvlUsdc}`) instead of `SCAN_DEFINDEX_VAULT_IDS`. The `YieldSource` type is defined in `types.ts`.

---

## 1. Purpose & Summary

Today YieldSeeker uses **Blend** as its only yield source, and Blend is **hardcoded** in scanner/discovery/executor. The goal: put yield sources behind an interface and add **a second source (DeFindex)**, so that the agent can see the yields of different protocols in a single comparison and choose.

**Scope (approved): SCANNING only.** DeFindex vaults are read on mainnet and take part in the scan/comparison. **Transactions (deposit/withdraw) still stay on the testnet Blend pool** — `executor` does not change, and the "no real money" demo model is kept. The abstraction is only on the **reading (read-side)** side.

## 2. Goals / Non-Goals

**Goals:**
- `YieldSource` interface: each protocol does its own native read and returns a normalized `PoolYield`.
- Blend is moved behind this interface with its behaviour **kept exactly the same** (existing tests stay green).
- DeFindex is added as a second **scan source** (mainnet vault APY/TVL).
- `PoolYield` rows are labelled with `protocol`.
- Full backward compatibility: if the DeFindex config is empty, the system behaves as it does today.

**NOT goals:**
- Real deposit/withdraw into DeFindex (executor does not change; no mainnet signing / real money).
- Refactoring `executor`, `agent`, `orchestrator`, `wallet` or Blend `discovery`.
- AMM sources (Soroswap/Aquarius), liquid staking — later phases.
- Showing a `protocol` badge in the frontend (optional, out of scope).

## 3. Architecture (Approach A) and why

**Approach A — `YieldSource` interface (chosen):** Each protocol owns its own read logic; its output is `PoolYield`, which is already protocol-neutral. The scanner loops over a list of sources.

Rejected alternatives:
- **B (separate scanner functions + concat in runtime):** Less abstraction; runtime becomes scattered as sources are added.
- **C (fit DeFindex into the existing `RawReserve`/`BlendReader` pattern):** `RawReserve` is Blend-specific (`supplyApr`, `utilization`); it does not fit a vault naturally, so it is the wrong abstraction.

```
scan ─┬─ blendSource.readPool   × (discovered Blend ids)      [mainnet, read-only]
      └─ defindexSource.readPool × (config vault ids)         [mainnet, read-only]
        → PoolYield[] (protocol-labelled) → scorePools → agent → execute (TESTNET Blend, UNCHANGED)
```

## 4. Components & Changes

| File | Change | Responsibility |
|------|-----------|-----------|
| `src/lib/types.ts` | `protocol: string` on `PoolYield`; new `YieldSource` interface | Types |
| `src/lib/scanner.ts` | `scanYields(reader, ids)` → `scanSource(source, ids)`; `createBlendReader` is kept, and `createBlendSource(): YieldSource` wraps it (the `RawReserve→PoolYield` mapping goes here, `protocol:"blend"`) | Blend reading + normalization |
| `src/lib/defindex.ts` (new) | `createDefindexSource(): YieldSource` — read the vault getters with `simulateTransaction`, decode with `scValToNative`, map to `PoolYield` (`protocol:"defindex"`) | DeFindex reading |
| `src/lib/config.ts` | `SCAN_DEFINDEX_VAULT_IDS` (optional, empty=skip); RPC/passphrase come from the scan side | Config |
| `src/lib/runtime.ts` | The scan step reads both sources and merges them; passes the result to `scorePools` | Wiring |
| `src/lib/risk.ts` | Vault fairness tweak (§8) | Risk score |

**Untouched:** `agent.ts`, `orchestrator.ts`, `executor.ts`, `wallet.ts`, `discovery.ts` (Blend discovery), DB schema, frontend.

## 5. Type Changes

```typescript
export interface PoolYield {
  protocol: string;        // NEW: "blend" | "defindex"
  poolId: string;          // pool / vault contract id
  name: string;
  asset: "USDC";
  apyBps: number;
  tvlUsdc: bigint;
  utilizationBps: number;  // derived/0 for sources with no utilization concept (§8)
  oracleHealthy: boolean;
}

// A yield source = the adapter for one protocol; produces a normalized PoolYield.
export interface YieldSource {
  readonly protocol: string;
  /** Read a single pool/vault → normalized PoolYield, null if it cannot be read. */
  readPool(poolId: string): Promise<PoolYield | null>;
}
```

Since `ScoredPool extends PoolYield`, `protocol` flows through automatically; `serialize.ts` needs no extra conversion because it is a string field (it is only confirmed that the new field is carried through).

## 6. Data Flow (runtime tick)

1. The `scan` step collects the pool id sets: Blend = the existing `rt.poolIds` (discovery) || fallback; DeFindex = `cfg.scanDefindexVaultIds`.
2. For each source, `scanSource(source, ids)` → `PoolYield[]` (a faulty id is skipped).
3. The results are merged → `scorePools(all, tolerance)` → `rt.lastScan`.
4. The rest of the flow (agent decide → execute → DB) **does not change**. Execute still targets `rt.cfg.execPoolId` (testnet Blend).

## 7. Config Changes

- New: `SCAN_DEFINDEX_VAULT_IDS` (comma-separated vault contract ids; **optional**, empty by default).
- `parseConfig` → `scanDefindexVaultIds: string[]` (`[]` if empty).
- Empty list ⇒ the DeFindex source is never read ⇒ existing `.env` files work **untouched**.
- `.env.example` is updated (comment + an example USDC vault id; re-validated against `paltalabs/defindex` `mainnet.contracts.json` at integration time).

## 8. risk.ts Fairness Note

`risk.ts` uses utilization as the dominant factor (~70%). A vault has no utilization concept; if it is given `utilizationBps=0`, the vault unfairly comes out as "low risk".

**Decision:** A DeFindex vault's risk should **reflect the utilization of the underlying Blend pool** (DeFindex USDC vault → Blend fixed pool). If the Phase 2 spike can read the underlying, `utilizationBps` is derived from it; if it cannot, a conservative default is applied (one that does not make the vault look artificially "safest"). `risk.ts` stays generic; protocol-specific logic goes into the source adapter.

## 9. Error Handling

- Every `readPool` is in a try/catch; an unreadable pool/vault is skipped (the existing `scanYields` behaviour is kept).
- If DeFindex is entirely unreachable, the scan continues with Blend without problems (source isolation).
- If the DeFindex config is empty, the source is never set up.

## 10. Test (TDD)

- `scanSource`: reading multiple ids + skipping a faulty id (the existing `scanYields` tests are adapted to this).
- `createBlendSource`: the `RawReserve→PoolYield` mapping, `protocol:"blend"`, APY/TVL/utilization scale — the existing Blend coverage is kept.
- `createDefindexSource`: mock RPC `simulateTransaction` response → `scValToNative` decode → `PoolYield`, `protocol:"defindex"`, correct APY/TVL scale; unreadable vault → `null`.
- `types`/serialize: that the `protocol` field is carried through.
- No LLM/network in tests (existing principle).

## 11. Risks to Verify at Build Time (spikes)

1. **DeFindex APY read getter (main risk):** Because it autocompounds, there may be no single on-chain "APY" field. Phase 2 verifies the getter/encoding with a small spike, as was done for Blend (the "testnet spike Task 5" note in `scanner.ts`). **Fallback:** since the DeFindex USDC vault → Blend fixed pool, the `supplyApr` of the underlying Blend strategy is used.
2. **Vault contract ids:** re-validate against `paltalabs/defindex` `public/mainnet.contracts.json` (the deep-research report gave partial ids; TVL/manifest change over time).
3. **Dependency decision:** `@defindex/sdk` is **not added** — for scan-only, calling `simulateTransaction` directly is lighter and consistent with the existing pattern in `scanner`. (The SDK is mostly for deposit/withdraw txs; it is not needed in this scope.)

## 12. Open Scope / Later Phases

- AMM sources (Soroswap: published SDK + fixed ids; Aquarius: larger TVL, but its id/APY getter must be clarified first) — a different yield type + impermanent loss → requires a new factor in `risk.ts`.
- Real execution into DeFindex (mainnet) — a separate security/risk decision.
- A `protocol` badge in the frontend.
- **Not verified (deep-research):** The "YieldBlox" in YieldSeeker is actually a **Blend pool** (the scanner already covers it); it is not integrated separately, and the February 2026 oracle exploit confirms the importance of the `oracleHealthy` gate. There is **no production-grade liquid staking** on Stellar.
