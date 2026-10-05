# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**YieldSeeker** — an autonomous DeFi yield agent on Stellar (Next.js 16 App Router). One backend agent continuously scans Blend V2 (+ DeFindex) yield pools, scores them against a risk tolerance, deterministically picks the highest-APY eligible pool, then supplies each registered user's idle USDC into it — executing **per-user** through OpenZeppelin smart accounts where the agent is a restricted, spending-capped policy signer (the "ARMA" model).

## Commands

```bash
npm run dev          # Next.js dev server (starts the agent loop via instrumentation.ts)
npm run build        # next build (loop does NOT start during build)
npm start            # production server
npm test             # vitest run — unit tests (src/lib/*.test.ts + tests/), node env

npx vitest run src/lib/risk.test.ts          # a single test file
npx vitest run -t "scores pools"             # tests matching a name
npx tsc --noEmit                             # typecheck (no lint tool configured)

# On-chain verify scripts (hit REAL testnet/mainnet — need a populated .env):
npm run verify:blend            # tsx scripts/verify-blend-testnet.ts
npm run verify:blend-mainnet    # mainnet pool scan
npm run verify:discovery        # on-chain pool discovery
# Many more proofs live in scripts/ (verify-*.ts, spike-*.ts) — run with `npx tsx scripts/<file>.ts`.
```

- `AGENT_LOOP_ENABLED=0` disables the autonomous loop (used by tests/CI/build so no RPC calls fire).
- Tests run with **no** `MONGODB_URI`, so state falls back to in-memory and RPC is faked — keep them offline & deterministic.
- **There is no LLM.** The decision is `bestPool` (highest APY among eligible pools); `agent.ts` composes the rationale string from the scan. It was an Anthropic tool call until 2026-10 and was removed for cost — every tick paid for a model call that only applied that same rule. Don't reintroduce a model call on the tick path.

## The two ideas you must hold to read this code

### 1. Dual network: SCAN = mainnet (read-only), EXEC = testnet (real tx)

- **Scan side (mainnet):** real Blend V2 pools + DeFindex strategies are read read-only for yield discovery. No signing, no money.
- **Exec side (testnet):** our **own** deployed Blend pool (`EXEC_POOL_ID`) + a **mintable** USDC SAC (`EXEC_USDC_CONTRACT_ID`) we control. All real transactions land here.
- The agent decides on the best *mainnet* pool, but execution **always targets the single testnet `EXEC_POOL_ID`** regardless of which mainnet pool won. Multi-pool exec is future work. This indirection lives in `runtime.ts` `tick()`.

Config (`config.ts`) is split along this line: every `SCAN_*` value is mainnet, every `EXEC_*` value is testnet.

### 2. ARMA per-user execution

Each user owns their own Soroban smart account (OZ `SmartAccount`). The single backend agent key is a **restricted External ed25519 policy signer** on *every* user's account, scoped by two context rules — `CallContract(POOL)` (uncapped) and `CallContract(USDC)` (capped by a spending-limit policy). The loop **decides once**, then **executes once per user**, bounded by each user's on-chain cap. See `orchestrator.ts` `runPerUserExecution` and the memory note on per-user smart accounts.

## Architecture (request/tick flow)

Nothing touches env or SDK clients at **module import** — everything is lazy so `next build` and route static-analysis don't crash with absent env. The loop is started by Next's `instrumentation.ts register()` hook (Node runtime only).

```
instrumentation.register() ──► runtime.startLoop() ──► tick() every SCAN_INTERVAL_SEC
                                       │
   discovery.ts ──discover pool ids──► scanner.ts / defindex.ts ──► risk.ts ──► agent.ts ──► orchestrator.ts
   (backstop reward zone +            (Blend PoolV2 reader,        (scorePools/   (decide =    (runTick = legacy single-wallet
    factory events, curated            DeFindex scan adapter)       bestPool +     bestPool +   + guard rails;
    fallback, DB-cached w/ TTL)                                     eligibility)   rationale)   runPerUserExecution = ARMA)
                                                                                        │
                                              executor.ts (Blend pool.submit Supply/WithdrawCollateral)
                                              wallet.ts  (keypair OR policy-signer)
                                              smartAccount.ts (OZ AuthPayload signing)
```

Layer map:

- **`config.ts`** — `parseConfig(process.env)` (zod). Most on-chain ids have defaults baked in, so a bare `.env` still boots. `SCAN_DEFINDEX_STRATEGIES` is a JSON array.
- **`runtime.ts`** — the process singleton. `getRuntime()` wires config→db→reader/discovery/wallet/executor and holds mutable loop state (`lastScan`, `lastDecision`, `running`, `poolIds`). All route-handler accessors (`getLastScan`, `getDecision`, `listUsers`, `registerUser`, …) live here. This is the seam between the loop and the API routes.
- **`discovery.ts`** — enumerate active Blend pools (backstop reward zone = authoritative; factory `deploy` events = best-effort), with `SCAN_BLEND_POOL_IDS` as fallback; result cached in the DB KV with a 60-min TTL.
- **`scanner.ts`** — `BlendReader` reads a pool's USDC reserve (APY/TVL/utilization/oracle staleness) via `@blend-capital/blend-sdk` `PoolV2`. `defindex.ts` reads a strategy's underlying Blend reserve (multi-asset USDC/EURC/XLM).
- **`risk.ts`** — `scorePools` (utilization + TVL → 0..100 risk) and `bestPool`; eligibility gated by `RISK_TOLERANCE`.
- **`agent.ts`** — deterministic `decide`: rebalance to `bestPool` unless already there (hold), with a rationale naming the choice and the best higher-yield pool it excluded.
- **`orchestrator.ts`** — pure decision logic + guard rails (`runTick`), and the per-user supply loop (`runPerUserExecution`). Dependency-injected (no SDK imports) so it's unit-testable.
- **`executor.ts` / `wallet.ts` / `smartAccount.ts`** — execution. See below.
- **`db.ts`** (shared agent state: single position, activity log, rebalance ledger, KV cache) and **`registry.ts`** (per-user users + positions). Both are **Mongo-backed when `MONGODB_URI` is set, in-memory otherwise**.

### Execution & the smart-account auth subtlety

`WALLET_MODE` selects the path: `smart-account` (default, ARMA per-user) or `keypair` (legacy single signer). In smart-account mode the legacy `runTick` execution is a **no-op** — the real work is `runPerUserExecution`, which builds a fresh `createPolicySignerWallet` per user per tick.

The trickiest code in the repo is `smartAccount.ts` `buildAgentAuth`: a Soroban smart-account auth entry needs a **two-pass simulate**. The first recording-auth simulation mocks `__check_auth`, so its footprint omits the context-rule reads + verifier cross-contract call; we sign the SA's own `AuthPayload` (`authDigest = sha256(signaturePayload || scvVec([ruleIds]))`), then **re-simulate the signed tx** and `assembleTransaction` so the final footprint/resources are correct. This is why `Wallet` has an optional `submitOp` that owns the whole round-trip — it can't be expressed as a single-pass `signXdr`. All of this was proven first in `scripts/spike-*.ts` before being ported here.

### Onboarding (4 steps) & the demo-owner

`POST /api/register` just records `{owner, smartWallet, poolRuleId, usdcRuleId}`. The on-chain steps the user does first: (1) deploy SA, (2) `add_context_rule` ×2 (pool + capped USDC agent rules), (3) fund USDC, (4) register. Steps 1/3/4 are Freighter-native. **Step 2 can't be done by Freighter** — it needs the OZ owner's custom `AuthPayload` signature (with the rule-id tail) that Freighter's `signAuthEntry` won't produce. So it's backend-assisted: the SA is deployed with a deterministic **demo-owner** key (derived from `AGENT_SIGNER_SECRET` in `agentKeys.ts`) as its Default-rule signer, and `/api/authorize` owner-signs the rules. `onboarding.ts` is **client-safe** (no node deps, on-chain constants duplicated as literals); the heavy `@stellar/stellar-sdk` work stays server-side in `/api/onboard/prepare` + `/api/onboard/submit`.

The **faucet** (`/api/faucet`, `faucet.ts`) mints our testnet USDC SAC (admin = SEP-5 key from `STELLAR_WALLET_MNEMONIC`) into a user's smart account so they can try the flow without sourcing USDC.

### Frontend

`src/app/page.tsx` + `src/app/_components/*` — a live "network graph" UI (`react-force-graph-2d`), `Onboarding`, `AnalysisPanel`. State streams from `GET /api/events` (SSE, every 2s). Wallet via Freighter (`useFreighter`). Routes are all `dynamic = "force-dynamic"`.

## Conventions & gotchas

- **Money is always stroops** (`bigint`, 7 decimals). JSON can't carry BigInt — serialize at the API edge via `serialize.ts`; routes return amounts as decimal **strings**.
- **Cross-instance state:** on Vercel the daily-cron tick and a user's `/api/register` may run in different function instances, so an in-process map is invisible to the loop. That's why scan snapshot / decision / discovery go through the DB KV and the registry is external. Don't reintroduce in-process-only shared state for anything the loop and routes both touch.
- **Guard rails** (`PER_TX_CAP_USDC`, `DAILY_CAP_USDC`, `MIN_YIELD_DELTA_BPS`, `REBALANCE_COOLDOWN_SEC`) are enforced both in `orchestrator.ts` and on-chain by the spending-limit policy — keep both in mind.
- **Migration in flight:** `db.ts` and `registry.ts` were recently converted to **async Mongo** implementations; some `runtime.ts` accessors still call them as if synchronous. If you touch state access, expect (and fix) sync/async mismatches rather than assuming the current types are correct.
- Tests live next to the modules they cover (`src/lib/*.test.ts`); `src/app/**` is excluded from the test glob. `scripts/blend-utils` is excluded from `tsconfig`.
- Plans & specs for the major features are in `docs/superpowers/plans/` and `docs/superpowers/specs/`.
