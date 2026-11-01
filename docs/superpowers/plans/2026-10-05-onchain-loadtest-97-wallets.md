# YieldSeeker · 24 h On-Chain Load Test (97 wallets) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run 97 distinct testnet wallets through YieldSeeker's real onboarding + agent loop for 24 hours, and leave behind a complete, self-contained archive (intended plan, executed events, raw on-chain XDR, final balances, the agent's activity log) for later analysis.

**Architecture:** A resumable, strictly-serial driver (`scripts/loadtest/`) replays a seeded 24 h plan against a locally running YieldSeeker server, calling the same HTTP routes the UI calls (wallet keys stand in for Freighter). The server runs with a dedicated load-test agent key and its own Mongo database, so the test is isolated from production both off-chain and on-chain. An export script then pulls every transaction from Horizon + RPC into the run directory.

**Tech Stack:** Node ≥ 22 (local v24), TypeScript run via `tsx`, vitest, `@stellar/stellar-sdk` 15, `@blend-capital/blend-sdk` 3.2, Next.js 16 (`next start`), MongoDB Atlas, Stellar testnet (Soroban RPC + Horizon + Friendbot).

**Spec:** No separate spec. The **Design** section below is the spec; it was derived from the request "97 wallets test YieldSeeker on-chain for 24 h; we analyse the on-chain data later" (2026-10-05) and from the live testnet state verified the same day.

## Global Constraints

- Exec side is **Stellar testnet only** (`Test SDF Network ; September 2015`); the scan side stays read-only mainnet. No mainnet transaction is ever built.
- Product code changes are limited to **one**: the `MONGODB_DB` override in `src/lib/mongo.ts` (default stays `yieldseeker`). Everything else lives in `scripts/loadtest/` and `tests/loadtest/`.
- Never print or write a secret to stdout or logs. Only public `G…`/`C…` ids and tx hashes appear. Secrets live only in `.env.loadtest` (gitignored).
- The driver is **strictly serial**. The load-test agent pays every authorize and supply, and the faucet admin signs every mint, so any concurrency causes `tx_bad_seq`.
- Plan amounts are whole USDC (`number`). The only conversion to stroops is `BigInt(usdc) * 10_000_000n` for `/api/onboard/prepare` `step=fund`.
- Faucet requests are ≤ 5000 USDC (`FAUCET_MAX_USDC`).
- Imports inside `scripts/loadtest/` and `tests/loadtest/` are **extensionless** (like `src/lib`), so `tsx`, vitest and `tsc` (bundler resolution) all resolve them.
- Run artifacts go to `loadtest-runs/` (gitignored). Repo language is English. Commits follow Conventional Commits (`feat:`, `test:`, `docs:`).

## Review Focus

1. **Hard kill mid-onboarding** (laptop sleeps after `deploy` landed): a resume must reuse the recorded smart wallet and rule ids, not deploy or authorize again. → Task 3 (torn-line repair) + Task 6 (resume test).
2. **A tick that runs for many minutes** (97 users × ~8 s/supply): the client must not time out and re-fire `/api/tick` (undici's 300 s default would). → Task 4 (`timeoutMs: 0` tests).
3. **`LOADTEST_SEED` changed between init and resume**: different wallets would silently join the run. Must refuse. → Task 2 (`assertSameWallets` test).
4. **Driver pointed at production** (prod Mongo db or prod agent): the 97 users would land in the live registry. Preflight must refuse. → Task 8 (prod-db / agent-mismatch tests).
5. **Server restarted or briefly unreachable mid-run**: events must wait it out instead of failing permanently. A wallet whose onboarding did fail must have its later actions skipped, not crash the run. → Task 6 (outage + skip tests).

---

## Design

### Verified starting state (2026-10-05)

| Fact | Value |
|---|---|
| Exec pool `CBI7WAUQ…NSZ3Z` | exists, `get_config.status = 0` (admin-active), `min_collateral = 0`, `supply_cap = I128MAX` |
| USDC SAC `CD2R7WRE…6B2I` | `name() = USDC:GBXDHEVC…P3MU2`, `admin() = GBXDHEVC…P3MU2` (the faucet key) |
| Faucet admin `GBXDHEVC…` | 8 741 XLM |
| Verifier `CBHJOANT…` / spending policy `CBLNG63C…` | exist |
| Testnet ledger close | 5.0 s → the 17 280-ledger spending window ≈ **24 h** (the cap window = the test window) |
| RPC history (`getHealth.ledgerRetentionWindow`) | 120 960 ledgers ≈ **7 days**: export raw XDR within a week |
| Next testnet reset | **2026-12-16** (developers.stellar.org/docs/networks): archive before then |
| Local checkout | fresh clone, no `node_modules`, no `.env`, Vercel project not linked |

### Why a local server, not the Vercel deployment

- `/api/tick` has `maxDuration = 60`. The per-user loop supplies users **serially** at about 7–10 s each (two simulations, a send, then a 5 s ledger poll), so one tick on Vercel stops after roughly 6 supplies. 97 users cannot be served. *(This is also a production finding; see "Expected observations".)*
- Production Mongo would receive 97 test users. The live graph would show them, and the daily cron would act on them.
- Locally, `AGENT_LOOP_ENABLED=0 next start` runs the **same code** with no duration limit, and the driver alone decides when a tick runs.

### Isolation

| Layer | Production | Load test |
|---|---|---|
| Mongo db | `yieldseeker` | `yieldseeker_loadtest_<yyyymmdd>` via `MONGODB_DB` (smoke run: `yieldseeker_loadtest_smoke`) |
| Agent key (`AGENT_SIGNER_SECRET`) | prod agent | **fresh** key `ys-loadtest-agent`, friendbot-funded. The demo owner (derived from it) is therefore new too. |
| Faucet admin (`STELLAR_WALLET_MNEMONIC`) | shared | shared. It is the only key that can mint the exec USDC. |
| Pool / USDC SAC / verifier / policy | shared contracts | shared contracts |

A dedicated agent makes the later analysis clean: **every** authorize and supply transaction of the test has the load-test agent as source account, and no production transaction does.

### Wallets and cohorts

Wallet *i* (0…96) is `Keypair.fromRawEd25519Seed(sha256("ys-loadtest:v1|" + LOADTEST_SEED + "|" + i))`. This mirrors `agentKeys.ts` `getDemoOwnerKeypair`. Only the seed is stored, never 97 secrets. Each wallet is friendbot-funded on its own (10 000 XLM).

| Cohort | Wallets | Onboarding fund | Later behaviour | What it exercises |
|---|---|---|---|---|
| `steady` | 0–39 (40) | 100 / 250 / 500 / 1000 / 2000 | none | baseline: one supply per wallet |
| `drip` | 40–64 (25) | 100 / 250 / 500 | 2–4 top-ups of 50 / 100 / 250 **from the wallet's own G** (trustline → faucet mint to G → `/api/onboard/prepare step=fund` → wallet-signed transfer) | the `fund` route that the UI no longer uses; repeated supplies; wallet-originated txs |
| `whale` | 65–76 (12) | 5000 | one faucet top-up of 3000 at onboard + 2–4 h | `PER_TX_CAP` split (2000 + 2000 + 1000) and the **on-chain 5000 USDC/24 h spending cap** |
| `churn` | 77–86 (10) | 250 / 500 / 1000 | unregister at onboard + 1.5–4 h, then a 500 USDC faucet top-up 30 min later | the agent must not touch funds of an unregistered user |
| `dust` | 87–96 (10) | 1 | none | minimum-amount supply |

Arrivals: 25 wallets (seeded shuffle) onboard in **T+0–1 h** (a burst of back-to-back onboarding). The other 72 arrive uniformly between **T+1 h and T+20 h**. User actions stop at T+23 h 20 m. Agent ticks run every 20 min (T+10 m … T+23 h 50 m, **72 ticks**). Server-state snapshots run every 2 h (**13**).

Each onboarding uses the exact UI order: friendbot → `deploy` (prepare → wallet signs → submit) → `/api/authorize` → `/api/faucet` into the SA → `/api/register`. One deviation from the UI: it does **not** fire `/api/tick` after onboarding. Ticks are scheduled only, because 97 ad-hoc ticks would collide on the agent's sequence number.

### 24 h timeline

| Time | What happens | Human action |
|---|---|---|
| T−4 h → T−1 h | Build tasks 1–10 | review |
| T−60 m | R1 env + keys, R2 server up | provide prod secrets (`vercel env pull` or manually) |
| T−45 m | R3 preflight, all green | — |
| T−40 m → T−15 m | R4 smoke run: 5 wallets (one per cohort), 24 h compressed to ~15 min, then export | read the smoke summary |
| **T0** | R5 full run starts (tmux + `caffeinate`, laptop on power, lid open) | — |
| T0 → T+1 h | burst: 25 onboardings (~45–60 s each, serial) interleaved with 3 ticks | T+1 h: `export.ts --local-only` |
| T+1 h → T+20 h | 72 more arrivals, drip / whale / churn actions, a tick every 20 min | spot checks at T+6 h and T+12 h |
| T+20 h → T+23 h 20 m | no new arrivals; top-ups continue | — |
| T+23 h 20 m → T+24 h | quiet period; ticks at 23 h 30 m / 23 h 50 m settle everything; final snapshot at T+24 h | — |
| T+24 h → T+25 h | R6 full export + archive tarball | read `summary.json` |

Rough volume: ~97 deploys + ~100 drip wallet txs (trustline + transfer), ~194 `add_context_rule` + ~200 supplies by the agent, and ~195 faucet mints. That is about **800 on-chain txs** plus ~72 LLM calls.

### What the archive contains (`loadtest-runs/<runId>/`)

| File | Content |
|---|---|
| `run.json` | runId, `startedAt` (epoch ms), timeScale, baseUrl, walletCount, planSeed, agent G, USDC SAC, git sha |
| `plan.json` | the seeded plan: cohorts + every intended event with its planned minute |
| `wallets.json` | index → cohort → owner G |
| `events.jsonl` | `step` records (sub-step checkpoints with hashes) and `event` records (status ok / failed / skipped, plannedAt, startedAt, finishedAt, hashes, error, data such as smartWallet and rule ids) |
| `snapshots/snapshot-NNNN.json` | `/api/users`, `/api/decision`, `/api/scan`, `/api/position`, `/api/activity` every 2 h |
| `chain/horizon-transactions.jsonl` | every Horizon tx of the agent account and of each wallet G within the run window (`_source` tag) |
| `chain/rpc-transactions.jsonl` | raw `getTransaction` (envelope / result / meta XDR, ledger, status) for every known hash |
| `state/final-wallets.json` | per SA: USDC balance, Blend collateral, spending-limit data |
| `offchain/activity.jsonl`, `offchain/users.json` | the server's activity log (supply hashes, skip reasons, tick errors) and the registry |
| `summary.json` | per-cohort counts, tick stats, max driver lag, chain counts |

### Expected observations (hypotheses for the later analysis)

Read from the code on 2026-10-05. They assume `PER_TX_CAP_USDC=2000`; check `.env.loadtest`.

1. Every wallet with idle USDC is supplied within ≤ 1 tick (20 min) of funding. Supply latency is `supply ledger time − fund ledger time`.
2. Whales are supplied 2000 + 2000 + 1000 over three ticks, reaching the 5000 cap.
3. After a whale's 3000 top-up the agent keeps proposing 2000 every tick, and the spending policy rejects it at simulation. **No on-chain tx; one `error` activity row per whale per tick.** The agent does not size supplies to the remaining cap.
4. Churn wallets: no supply after their unregister time; the post-unregister 500 USDC stays idle in the SA.
5. Dust wallets: one 1 USDC supply each (`min_collateral = 0`).
6. Per-user supply runs **even when the LLM decides `hold`**. `tick()` calls `runPerUserExecution` regardless of the decision.
7. A failed mainnet scan or LLM call aborts the whole tick ("tick failed"), so no supply happens that tick.
8. Tick duration grows with the number of users holding idle USDC (`data.durationMs` on tick events).
9. Production: the 60 s Vercel tick can serve only ~6 supplies (see "Why a local server").

### Risks

| Risk | Mitigation |
|---|---|
| Laptop sleeps or the driver crashes | `caffeinate -dimsu`; resumable driver (step checkpoints, torn-line repair); rerun the same command |
| Server crash | restart it; the driver waits up to 20 min on "unreachable" without failing events |
| Faucet-admin sequence collision with someone using the live faucet | rare; retry. Only a refused connection is waited out; a reset/timeout counts as an attempt. A retried mint after an ambiguous failure may still double-mint test USDC — the export counts such mints as `unrecordedMints` (from the server's activity log). |
| SDF RPC / Friendbot rate limits | serial pace; 3 attempts with 5 s → 15 s backoff; failures are recorded, not fatal |
| Anthropic or mainnet-RPC outage | those ticks fail entirely (observation 7); visible in activity + summary |
| RPC history expires (~7 days) or testnet reset (2026-12-16) | R6 export right after the run; the tarball holds raw XDR |

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/mongo.ts` (modify) | `mongoDbName()` with the `MONGODB_DB` override |
| `src/lib/mongo.test.ts` (create) | override tests |
| `.env.example`, `.gitignore` (modify) | document `MONGODB_DB`; ignore `loadtest-runs/`, `.env.loadtest`, `.env.prod.local` |
| `scripts/loadtest/wallets.ts` | deterministic wallet derivation + resume guard |
| `scripts/loadtest/schedule.ts` | seeded 24 h plan (cohorts, events) — pure |
| `scripts/loadtest/manifest.ts` | run dir I/O: `events.jsonl`, json/jsonl files, derived state |
| `scripts/loadtest/http.ts` | JSON over `node:http(s)` with an optional no-timeout mode |
| `scripts/loadtest/api.ts` | typed client for the YieldSeeker routes + `ApiError` |
| `scripts/loadtest/chain.ts` | signing, friendbot, Horizon reads, trustline, contract simulate |
| `scripts/loadtest/steps.ts` | one function per event kind, with checkpoints + retry |
| `scripts/loadtest/driver.ts` | time loop (`runPlan`, `dueAt`, `parseScale`) — pure |
| `scripts/loadtest/run.ts` | driver CLI (init / resume) |
| `scripts/loadtest/preflight-checks.ts` | pure preflight evaluation |
| `scripts/loadtest/preflight.ts` | preflight CLI (gathers facts) |
| `scripts/loadtest/report.ts` | pure export helpers: hashes, Horizon paging, RPC fetch, summary |
| `scripts/loadtest/export.ts` | export CLI |
| `scripts/loadtest/README.md` | runbook |
| `tests/loadtest/*.test.ts` | unit tests (offline, deterministic) |

---

### Task 1: Workspace + isolated Mongo database

**Files:**
- Modify: `src/lib/mongo.ts:16` (remove `DB_NAME`) and `:39` (`client.db(...)`)
- Create: `src/lib/mongo.test.ts`
- Modify: `.env.example` (after the `MONGODB_URI=` line), `.gitignore`

**Interfaces:**
- Produces: `export function mongoDbName(env?: Record<string, string | undefined>): string`

- [ ] **Step 1: Branch, install, record the baselines**

```bash
cd ~/Documents/projects/yieldseeker
git switch -c feat/onchain-loadtest
npm ci
npm test 2>&1 | tail -5
npx tsc --noEmit 2>&1 | grep -c "error TS" || true
```
Expected: tests pass. Write down the tsc error count (may be non-zero because `scripts/` is in `tsconfig.include`). Later tasks must not raise it.

- [ ] **Step 2: Write the failing test** — `src/lib/mongo.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { mongoDbName } from "./mongo";

describe("mongoDbName", () => {
  it("defaults to the production db", () => {
    expect(mongoDbName({})).toBe("yieldseeker");
  });
  it("honours MONGODB_DB so an isolated run gets its own db", () => {
    expect(mongoDbName({ MONGODB_DB: "yieldseeker_loadtest_20261006" })).toBe("yieldseeker_loadtest_20261006");
  });
  it("ignores a blank override (a copied .env.example has MONGODB_DB=)", () => {
    expect(mongoDbName({ MONGODB_DB: "  " })).toBe("yieldseeker");
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/lib/mongo.test.ts`
Expected: FAIL, `mongoDbName` is not exported.

- [ ] **Step 4: Implement** — in `src/lib/mongo.ts` replace `const DB_NAME = "yieldseeker";` with:

```ts
/**
 * Database name inside the cluster. Production uses the default; MONGODB_DB lets
 * an isolated run (the on-chain load test) keep its users, positions and activity
 * log out of the live registry. Read at call time, like MONGODB_URI.
 */
export function mongoDbName(env: Record<string, string | undefined> = process.env): string {
  const v = env.MONGODB_DB?.trim();
  return v ? v : "yieldseeker";
}
```

and in `getMongoDb` change `return client.db(DB_NAME);` to `return client.db(mongoDbName());`.

- [ ] **Step 5: Document + ignore** — in `.env.example`, directly after `MONGODB_URI=` add:

```
# Database name inside the cluster. Leave empty in production ("yieldseeker").
# The on-chain load test sets its own (e.g. yieldseeker_loadtest_20261006) so its
# 97 test users never reach the live registry.
MONGODB_DB=
```

Append to `.gitignore`:

```
loadtest-runs/
.env.loadtest
.env.prod.local
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/lib/mongo.test.ts && npm test 2>&1 | tail -3`
Expected: PASS; the full suite still passes.

- [ ] **Step 7: Commit**

```bash
git add src/lib/mongo.ts src/lib/mongo.test.ts .env.example .gitignore
git commit -m "feat: MONGODB_DB override for isolated runs"
```

---

### Task 2: Deterministic wallets + 24 h plan

**Files:**
- Create: `scripts/loadtest/wallets.ts`, `scripts/loadtest/schedule.ts`
- Test: `tests/loadtest/schedule.test.ts`

**Interfaces:**
- Produces (wallets.ts): `deriveWallet(seedHex: string, index: number): Keypair`, `assertSameWallets(stored: Array<{ index: number; owner: string }>, derive: (i: number) => string): void`
- Produces (schedule.ts): `type Cohort`, `type PlanEvent` (union by `kind`: `onboard {wallet, fundUsdc}`, `topup {wallet, usdc, via: "faucet" | "transfer"}`, `unregister {wallet}`, `tick`, `snapshot`; all carry `id`, `atMin`), `interface Plan { seed; wallets: Array<{ index; cohort }>; events: PlanEvent[] }`, `WALLET_COUNT = 97`, `RUN_MIN = 1440`, `COHORT_ORDER`, `COHORT_SIZES`, `mulberry32(seed)`, `assignCohorts(count): Cohort[]`, `buildPlan({ walletCount, seed }): Plan`

- [ ] **Step 1: Write the failing test** — `tests/loadtest/schedule.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { assignCohorts, buildPlan, COHORT_SIZES, type PlanEvent } from "../../scripts/loadtest/schedule";
import { assertSameWallets, deriveWallet } from "../../scripts/loadtest/wallets";

const SEED_HEX = "11".repeat(32);

describe("deriveWallet", () => {
  it("is deterministic per (seed, index) and distinct across indices", () => {
    const a = deriveWallet(SEED_HEX, 0).publicKey();
    expect(deriveWallet(SEED_HEX, 0).publicKey()).toBe(a);
    const all = new Set(Array.from({ length: 97 }, (_, i) => deriveWallet(SEED_HEX, i).publicKey()));
    expect(all.size).toBe(97);
    expect(deriveWallet("22".repeat(32), 0).publicKey()).not.toBe(a);
  });
  it("rejects a malformed seed", () => {
    expect(() => deriveWallet("abc", 0)).toThrow(/32 bytes/);
  });
});

describe("assertSameWallets", () => {
  it("refuses to resume when LOADTEST_SEED changed", () => {
    const stored = [{ index: 0, owner: deriveWallet(SEED_HEX, 0).publicKey() }];
    expect(() => assertSameWallets(stored, (i) => deriveWallet(SEED_HEX, i).publicKey())).not.toThrow();
    expect(() => assertSameWallets(stored, (i) => deriveWallet("22".repeat(32), i).publicKey())).toThrow(
      /LOADTEST_SEED changed/,
    );
  });
});

describe("buildPlan", () => {
  const plan = buildPlan({ walletCount: 97, seed: 42 });
  const of = <K extends PlanEvent["kind"]>(k: K) =>
    plan.events.filter((e): e is Extract<PlanEvent, { kind: K }> => e.kind === k);
  const onboardAt = new Map(of("onboard").map((e) => [e.wallet, e.atMin]));
  const cohort = (i: number) => plan.wallets[i].cohort;

  it("is reproducible from its seed", () => {
    expect(buildPlan({ walletCount: 97, seed: 42 })).toEqual(plan);
    expect(buildPlan({ walletCount: 97, seed: 43 }).events).not.toEqual(plan.events);
  });

  it("splits 97 wallets into the fixed cohorts", () => {
    const counts = Object.fromEntries(
      Object.keys(COHORT_SIZES).map((c) => [c, plan.wallets.filter((w) => w.cohort === c).length]),
    );
    expect(counts).toEqual(COHORT_SIZES);
  });

  it("onboards every wallet once: 25 in the first hour, none after T+20h", () => {
    expect(of("onboard")).toHaveLength(97);
    expect(onboardAt.size).toBe(97);
    expect(of("onboard").filter((e) => e.atMin < 60)).toHaveLength(25);
    expect(Math.max(...onboardAt.values())).toBeLessThanOrEqual(1200);
  });

  it("ticks every 20 min (72) and snapshots every 2 h (13)", () => {
    expect(of("tick").map((e) => e.atMin)).toEqual(Array.from({ length: 72 }, (_, k) => 10 + 20 * k));
    expect(of("snapshot")).toHaveLength(13);
  });

  it("acts on a wallet only after it onboarded, and before the last tick", () => {
    for (const e of [...of("topup"), ...of("unregister")]) {
      expect(e.atMin).toBeGreaterThan(onboardAt.get(e.wallet)!);
      expect(e.atMin).toBeLessThanOrEqual(1430);
    }
  });

  it("gives each cohort its behaviour", () => {
    for (const e of of("onboard")) {
      if (cohort(e.wallet) === "whale") expect(e.fundUsdc).toBe(5000);
      if (cohort(e.wallet) === "dust") expect(e.fundUsdc).toBe(1);
    }
    for (const e of of("topup")) {
      expect(["drip", "whale", "churn"]).toContain(cohort(e.wallet));
      expect(e.via).toBe(cohort(e.wallet) === "drip" ? "transfer" : "faucet");
    }
    const unreg = new Map(of("unregister").map((e) => [e.wallet, e.atMin]));
    expect(unreg.size).toBe(10);
    expect([...unreg.keys()].every((i) => cohort(i) === "churn")).toBe(true);
    for (const e of of("topup").filter((t) => cohort(t.wallet) === "churn")) {
      expect(e.atMin).toBeGreaterThan(unreg.get(e.wallet)!);
    }
  });

  it("never asks the faucet for more than its 5000 USDC cap", () => {
    for (const e of plan.events) {
      if (e.kind === "onboard") expect(e.fundUsdc).toBeLessThanOrEqual(5000);
      if (e.kind === "topup") expect(e.usdc).toBeLessThanOrEqual(5000);
    }
  });

  it("is sorted by time, user actions before the tick of the same minute", () => {
    const order = { onboard: 0, topup: 1, unregister: 2, tick: 3, snapshot: 4 };
    for (let i = 1; i < plan.events.length; i++) {
      const a = plan.events[i - 1];
      const b = plan.events[i];
      expect(a.atMin < b.atMin || (a.atMin === b.atMin && order[a.kind] <= order[b.kind])).toBe(true);
    }
  });

  it("covers every cohort in a 5-wallet smoke plan", () => {
    expect(new Set(assignCohorts(5))).toEqual(new Set(Object.keys(COHORT_SIZES)));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/loadtest/schedule.test.ts`
Expected: FAIL, cannot resolve `../../scripts/loadtest/schedule`.

- [ ] **Step 3: Implement** — `scripts/loadtest/wallets.ts`

```ts
/**
 * Deterministic load-test wallets. Mirrors src/lib/agentKeys.ts
 * getDemoOwnerKeypair: only LOADTEST_SEED is stored (in .env.loadtest), never
 * 97 secrets, and the same seed always yields the same 97 G-addresses.
 */
import { Keypair, hash } from "@stellar/stellar-sdk";

export function deriveWallet(seedHex: string, index: number): Keypair {
  if (!/^[0-9a-f]{64}$/i.test(seedHex)) throw new Error("LOADTEST_SEED must be 32 bytes of hex");
  if (!Number.isInteger(index) || index < 0) throw new Error(`bad wallet index ${index}`);
  return Keypair.fromRawEd25519Seed(hash(Buffer.from(`ys-loadtest:v1|${seedHex.toLowerCase()}|${index}`)));
}

/** A resumed run must drive the same wallets it was initialised with. */
export function assertSameWallets(
  stored: Array<{ index: number; owner: string }>,
  derive: (i: number) => string,
): void {
  for (const w of stored) {
    const now = derive(w.index);
    if (now !== w.owner) {
      throw new Error(`wallet ${w.index}: LOADTEST_SEED changed since init (${w.owner} ≠ ${now}) — refusing to resume`);
    }
  }
}
```

`scripts/loadtest/schedule.ts`

```ts
/**
 * Deterministic 24 h load-test plan: which wallet does what, when.
 *
 * Pure (seeded PRNG, no clock, no network) so a run is reproducible and the
 * later on-chain analysis can compare what was intended (plan.json) with what
 * landed (events.jsonl + the chain export).
 */

export type Cohort = "steady" | "drip" | "whale" | "churn" | "dust";

export type PlanEvent =
  | { id: string; atMin: number; kind: "onboard"; wallet: number; fundUsdc: number }
  | { id: string; atMin: number; kind: "topup"; wallet: number; usdc: number; via: "faucet" | "transfer" }
  | { id: string; atMin: number; kind: "unregister"; wallet: number }
  | { id: string; atMin: number; kind: "tick" }
  | { id: string; atMin: number; kind: "snapshot" };

export interface Plan {
  seed: number;
  wallets: Array<{ index: number; cohort: Cohort }>;
  events: PlanEvent[];
}

export const WALLET_COUNT = 97;
export const RUN_MIN = 1440;
export const COHORT_ORDER: Cohort[] = ["steady", "drip", "whale", "churn", "dust"];
export const COHORT_SIZES: Record<Cohort, number> = { steady: 40, drip: 25, whale: 12, churn: 10, dust: 10 };

/** First hour = back-to-back onboarding burst (25 of 97 wallets). */
const BURST_END_MIN = 60;
const BURST_SHARE = 25 / 97;
/** Last arrival at T+20h so even late wallets see ≥ 12 agent ticks. */
const LAST_ARRIVAL_MIN = 1200;
/** User actions stop at T+23h20m so at least two ticks observe each one. */
const LAST_ACTION_MIN = 1400;
const TICK_FIRST_MIN = 10;
const TICK_EVERY_MIN = 20;
const SNAPSHOT_EVERY_MIN = 120;

const KIND_ORDER: Record<PlanEvent["kind"], number> = { onboard: 0, topup: 1, unregister: 2, tick: 3, snapshot: 4 };

/** Small seeded PRNG (mulberry32) — Math.random would make plans unreproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function assignCohorts(count: number): Cohort[] {
  if (count === WALLET_COUNT) return COHORT_ORDER.flatMap((c) => Array<Cohort>(COHORT_SIZES[c]).fill(c));
  // Smoke runs: one wallet per cohort first, so a 5-wallet run covers every behaviour.
  return Array.from({ length: count }, (_, i) => COHORT_ORDER[i % COHORT_ORDER.length]);
}

const w = (i: number) => `w${String(i).padStart(2, "0")}`;
const m = (min: number) => String(min).padStart(4, "0");

export function buildPlan(opts: { walletCount: number; seed: number }): Plan {
  const rand = mulberry32(opts.seed);
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  function pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(rand() * xs.length)];
  }

  const cohorts = assignCohorts(opts.walletCount);
  // Fisher–Yates: arrival order is independent of the cohort index ranges.
  const order = cohorts.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const burst = Math.round(opts.walletCount * BURST_SHARE);
  const arrival = new Array<number>(opts.walletCount);
  order.forEach((idx, pos) => {
    arrival[idx] = pos < burst ? int(0, BURST_END_MIN - 1) : int(BURST_END_MIN, LAST_ARRIVAL_MIN);
  });

  const events: PlanEvent[] = [];
  const onboard = (i: number, fundUsdc: number) =>
    events.push({ id: `onboard:${w(i)}`, atMin: arrival[i], kind: "onboard", wallet: i, fundUsdc });

  cohorts.forEach((cohort, i) => {
    const at = arrival[i];
    switch (cohort) {
      case "steady":
        onboard(i, pick([100, 250, 500, 1000, 2000]));
        break;
      case "drip": {
        onboard(i, pick([100, 250, 500]));
        const times = Array.from({ length: int(2, 4) }, () => int(at + 30, LAST_ACTION_MIN)).sort((a, b) => a - b);
        times.forEach((t, k) =>
          events.push({ id: `topup:${w(i)}:${k + 1}`, atMin: t, kind: "topup", wallet: i, usdc: pick([50, 100, 250]), via: "transfer" }),
        );
        break;
      }
      case "whale":
        onboard(i, 5000);
        events.push({
          id: `topup:${w(i)}:1`,
          atMin: int(at + 120, Math.min(at + 240, LAST_ACTION_MIN)),
          kind: "topup",
          wallet: i,
          usdc: 3000,
          via: "faucet",
        });
        break;
      case "churn": {
        onboard(i, pick([250, 500, 1000]));
        const off = int(at + 90, Math.min(at + 240, LAST_ACTION_MIN - 20));
        events.push({ id: `unregister:${w(i)}`, atMin: off, kind: "unregister", wallet: i });
        // Funds arriving after unregister must stay idle — the agent may act only on registered users.
        events.push({ id: `topup:${w(i)}:1`, atMin: off + 30, kind: "topup", wallet: i, usdc: 500, via: "faucet" });
        break;
      }
      case "dust":
        onboard(i, 1);
        break;
    }
  });

  for (let t = TICK_FIRST_MIN; t < RUN_MIN; t += TICK_EVERY_MIN) events.push({ id: `tick:${m(t)}`, atMin: t, kind: "tick" });
  for (let t = 0; t <= RUN_MIN; t += SNAPSHOT_EVERY_MIN) events.push({ id: `snapshot:${m(t)}`, atMin: t, kind: "snapshot" });
  events.sort((a, b) => a.atMin - b.atMin || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.id.localeCompare(b.id));

  return { seed: opts.seed, wallets: cohorts.map((cohort, index) => ({ index, cohort })), events };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/loadtest/schedule.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/loadtest/wallets.ts scripts/loadtest/schedule.ts tests/loadtest/schedule.test.ts
git commit -m "feat(loadtest): deterministic wallets and seeded 24h plan"
```

---

### Task 3: Run manifest (events.jsonl + derived state)

**Files:**
- Create: `scripts/loadtest/manifest.ts`
- Test: `tests/loadtest/manifest.test.ts`

**Interfaces:**
- Consumes: `PlanEvent` (Task 2)
- Produces: `type EventStatus = "ok" | "failed" | "skipped"`, `interface StepRecord { type: "step"; eventId; wallet?; step; at; hashes: string[]; data? }`, `interface EventRecord { type: "event"; eventId; kind; wallet?; status; plannedAt; startedAt; finishedAt; hashes: string[]; error?; data? }`, `type ManifestRecord`, `interface RunFiles { dir; append(rec); read(); writeJson(name, value); writeJsonl(name, rows); readJson<T>(name): T | null }`, `openRunDir(dir): RunFiles`, `finishedEventIds(recs): Set<string>`, `stepsFor(recs, eventId): Map<string, StepRecord>`, `interface WalletState { owner; smartWallet; poolRuleId; usdcRuleId; registered; trustline }`, `walletStates(recs): Map<number, WalletState>`

- [ ] **Step 1: Write the failing test** — `tests/loadtest/manifest.test.ts`

```ts
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  finishedEventIds,
  openRunDir,
  stepsFor,
  walletStates,
  type EventRecord,
  type StepRecord,
} from "../../scripts/loadtest/manifest";

const tmp = () => mkdtempSync(join(tmpdir(), "ys-lt-"));
const ev = (p: Partial<EventRecord> & Pick<EventRecord, "eventId" | "kind" | "status">): EventRecord => ({
  type: "event", plannedAt: 0, startedAt: 0, finishedAt: 0, hashes: [], ...p,
});
const st = (p: Partial<StepRecord> & Pick<StepRecord, "eventId" | "step">): StepRecord => ({
  type: "step", at: 0, hashes: [], ...p,
});

describe("openRunDir", () => {
  it("round-trips records, json and jsonl files", () => {
    const dir = tmp();
    const f = openRunDir(dir);
    f.append(st({ eventId: "onboard:w00", step: "deploy", hashes: ["h1"] }));
    f.append(ev({ eventId: "tick:0010", kind: "tick", status: "ok" }));
    expect(f.read().map((r) => r.type)).toEqual(["step", "event"]);
    f.writeJson("snapshots/x.json", { a: 1 });
    expect(f.readJson("snapshots/x.json")).toEqual({ a: 1 });
    expect(f.readJson("missing.json")).toBeNull();
    f.writeJsonl("chain/t.jsonl", [{ h: 1 }, { h: 2 }]);
    expect(readFileSync(join(dir, "chain/t.jsonl"), "utf8")).toBe('{"h":1}\n{"h":2}\n');
  });

  it("drops a torn last line left by a hard kill and keeps appending cleanly", () => {
    const dir = tmp();
    openRunDir(dir).append(ev({ eventId: "tick:0010", kind: "tick", status: "ok" }));
    const path = join(dir, "events.jsonl");
    writeFileSync(path, readFileSync(path, "utf8") + '{"type":"ev');
    const g = openRunDir(dir);
    g.append(ev({ eventId: "tick:0030", kind: "tick", status: "ok" }));
    expect(g.read().map((r) => r.eventId)).toEqual(["tick:0010", "tick:0030"]);
  });
});

describe("derived state", () => {
  const recs = [
    st({ eventId: "onboard:w03", wallet: 3, step: "deploy", hashes: ["d"], data: { smartWallet: "CSA" } }),
    ev({ eventId: "onboard:w03", kind: "onboard", wallet: 3, status: "ok", data: { owner: "GOWN", smartWallet: "CSA", poolRuleId: 1, usdcRuleId: 2 } }),
    ev({ eventId: "onboard:w04", kind: "onboard", wallet: 4, status: "failed", error: "x" }),
    st({ eventId: "topup:w03:1", wallet: 3, step: "trustline", hashes: ["t"] }),
    ev({ eventId: "unregister:w03", kind: "unregister", wallet: 3, status: "ok" }),
  ];

  it("treats ok/failed/skipped events as finished, steps as not", () => {
    expect([...finishedEventIds(recs)].sort()).toEqual(["onboard:w03", "onboard:w04", "unregister:w03"]);
  });
  it("indexes the last record per step of an event", () => {
    expect(stepsFor(recs, "onboard:w03").get("deploy")?.data).toEqual({ smartWallet: "CSA" });
  });
  it("tracks onboarded wallets, trustlines and unregistration", () => {
    const s = walletStates(recs);
    expect(s.has(4)).toBe(false);
    expect(s.get(3)).toEqual({ owner: "GOWN", smartWallet: "CSA", poolRuleId: 1, usdcRuleId: 2, registered: false, trustline: true });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/loadtest/manifest.test.ts`
Expected: FAIL, cannot resolve `manifest`.

- [ ] **Step 3: Implement** — `scripts/loadtest/manifest.ts`

```ts
/**
 * The run directory: the single source of truth for a load-test run.
 * `events.jsonl` holds `step` records (sub-step checkpoints — what a resume
 * skips) and `event` records (final outcome per plan event). Everything else
 * (wallet state, finished set) is derived from it, so a crash can never leave
 * two files disagreeing.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PlanEvent } from "./schedule";

export type EventStatus = "ok" | "failed" | "skipped";

/** One completed sub-step of an event — the resume checkpoint. */
export interface StepRecord {
  type: "step";
  eventId: string;
  wallet?: number;
  step: string;
  at: number; // epoch ms
  hashes: string[];
  data?: Record<string, unknown>;
}

/** The final outcome of one plan event. */
export interface EventRecord {
  type: "event";
  eventId: string;
  kind: PlanEvent["kind"];
  wallet?: number;
  status: EventStatus;
  plannedAt: number;
  startedAt: number;
  finishedAt: number;
  hashes: string[];
  error?: string;
  data?: Record<string, unknown>;
}

export type ManifestRecord = StepRecord | EventRecord;

export interface RunFiles {
  dir: string;
  append(rec: ManifestRecord): void;
  read(): ManifestRecord[];
  writeJson(name: string, value: unknown): void;
  writeJsonl(name: string, rows: unknown[]): void;
  readJson<T>(name: string): T | null;
}

const EVENTS = "events.jsonl";

export function openRunDir(dir: string): RunFiles {
  mkdirSync(dir, { recursive: true });
  const file = (name: string) => join(dir, name);
  const ensureDir = (name: string) => mkdirSync(dirname(file(name)), { recursive: true });

  // A hard kill can leave a half-written last line. Cut it now, or the next
  // append would glue a valid record onto it and lose both.
  if (existsSync(file(EVENTS))) {
    const text = readFileSync(file(EVENTS), "utf8");
    if (text && !text.endsWith("\n")) writeFileSync(file(EVENTS), text.slice(0, text.lastIndexOf("\n") + 1));
  }

  return {
    dir,
    append(rec) {
      appendFileSync(file(EVENTS), JSON.stringify(rec) + "\n");
    },
    read() {
      if (!existsSync(file(EVENTS))) return [];
      return readFileSync(file(EVENTS), "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as ManifestRecord);
    },
    writeJson(name, value) {
      ensureDir(name);
      writeFileSync(file(name), JSON.stringify(value, null, 2) + "\n");
    },
    writeJsonl(name, rows) {
      ensureDir(name);
      writeFileSync(file(name), rows.map((r) => JSON.stringify(r) + "\n").join(""));
    },
    readJson<T>(name: string): T | null {
      return existsSync(file(name)) ? (JSON.parse(readFileSync(file(name), "utf8")) as T) : null;
    },
  };
}

/** Any event record (ok, failed or skipped) is final — a resume does not re-run it. */
export function finishedEventIds(recs: ManifestRecord[]): Set<string> {
  return new Set(recs.filter((r): r is EventRecord => r.type === "event").map((r) => r.eventId));
}

/** Last record per step name for one event (what a resumed event can skip). */
export function stepsFor(recs: ManifestRecord[], eventId: string): Map<string, StepRecord> {
  const out = new Map<string, StepRecord>();
  for (const r of recs) if (r.type === "step" && r.eventId === eventId) out.set(r.step, r);
  return out;
}

export interface WalletState {
  owner: string;
  smartWallet: string;
  poolRuleId: number;
  usdcRuleId: number;
  registered: boolean;
  trustline: boolean;
}

export function walletStates(recs: ManifestRecord[]): Map<number, WalletState> {
  const out = new Map<number, WalletState>();
  for (const r of recs) {
    if (r.wallet === undefined) continue;
    const s = out.get(r.wallet);
    if (r.type === "event" && r.kind === "onboard" && r.status === "ok" && r.data) {
      const d = r.data as { owner: string; smartWallet: string; poolRuleId: number; usdcRuleId: number };
      out.set(r.wallet, {
        owner: d.owner,
        smartWallet: d.smartWallet,
        poolRuleId: d.poolRuleId,
        usdcRuleId: d.usdcRuleId,
        registered: true,
        trustline: s?.trustline ?? false,
      });
    } else if (s && r.type === "event" && r.kind === "unregister" && r.status === "ok") {
      s.registered = false;
    } else if (s && r.type === "step" && r.step === "trustline") {
      s.trustline = true;
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/loadtest/manifest.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/loadtest/manifest.ts tests/loadtest/manifest.test.ts
git commit -m "feat(loadtest): resumable run manifest"
```

---

### Task 4: HTTP + YieldSeeker API client

**Files:**
- Create: `scripts/loadtest/http.ts`, `scripts/loadtest/api.ts`
- Test: `tests/loadtest/http.test.ts`, `tests/loadtest/api.test.ts`

**Interfaces:**
- Produces (http.ts): `interface JsonResponse<T> { status: number; data: T | null }`, `requestJson<T>(method: "GET" | "POST" | "DELETE", url: string, body?: unknown, timeoutMs = 120_000): Promise<JsonResponse<T>>` (status 0 = unreachable or timed out; `timeoutMs` 0 = no timeout)
- Produces (api.ts): `class ApiError extends Error { route; status; get permanent(): boolean }`, `interface RegisterBody`, `interface YsApi { agent(); prepareDeploy(owner); prepareFund(owner, smartWallet, amountStroops: bigint); submit(signedXdr, label); authorize(smartWallet, owner); faucet(to, amountUsdc); register(body); unregister(owner); tick(); get(path) }`, `createApi(baseUrl: string, opts?: { request?: typeof requestJson; cronSecret?: string }): YsApi`

- [ ] **Step 1: Write the failing tests**

`tests/loadtest/http.test.ts`

```ts
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requestJson } from "../../scripts/loadtest/http";

let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (status: number, payload: string) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(payload);
      };
      if (req.url === "/echo") return send(200, JSON.stringify({ method: req.method, body: body ? JSON.parse(body) : null }));
      if (req.url === "/slow") return void setTimeout(() => send(200, '{"ok":true}'), 300);
      if (req.url === "/html") {
        res.writeHead(500);
        return res.end("<html>");
      }
      send(404, '{"error":"nope"}');
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("requestJson", () => {
  it("sends a JSON body and parses the JSON answer", async () => {
    expect(await requestJson("POST", `${base}/echo`, { a: 1 })).toEqual({ status: 200, data: { method: "POST", body: { a: 1 } } });
  });
  it("keeps the status when the body is not JSON", async () => {
    expect(await requestJson("GET", `${base}/html`)).toEqual({ status: 500, data: null });
  });
  it("maps an unreachable server to status 0 instead of throwing", async () => {
    expect((await requestJson("GET", "http://127.0.0.1:1/x")).status).toBe(0);
  });
  it("times out to status 0, but waits indefinitely with timeoutMs 0", async () => {
    expect((await requestJson("GET", `${base}/slow`, undefined, 50)).status).toBe(0);
    expect(await requestJson("GET", `${base}/slow`, undefined, 0)).toEqual({ status: 200, data: { ok: true } });
  });
});
```

`tests/loadtest/api.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { ApiError, createApi } from "../../scripts/loadtest/api";
import type { requestJson } from "../../scripts/loadtest/http";

const BASE = "http://localhost:3100";
type Call = { method: string; url: string; body: unknown; timeoutMs: number | undefined };

function fake(status: number, data: unknown) {
  const calls: Call[] = [];
  const request = (async (method: string, url: string, body?: unknown, timeoutMs?: number) => {
    calls.push({ method, url, body, timeoutMs });
    return { status, data };
  }) as unknown as typeof requestJson;
  return { calls, request };
}

describe("createApi", () => {
  it("prepareDeploy posts step=deploy and returns xdr + contractId", async () => {
    const f = fake(200, { xdr: "AAA", contractId: "CSA" });
    expect(await createApi(BASE, { request: f.request }).prepareDeploy("GOWN")).toEqual({ xdr: "AAA", contractId: "CSA" });
    expect(f.calls[0]).toMatchObject({ method: "POST", url: `${BASE}/api/onboard/prepare`, body: { owner: "GOWN", step: "deploy" } });
  });

  it("treats a deploy answer without contractId as an error", async () => {
    await expect(createApi(BASE, { request: fake(200, { xdr: "AAA" }).request }).prepareDeploy("G")).rejects.toBeInstanceOf(ApiError);
  });

  it("prepareFund sends the amount as a decimal stroop string", async () => {
    const f = fake(200, { xdr: "AAA" });
    await createApi(BASE, { request: f.request }).prepareFund("GOWN", "CSA", 2_500_000_000n);
    expect(f.calls[0].body).toEqual({ owner: "GOWN", step: "fund", smartWallet: "CSA", amountStroops: "2500000000" });
  });

  it("faucet and register post the UI's bodies", async () => {
    const f = fake(200, { ok: true, txHash: "m1" });
    const api = createApi(BASE, { request: f.request });
    expect(await api.faucet("CSA", 250)).toEqual({ txHash: "m1" });
    await api.register({ owner: "G", smartWallet: "C", poolRuleId: 1, usdcRuleId: 2 });
    expect(f.calls.map((c) => [c.url, c.body])).toEqual([
      [`${BASE}/api/faucet`, { to: "CSA", amount: 250 }],
      [`${BASE}/api/register`, { owner: "G", smartWallet: "C", poolRuleId: 1, usdcRuleId: 2 }],
    ]);
  });

  it("unregister puts the owner in the query string", async () => {
    const f = fake(200, { ok: true, removed: true });
    expect(await createApi(BASE, { request: f.request }).unregister("GOWN")).toEqual({ removed: true });
    expect(f.calls[0]).toMatchObject({ method: "DELETE", url: `${BASE}/api/register?owner=GOWN` });
  });

  it("tick waits without a client timeout and carries the cron key", async () => {
    const f = fake(200, { ok: true, ranAt: "t" });
    await createApi(BASE, { request: f.request, cronSecret: "s3" }).tick();
    expect(f.calls[0]).toMatchObject({ method: "POST", url: `${BASE}/api/tick?key=s3`, timeoutMs: 0 });
  });

  it("maps failures to ApiError: 4xx permanent, 5xx and unreachable transient, cron key never in the message", async () => {
    const reg = { owner: "G", smartWallet: "C", poolRuleId: 1, usdcRuleId: 2 };
    const e400 = await createApi(BASE, { request: fake(400, { error: "invalid body" }).request }).register(reg).catch((e) => e);
    expect(e400).toBeInstanceOf(ApiError);
    expect(e400.permanent).toBe(true);
    expect(e400.message).toContain("invalid body");
    const e502 = await createApi(BASE, { request: fake(502, { ok: false, error: "faucet mint failed" }).request }).faucet("C", 5).catch((e) => e);
    expect(e502.permanent).toBe(false);
    const e0 = await createApi(BASE, { request: fake(0, null).request, cronSecret: "s3" }).tick().catch((e) => e);
    expect(e0.status).toBe(0);
    expect(e0.message).not.toContain("s3");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/loadtest/http.test.ts tests/loadtest/api.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement** — `scripts/loadtest/http.ts`

```ts
/**
 * Minimal JSON over node:http(s).
 *
 * Deliberately not global fetch: undici's default 300 s headers timeout would
 * abort /api/tick, which supplies every registered user serially and can run
 * for many minutes — and a client-side abort followed by a retry would start a
 * second tick on the same agent key. `timeoutMs: 0` disables the timeout.
 * Network errors resolve to status 0 (like useOnboarding's helpers) so the
 * caller decides whether to wait, retry or give up.
 */
import http from "node:http";
import https from "node:https";

export interface JsonResponse<T = unknown> {
  status: number;
  data: T | null;
}

export function requestJson<T = unknown>(
  method: "GET" | "POST" | "DELETE",
  url: string,
  body?: unknown,
  timeoutMs = 120_000,
): Promise<JsonResponse<T>> {
  return new Promise((resolve) => {
    const u = new URL(url);
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = (u.protocol === "https:" ? https : http).request(
      u,
      {
        method,
        headers: payload ? { "content-type": "application/json", "content-length": payload.length } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let data: T | null = null;
          try {
            data = text ? (JSON.parse(text) as T) : null;
          } catch {
            data = null;
          }
          resolve({ status: res.statusCode ?? 0, data });
        });
        res.on("error", () => resolve({ status: 0, data: null }));
      },
    );
    if (timeoutMs > 0) req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    req.on("error", () => resolve({ status: 0, data: null }));
    if (payload) req.write(payload);
    req.end();
  });
}
```

`scripts/loadtest/api.ts`

```ts
/**
 * Typed client for the YieldSeeker routes the onboarding UI calls
 * (src/app/_components/useOnboarding.ts), plus /api/tick and the read routes
 * used for snapshots. The load test drives the product only through these.
 */
import { requestJson, type JsonResponse } from "./http";

/** A non-2xx (or unreachable, status 0) answer from a YieldSeeker route. */
export class ApiError extends Error {
  constructor(
    readonly route: string,
    readonly status: number,
    detail: string,
  ) {
    super(`${route} → ${status === 0 ? "unreachable" : `HTTP ${status}`}: ${detail}`);
    this.name = "ApiError";
  }
  /** 4xx = the request itself is wrong; retrying cannot help. */
  get permanent(): boolean {
    return this.status >= 400 && this.status < 500;
  }
}

export interface RegisterBody {
  owner: string;
  smartWallet: string;
  poolRuleId: number;
  usdcRuleId: number;
}

export interface YsApi {
  agent(): Promise<{ agentPublicKey: string; ownerPublicKey: string }>;
  prepareDeploy(owner: string): Promise<{ xdr: string; contractId: string }>;
  prepareFund(owner: string, smartWallet: string, amountStroops: bigint): Promise<{ xdr: string }>;
  submit(signedXdr: string, label: string): Promise<{ hash: string }>;
  authorize(smartWallet: string, owner: string): Promise<{ poolRuleId: number; usdcRuleId: number; hashes: string[] }>;
  faucet(to: string, amountUsdc: number): Promise<{ txHash: string }>;
  register(body: RegisterBody): Promise<void>;
  unregister(owner: string): Promise<{ removed: boolean }>;
  tick(): Promise<{ ranAt: string }>;
  get(path: string): Promise<unknown>;
}

type Body = Record<string, unknown> & { error?: string };

/** Authorize submits two txs and polls each; give every call well over that. */
const DEFAULT_TIMEOUT_MS = 300_000;

export function createApi(baseUrl: string, opts: { request?: typeof requestJson; cronSecret?: string } = {}): YsApi {
  const request = opts.request ?? requestJson;

  async function call<T extends Body>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<T> {
    const res: JsonResponse<T> = await request<T>(method, new URL(path, baseUrl).toString(), body, timeoutMs);
    if (res.status < 200 || res.status >= 300 || !res.data) {
      // The query string is dropped from the route so a cron key never reaches a log.
      throw new ApiError(path.split("?")[0], res.status, res.data?.error ?? JSON.stringify(res.data));
    }
    return res.data;
  }

  return {
    async agent() {
      const d = await call<Body & { agentPublicKey: string; ownerPublicKey: string }>("GET", "/api/agent");
      return { agentPublicKey: d.agentPublicKey, ownerPublicKey: d.ownerPublicKey };
    },
    async prepareDeploy(owner) {
      const d = await call<Body & { xdr: string; contractId?: string }>("POST", "/api/onboard/prepare", { owner, step: "deploy" });
      if (!d.contractId) throw new ApiError("/api/onboard/prepare", 200, "deploy answer has no contractId");
      return { xdr: d.xdr, contractId: d.contractId };
    },
    async prepareFund(owner, smartWallet, amountStroops) {
      const d = await call<Body & { xdr: string }>("POST", "/api/onboard/prepare", {
        owner,
        step: "fund",
        smartWallet,
        amountStroops: amountStroops.toString(),
      });
      return { xdr: d.xdr };
    },
    async submit(signedXdr, label) {
      const d = await call<Body & { hash: string }>("POST", "/api/onboard/submit", { signedXdr, label });
      return { hash: d.hash };
    },
    async authorize(smartWallet, owner) {
      const d = await call<Body & { poolRuleId: number; usdcRuleId: number; hashes: string[] }>("POST", "/api/authorize", {
        smartWallet,
        owner,
      });
      return { poolRuleId: d.poolRuleId, usdcRuleId: d.usdcRuleId, hashes: d.hashes };
    },
    async faucet(to, amountUsdc) {
      const d = await call<Body & { txHash: string }>("POST", "/api/faucet", { to, amount: amountUsdc });
      return { txHash: d.txHash };
    },
    async register(body) {
      await call("POST", "/api/register", body);
    },
    async unregister(owner) {
      const d = await call<Body & { removed: boolean }>("DELETE", `/api/register?owner=${encodeURIComponent(owner)}`);
      return { removed: d.removed };
    },
    async tick() {
      const key = opts.cronSecret ? `?key=${encodeURIComponent(opts.cronSecret)}` : "";
      // timeoutMs 0: a tick supplies every registered user serially and can take many minutes.
      const d = await call<Body & { ranAt: string }>("POST", `/api/tick${key}`, undefined, 0);
      return { ranAt: d.ranAt };
    },
    async get(path) {
      return call<Body>("GET", path);
    },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/loadtest/http.test.ts tests/loadtest/api.test.ts`
Expected: PASS (4 + 7 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/loadtest/http.ts scripts/loadtest/api.ts tests/loadtest/http.test.ts tests/loadtest/api.test.ts
git commit -m "feat(loadtest): YieldSeeker API client without client-side tick timeout"
```

---

### Task 5: Chain helpers (signing, friendbot, Horizon, trustline, simulate)

**Files:**
- Create: `scripts/loadtest/chain.ts`
- Test: `tests/loadtest/chain.test.ts`

**Interfaces:**
- Produces: `TESTNET_PASSPHRASE`, `HORIZON_URL`, `FRIENDBOT_URL`, `type FetchLike = (url: string) => Promise<{ status: number; json(): Promise<unknown> }>`, `interface HorizonAccount`, `signPrepared(xdr, kp, passphrase?): string`, `assetFromSacName(name): Asset`, `buildTrustlineTx(source: Account, kp, asset, passphrase?): string`, `loadHorizonAccount(address, fetchFn?): Promise<HorizonAccount | null>`, `xlmBalance(acc): number`, `hasTrustline(acc, asset): boolean`, `ensureFunded(address, fetchFn?): Promise<"funded" | "exists">`, `sendAndPoll(server, signedXdr, passphrase?): Promise<string>`, `simulateCall(server, contractId, method, args: xdr.ScVal[], source, passphrase?): Promise<unknown>`, `readContractString(server, contractId, method, source, passphrase?): Promise<string>`, `interface ChainOps { ensureFunded(address); ensureTrustline(kp): Promise<string | null>; sign(xdr, kp): string }`, `createChainOps({ server, asset, fetchFn? }): ChainOps`

- [ ] **Step 1: Write the failing test** — `tests/loadtest/chain.test.ts`

```ts
import { Account, Asset, Keypair, Operation, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  assetFromSacName,
  buildTrustlineTx,
  ensureFunded,
  hasTrustline,
  signPrepared,
  TESTNET_PASSPHRASE,
  xlmBalance,
  type FetchLike,
} from "../../scripts/loadtest/chain";

const kp = Keypair.random();
const unsignedXdr = () =>
  new TransactionBuilder(new Account(kp.publicKey(), "1"), { fee: "100", networkPassphrase: TESTNET_PASSPHRASE })
    .addOperation(Operation.bumpSequence({ bumpTo: "2" }))
    .setTimeout(30)
    .build()
    .toXDR();

describe("signing", () => {
  it("signPrepared adds the wallet's signature (the Freighter stand-in)", () => {
    const tx = TransactionBuilder.fromXDR(signPrepared(unsignedXdr(), kp), TESTNET_PASSPHRASE) as Transaction;
    expect(tx.signatures).toHaveLength(1);
    expect(kp.verify(tx.hash(), tx.signatures[0].signature())).toBe(true);
  });
  it("buildTrustlineTx is a signed changeTrust for the asset", () => {
    const asset = new Asset("USDC", Keypair.random().publicKey());
    const tx = TransactionBuilder.fromXDR(buildTrustlineTx(new Account(kp.publicKey(), "1"), kp, asset), TESTNET_PASSPHRASE) as Transaction;
    expect(tx.operations[0].type).toBe("changeTrust");
    expect(tx.signatures).toHaveLength(1);
  });
});

describe("assetFromSacName", () => {
  it("parses the SAC name() into a classic asset", () => {
    const issuer = Keypair.random().publicKey();
    const a = assetFromSacName(`USDC:${issuer}`);
    expect([a.getCode(), a.getIssuer()]).toEqual(["USDC", issuer]);
    expect(() => assetFromSacName("native")).toThrow(/unexpected SAC name/);
  });
});

describe("horizon helpers", () => {
  const issuer = Keypair.random().publicKey();
  const acc = {
    balances: [
      { asset_type: "native", balance: "9999.5" },
      { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: issuer, balance: "0" },
    ],
  };

  it("reads XLM and trustlines", () => {
    expect(xlmBalance(acc)).toBe(9999.5);
    expect(hasTrustline(acc, new Asset("USDC", issuer))).toBe(true);
    expect(hasTrustline(acc, new Asset("USDC", Keypair.random().publicKey()))).toBe(false);
  });

  it("ensureFunded calls friendbot only for a missing account", async () => {
    const urls: string[] = [];
    const fetchFn = (exists: boolean, friendbotStatus = 200): FetchLike => async (url) => {
      urls.push(url);
      return { status: url.includes("friendbot") ? friendbotStatus : exists ? 200 : 404, json: async () => acc };
    };
    expect(await ensureFunded(kp.publicKey(), fetchFn(true))).toBe("exists");
    expect(urls.some((u) => u.includes("friendbot"))).toBe(false);
    expect(await ensureFunded(kp.publicKey(), fetchFn(false))).toBe("funded");
    expect(urls.at(-1)).toContain(`friendbot.stellar.org/?addr=${kp.publicKey()}`);
    await expect(ensureFunded(kp.publicKey(), fetchFn(false, 500))).rejects.toThrow(/friendbot/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/loadtest/chain.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** — `scripts/loadtest/chain.ts`

```ts
/**
 * Testnet plumbing the product routes do not cover: wallet signing (the
 * script's stand-in for Freighter), Friendbot funding, Horizon reads, the
 * classic USDC trustline a drip wallet needs before a G→SA transfer, and
 * read-only contract simulation.
 */
import {
  Account,
  Asset,
  BASE_FEE,
  Contract,
  Keypair,
  Operation,
  TransactionBuilder,
  rpc,
  scValToNative,
  type Transaction,
  type xdr,
} from "@stellar/stellar-sdk";

export const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
export const HORIZON_URL = "https://horizon-testnet.stellar.org";
export const FRIENDBOT_URL = "https://friendbot.stellar.org";

export type FetchLike = (url: string) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface HorizonAccount {
  balances: Array<{ asset_type: string; asset_code?: string; asset_issuer?: string; balance: string }>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Sign a server-prepared envelope as the wallet (what Freighter signTransaction does in the UI). */
export function signPrepared(xdrB64: string, kp: Keypair, passphrase = TESTNET_PASSPHRASE): string {
  const tx = TransactionBuilder.fromXDR(xdrB64, passphrase) as Transaction;
  tx.sign(kp);
  return tx.toXDR();
}

/** "USDC:G…" (a SAC's name()) → the classic asset it wraps. */
export function assetFromSacName(name: string): Asset {
  const [code, issuer] = name.split(":");
  if (!code || !issuer) throw new Error(`unexpected SAC name: ${name}`);
  return new Asset(code, issuer);
}

export function buildTrustlineTx(source: Account, kp: Keypair, asset: Asset, passphrase = TESTNET_PASSPHRASE): string {
  const tx = new TransactionBuilder(source, { fee: (Number(BASE_FEE) * 100).toString(), networkPassphrase: passphrase })
    .addOperation(Operation.changeTrust({ asset }))
    .setTimeout(120)
    .build();
  tx.sign(kp);
  return tx.toXDR();
}

export async function loadHorizonAccount(address: string, fetchFn: FetchLike = fetch): Promise<HorizonAccount | null> {
  const res = await fetchFn(`${HORIZON_URL}/accounts/${address}`);
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`horizon /accounts/${address} → HTTP ${res.status}`);
  return (await res.json()) as HorizonAccount;
}

export function xlmBalance(acc: HorizonAccount): number {
  const b = acc.balances.find((x) => x.asset_type === "native");
  return b ? Number(b.balance) : 0;
}

export function hasTrustline(acc: HorizonAccount, asset: Asset): boolean {
  return acc.balances.some((b) => b.asset_code === asset.getCode() && b.asset_issuer === asset.getIssuer());
}

/** Friendbot only when the account does not exist yet — a resumed run must not fail on "already funded". */
export async function ensureFunded(address: string, fetchFn: FetchLike = fetch): Promise<"funded" | "exists"> {
  if (await loadHorizonAccount(address, fetchFn)) return "exists";
  const res = await fetchFn(`${FRIENDBOT_URL}/?addr=${encodeURIComponent(address)}`);
  if (res.status !== 200) throw new Error(`friendbot ${address} → HTTP ${res.status}`);
  return "funded";
}

export async function sendAndPoll(server: rpc.Server, signedXdr: string, passphrase = TESTNET_PASSPHRASE): Promise<string> {
  const tx = TransactionBuilder.fromXDR(signedXdr, passphrase);
  let sent = await server.sendTransaction(tx);
  for (let i = 0; i < 10 && sent.status === "TRY_AGAIN_LATER"; i++) {
    await sleep(3000);
    sent = await server.sendTransaction(tx);
  }
  if (sent.status === "ERROR") throw new Error(`send ERROR for ${sent.hash}`);
  let g = await server.getTransaction(sent.hash);
  for (let i = 0; i < 30 && g.status === "NOT_FOUND"; i++) {
    await sleep(1000);
    g = await server.getTransaction(sent.hash);
  }
  if (g.status !== "SUCCESS") throw new Error(`tx ${sent.hash} ${g.status}`);
  return sent.hash;
}

/** Read-only contract call via simulation; `source` only has to exist (it never signs). */
export async function simulateCall(
  server: rpc.Server,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  source: string,
  passphrase = TESTNET_PASSPHRASE,
): Promise<unknown> {
  const acc = await server.getAccount(source);
  const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`${method}() simulate failed: ${sim.error}`);
  const retval = (sim as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
  if (!retval) throw new Error(`${method}() returned no value`);
  return scValToNative(retval);
}

export async function readContractString(
  server: rpc.Server,
  contractId: string,
  method: string,
  source: string,
  passphrase = TESTNET_PASSPHRASE,
): Promise<string> {
  return String(await simulateCall(server, contractId, method, [], source, passphrase));
}

export interface ChainOps {
  ensureFunded(address: string): Promise<"funded" | "exists">;
  /** Hash of the new trustline tx, or null when the wallet already had one. */
  ensureTrustline(kp: Keypair): Promise<string | null>;
  sign(xdrB64: string, kp: Keypair): string;
}

export function createChainOps(opts: { server: rpc.Server; asset: Asset; fetchFn?: FetchLike }): ChainOps {
  const fetchFn = opts.fetchFn ?? fetch;
  return {
    ensureFunded: (address) => ensureFunded(address, fetchFn),
    async ensureTrustline(kp) {
      const acc = await loadHorizonAccount(kp.publicKey(), fetchFn);
      if (!acc) throw new Error(`wallet ${kp.publicKey()} does not exist`);
      if (hasTrustline(acc, opts.asset)) return null;
      const source = await opts.server.getAccount(kp.publicKey());
      return sendAndPoll(opts.server, buildTrustlineTx(source, kp, opts.asset));
    },
    sign: (xdrB64, kp) => signPrepared(xdrB64, kp),
  };
}
```

- [ ] **Step 4: Run the tests + typecheck**

Run: `npx vitest run tests/loadtest/chain.test.ts && npx tsc --noEmit 2>&1 | grep -c "error TS" || true`
Expected: PASS (5 tests); the tsc error count equals the Task 1 baseline.

- [ ] **Step 5: Commit**

```bash
git add scripts/loadtest/chain.ts tests/loadtest/chain.test.ts
git commit -m "feat(loadtest): testnet chain helpers"
```

---

### Task 6: Event steps (onboard / top-up / unregister / tick / snapshot)

**Files:**
- Create: `scripts/loadtest/steps.ts`
- Test: `tests/loadtest/steps.test.ts`

**Interfaces:**
- Consumes: `YsApi`, `ApiError` (Task 4); `ChainOps` (Task 5); `RunFiles`, `stepsFor`, `walletStates`, `EventRecord`, `StepRecord` (Task 3); `PlanEvent` (Task 2)
- Produces: `STROOPS_PER_USDC = 10_000_000n`, `interface StepCtx { api; chain; files; wallet(index): Keypair; now(): number; sleep(ms): Promise<void>; retry: { attempts; baseDelayMs; outageWaitMs; maxOutageWaits }; log(msg): void }`, `runEvent(ctx: StepCtx, ev: PlanEvent, plannedAt: number): Promise<EventRecord>` (appends the event record itself)

- [ ] **Step 1: Write the failing test** — `tests/loadtest/steps.test.ts`

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import { ApiError, type YsApi } from "../../scripts/loadtest/api";
import type { ChainOps } from "../../scripts/loadtest/chain";
import { openRunDir, type RunFiles } from "../../scripts/loadtest/manifest";
import type { PlanEvent } from "../../scripts/loadtest/schedule";
import { runEvent, type StepCtx } from "../../scripts/loadtest/steps";

const wallets = [Keypair.random(), Keypair.random()];
const tmpFiles = () => openRunDir(mkdtempSync(join(tmpdir(), "ys-lt-")));

function fakeApi(over: Partial<YsApi> = {}): YsApi {
  return {
    agent: vi.fn(async () => ({ agentPublicKey: "GAGENT", ownerPublicKey: "GDEMO" })),
    prepareDeploy: vi.fn(async () => ({ xdr: "UNSIGNED", contractId: "CSA0" })),
    prepareFund: vi.fn(async () => ({ xdr: "UNSIGNED_FUND" })),
    submit: vi.fn(async (x: string) => ({ hash: `h(${x})` })),
    authorize: vi.fn(async () => ({ poolRuleId: 1, usdcRuleId: 2, hashes: ["hp", "hu"] })),
    faucet: vi.fn(async (to: string, usdc: number) => ({ txHash: `mint(${to},${usdc})` })),
    register: vi.fn(async () => {}),
    unregister: vi.fn(async () => ({ removed: true })),
    tick: vi.fn(async () => ({ ranAt: "t" })),
    get: vi.fn(async (p: string) => ({ route: p })),
    ...over,
  };
}
function fakeChain(): ChainOps {
  return {
    ensureFunded: vi.fn(async () => "funded" as const),
    ensureTrustline: vi.fn(async () => "htrust"),
    sign: vi.fn((xdr: string) => `signed:${xdr}`),
  };
}
function ctxWith(api: YsApi, files: RunFiles = tmpFiles(), chain: ChainOps = fakeChain()): StepCtx {
  let t = 1_000;
  return {
    api, chain, files,
    wallet: (i) => wallets[i],
    now: () => (t += 10),
    sleep: async () => {},
    retry: { attempts: 3, baseDelayMs: 1, outageWaitMs: 1, maxOutageWaits: 2 },
    log: () => {},
  };
}
const onboard: PlanEvent = { id: "onboard:w00", atMin: 0, kind: "onboard", wallet: 0, fundUsdc: 250 };
const owner0 = wallets[0].publicKey();

describe("onboard", () => {
  it("runs friendbot → deploy → authorize → fund → register like the UI", async () => {
    const api = fakeApi();
    const ctx = ctxWith(api);
    const rec = await runEvent(ctx, onboard, 0);
    expect(rec).toMatchObject({
      status: "ok",
      hashes: ["h(signed:UNSIGNED)", "hp", "hu", "mint(CSA0,250)"],
      data: { owner: owner0, smartWallet: "CSA0", poolRuleId: 1, usdcRuleId: 2, fundUsdc: 250 },
    });
    expect(ctx.chain.sign).toHaveBeenCalledWith("UNSIGNED", wallets[0]);
    expect(api.authorize).toHaveBeenCalledWith("CSA0", owner0);
    expect(api.faucet).toHaveBeenCalledWith("CSA0", 250);
    expect(api.register).toHaveBeenCalledWith({ owner: owner0, smartWallet: "CSA0", poolRuleId: 1, usdcRuleId: 2 });
    expect(ctx.files.read().at(-1)).toEqual(rec);
  });

  it("resumes after deploy + authorize without redeploying", async () => {
    const files = tmpFiles();
    files.append({ type: "step", eventId: onboard.id, wallet: 0, step: "friendbot", at: 1, hashes: [] });
    files.append({ type: "step", eventId: onboard.id, wallet: 0, step: "deploy", at: 1, hashes: ["hd"], data: { smartWallet: "CSA_OLD" } });
    files.append({ type: "step", eventId: onboard.id, wallet: 0, step: "authorize", at: 1, hashes: ["hp", "hu"], data: { poolRuleId: 5, usdcRuleId: 6 } });
    const api = fakeApi();
    const rec = await runEvent(ctxWith(api, files), onboard, 0);
    expect(api.prepareDeploy).not.toHaveBeenCalled();
    expect(api.authorize).not.toHaveBeenCalled();
    expect(api.faucet).toHaveBeenCalledWith("CSA_OLD", 250);
    expect(rec.data).toMatchObject({ smartWallet: "CSA_OLD", poolRuleId: 5, usdcRuleId: 6 });
    expect(rec.hashes).toEqual(["hd", "hp", "hu", "mint(CSA_OLD,250)"]);
  });

  it("retries a transient failure, then succeeds", async () => {
    let n = 0;
    const api = fakeApi({
      authorize: vi.fn(async () => {
        if (n++ < 2) throw new ApiError("/api/authorize", 500, "boom");
        return { poolRuleId: 1, usdcRuleId: 2, hashes: ["hp", "hu"] };
      }),
    });
    expect((await runEvent(ctxWith(api), onboard, 0)).status).toBe("ok");
    expect(api.authorize).toHaveBeenCalledTimes(3);
  });

  it("waits out an unreachable server without burning attempts", async () => {
    let n = 0;
    const api = fakeApi({
      faucet: vi.fn(async () => {
        if (n++ < 2) throw new ApiError("/api/faucet", 0, "null");
        return { txHash: "m" };
      }),
      register: vi.fn(async () => {
        throw new ApiError("/api/register", 500, "x");
      }),
    });
    const rec = await runEvent(ctxWith(api), onboard, 0);
    // 2 outages absorbed on faucet; register then burns its own 3 attempts.
    expect(api.faucet).toHaveBeenCalledTimes(3);
    expect(api.register).toHaveBeenCalledTimes(3);
    expect(rec.status).toBe("failed");
  });

  it("fails fast on a 4xx and records the error", async () => {
    const api = fakeApi({
      register: vi.fn(async () => {
        throw new ApiError("/api/register", 400, "invalid body");
      }),
    });
    const rec = await runEvent(ctxWith(api), onboard, 0);
    expect(rec.status).toBe("failed");
    expect(rec.error).toContain("invalid body");
    expect(api.register).toHaveBeenCalledTimes(1);
  });
});

describe("after onboarding", () => {
  async function onboarded() {
    const ctx = ctxWith(fakeApi());
    await runEvent(ctx, onboard, 0);
    return ctx;
  }

  it("transfer top-up: trustline → mint to G → wallet-signed G→SA transfer", async () => {
    const ctx = await onboarded();
    const rec = await runEvent(ctx, { id: "topup:w00:1", atMin: 60, kind: "topup", wallet: 0, usdc: 100, via: "transfer" }, 0);
    expect(rec.status).toBe("ok");
    expect(ctx.api.faucet).toHaveBeenLastCalledWith(owner0, 100);
    expect(ctx.api.prepareFund).toHaveBeenCalledWith(owner0, "CSA0", 1_000_000_000n);
    expect(rec.hashes).toEqual(["htrust", `mint(${owner0},100)`, "h(signed:UNSIGNED_FUND)"]);
  });

  it("second transfer top-up skips the trustline", async () => {
    const ctx = await onboarded();
    await runEvent(ctx, { id: "topup:w00:1", atMin: 60, kind: "topup", wallet: 0, usdc: 100, via: "transfer" }, 0);
    await runEvent(ctx, { id: "topup:w00:2", atMin: 90, kind: "topup", wallet: 0, usdc: 50, via: "transfer" }, 0);
    expect(ctx.chain.ensureTrustline).toHaveBeenCalledTimes(1);
  });

  it("faucet top-up mints into the smart account", async () => {
    const ctx = await onboarded();
    await runEvent(ctx, { id: "topup:w00:1", atMin: 60, kind: "topup", wallet: 0, usdc: 3000, via: "faucet" }, 0);
    expect(ctx.api.faucet).toHaveBeenLastCalledWith("CSA0", 3000);
  });

  it("unregister forgets the owner", async () => {
    const ctx = await onboarded();
    const rec = await runEvent(ctx, { id: "unregister:w00", atMin: 90, kind: "unregister", wallet: 0 }, 0);
    expect(ctx.api.unregister).toHaveBeenCalledWith(owner0);
    expect(rec.data).toMatchObject({ removed: true, smartWallet: "CSA0" });
  });

  it("skips actions for a wallet that never onboarded", async () => {
    const ctx = ctxWith(fakeApi());
    const rec = await runEvent(ctx, { id: "topup:w01:1", atMin: 60, kind: "topup", wallet: 1, usdc: 50, via: "faucet" }, 0);
    expect(rec.status).toBe("skipped");
    expect(ctx.api.faucet).not.toHaveBeenCalled();
  });

  it("tick records the server's ranAt and how long it took", async () => {
    const rec = await runEvent(ctxWith(fakeApi()), { id: "tick:0010", atMin: 10, kind: "tick" }, 0);
    expect(rec.data).toMatchObject({ ranAt: "t" });
    expect(Number(rec.data?.durationMs)).toBeGreaterThan(0);
  });

  it("snapshot writes every read route to the run dir", async () => {
    const ctx = ctxWith(fakeApi());
    await runEvent(ctx, { id: "snapshot:0120", atMin: 120, kind: "snapshot" }, 0);
    const snap = ctx.files.readJson<Record<string, unknown>>("snapshots/snapshot-0120.json")!;
    expect(snap["/api/users"]).toEqual({ route: "/api/users" });
    expect(snap["/api/activity"]).toEqual({ route: "/api/activity" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/loadtest/steps.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** — `scripts/loadtest/steps.ts`

```ts
/**
 * One function per plan-event kind. Each sub-step that lands on-chain is
 * checkpointed (a `step` record) the moment it succeeds, so a resumed run picks
 * up exactly where a crash left it — never a second deploy, authorize or mint.
 */
import type { Keypair } from "@stellar/stellar-sdk";
import { ApiError, type YsApi } from "./api";
import type { ChainOps } from "./chain";
import { stepsFor, walletStates, type EventRecord, type RunFiles, type StepRecord } from "./manifest";
import type { PlanEvent } from "./schedule";

export const STROOPS_PER_USDC = 10_000_000n;

export interface StepCtx {
  api: YsApi;
  chain: ChainOps;
  files: RunFiles;
  wallet(index: number): Keypair;
  now(): number;
  sleep(ms: number): Promise<void>;
  /**
   * attempts / baseDelayMs: real failures back off ×3 (5 s → 15 s by default).
   * outageWaitMs / maxOutageWaits: an unreachable server (status 0) is waited
   * out without burning attempts, so a server restart mid-run costs time, not events.
   */
  retry: { attempts: number; baseDelayMs: number; outageWaitMs: number; maxOutageWaits: number };
  log(msg: string): void;
}

type Result = { hashes: string[]; data?: Record<string, unknown> };
type Ev<K extends PlanEvent["kind"]> = Extract<PlanEvent, { kind: K }>;

/** Thrown when an event cannot apply (its wallet never onboarded) — recorded as "skipped". */
class SkipEvent extends Error {}

async function withRetry<T>(ctx: StepCtx, label: string, fn: () => Promise<T>): Promise<T> {
  let failures = 0;
  let outages = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ApiError && e.status === 0 && outages < ctx.retry.maxOutageWaits) {
        outages++;
        ctx.log(`${label}: server unreachable, waiting ${ctx.retry.outageWaitMs} ms`);
        await ctx.sleep(ctx.retry.outageWaitMs);
        continue;
      }
      if (e instanceof ApiError && e.permanent) throw e;
      failures++;
      if (failures >= ctx.retry.attempts) throw e;
      const wait = ctx.retry.baseDelayMs * 3 ** (failures - 1);
      ctx.log(`${label}: attempt ${failures} failed (${(e as Error).message}); retry in ${wait} ms`);
      await ctx.sleep(wait);
    }
  }
}

function checkpoint(ctx: StepCtx, ev: PlanEvent, step: string, hashes: string[], data?: Record<string, unknown>): void {
  const rec: StepRecord = { type: "step", eventId: ev.id, wallet: "wallet" in ev ? ev.wallet : undefined, step, at: ctx.now(), hashes, data };
  ctx.files.append(rec);
}

async function onboard(ctx: StepCtx, ev: Ev<"onboard">): Promise<Result> {
  const kp = ctx.wallet(ev.wallet);
  const owner = kp.publicKey();
  const done = stepsFor(ctx.files.read(), ev.id);
  const hashes = [...done.values()].flatMap((s) => s.hashes);

  if (!done.has("friendbot")) {
    const r = await withRetry(ctx, `${ev.id} friendbot`, () => ctx.chain.ensureFunded(owner));
    checkpoint(ctx, ev, "friendbot", [], { result: r });
  }

  // 1 — deploy: server prepares, the wallet signs (Freighter in the UI), server submits.
  // A retry after an ambiguous submit can orphan one smart account; the export's
  // per-wallet Horizon listing still captures it.
  let smartWallet = done.get("deploy")?.data?.smartWallet as string | undefined;
  if (!smartWallet) {
    const d = await withRetry(ctx, `${ev.id} deploy`, async () => {
      const prep = await ctx.api.prepareDeploy(owner);
      const sub = await ctx.api.submit(ctx.chain.sign(prep.xdr, kp), `loadtest deploy ${ev.id}`);
      return { hash: sub.hash, smartWallet: prep.contractId };
    });
    smartWallet = d.smartWallet;
    hashes.push(d.hash);
    checkpoint(ctx, ev, "deploy", [d.hash], { smartWallet });
  }
  const sw = smartWallet;

  // 2 — authorize: the backend demo owner adds the pool + capped USDC agent rules.
  let rules = done.get("authorize")?.data as { poolRuleId: number; usdcRuleId: number } | undefined;
  if (!rules) {
    const a = await withRetry(ctx, `${ev.id} authorize`, () => ctx.api.authorize(sw, owner));
    rules = { poolRuleId: a.poolRuleId, usdcRuleId: a.usdcRuleId };
    hashes.push(...a.hashes);
    checkpoint(ctx, ev, "authorize", a.hashes, rules);
  }
  const r = rules;

  // 3 — fund: the UI's Fund step mints test USDC straight into the smart account.
  if (!done.has("fund")) {
    const f = await withRetry(ctx, `${ev.id} fund`, () => ctx.api.faucet(sw, ev.fundUsdc));
    hashes.push(f.txHash);
    checkpoint(ctx, ev, "fund", [f.txHash], { usdc: ev.fundUsdc });
  }

  // 4 — register.
  if (!done.has("register")) {
    await withRetry(ctx, `${ev.id} register`, () => ctx.api.register({ owner, smartWallet: sw, ...r }));
    checkpoint(ctx, ev, "register", []);
  }
  return { hashes, data: { owner, smartWallet: sw, ...r, fundUsdc: ev.fundUsdc } };
}

async function topup(ctx: StepCtx, ev: Ev<"topup">): Promise<Result> {
  const recs = ctx.files.read();
  const state = walletStates(recs).get(ev.wallet);
  if (!state) throw new SkipEvent(`wallet ${ev.wallet} was never onboarded`);
  const done = stepsFor(recs, ev.id);
  const hashes = [...done.values()].flatMap((s) => s.hashes);
  const data = { smartWallet: state.smartWallet, usdc: ev.usdc, via: ev.via };

  if (ev.via === "faucet") {
    if (!done.has("mint-sa")) {
      const f = await withRetry(ctx, `${ev.id} mint`, () => ctx.api.faucet(state.smartWallet, ev.usdc));
      hashes.push(f.txHash);
      checkpoint(ctx, ev, "mint-sa", [f.txHash], { usdc: ev.usdc });
    }
    return { hashes, data };
  }

  // via "transfer": the user moves USDC from their own G into the smart account
  // (/api/onboard/prepare step=fund — the route the UI no longer calls).
  const kp = ctx.wallet(ev.wallet);
  if (!state.trustline && !done.has("trustline")) {
    const h = await withRetry(ctx, `${ev.id} trustline`, () => ctx.chain.ensureTrustline(kp));
    if (h) hashes.push(h);
    checkpoint(ctx, ev, "trustline", h ? [h] : []);
  }
  if (!done.has("mint-g")) {
    const f = await withRetry(ctx, `${ev.id} mint-g`, () => ctx.api.faucet(state.owner, ev.usdc));
    hashes.push(f.txHash);
    checkpoint(ctx, ev, "mint-g", [f.txHash], { usdc: ev.usdc });
  }
  if (!done.has("transfer")) {
    const t = await withRetry(ctx, `${ev.id} transfer`, async () => {
      const prep = await ctx.api.prepareFund(state.owner, state.smartWallet, BigInt(ev.usdc) * STROOPS_PER_USDC);
      return ctx.api.submit(ctx.chain.sign(prep.xdr, kp), `loadtest transfer ${ev.id}`);
    });
    hashes.push(t.hash);
    checkpoint(ctx, ev, "transfer", [t.hash], { usdc: ev.usdc });
  }
  return { hashes, data };
}

async function unregister(ctx: StepCtx, ev: Ev<"unregister">): Promise<Result> {
  const state = walletStates(ctx.files.read()).get(ev.wallet);
  if (!state) throw new SkipEvent(`wallet ${ev.wallet} was never onboarded`);
  const r = await withRetry(ctx, ev.id, () => ctx.api.unregister(state.owner));
  return { hashes: [], data: { owner: state.owner, smartWallet: state.smartWallet, removed: r.removed } };
}

async function tick(ctx: StepCtx): Promise<Result> {
  const t0 = ctx.now();
  const r = await withRetry(ctx, "tick", () => ctx.api.tick());
  // Supply hashes are only in the server's activity log — export.ts pulls them.
  return { hashes: [], data: { ranAt: r.ranAt, durationMs: ctx.now() - t0 } };
}

const SNAPSHOT_ROUTES = ["/api/users", "/api/decision", "/api/scan", "/api/position", "/api/activity"];

async function snapshot(ctx: StepCtx, ev: Ev<"snapshot">): Promise<Result> {
  const out: Record<string, unknown> = { at: ctx.now() };
  for (const route of SNAPSHOT_ROUTES) {
    // Best-effort: a failing read route is recorded, never fails the run.
    out[route] = await ctx.api.get(route).catch((e: Error) => ({ error: e.message }));
  }
  const file = `snapshots/${ev.id.replace(":", "-")}.json`;
  ctx.files.writeJson(file, out);
  return { hashes: [], data: { file } };
}

function dispatch(ctx: StepCtx, ev: PlanEvent): Promise<Result> {
  switch (ev.kind) {
    case "onboard":
      return onboard(ctx, ev);
    case "topup":
      return topup(ctx, ev);
    case "unregister":
      return unregister(ctx, ev);
    case "tick":
      return tick(ctx);
    case "snapshot":
      return snapshot(ctx, ev);
  }
}

export async function runEvent(ctx: StepCtx, ev: PlanEvent, plannedAt: number): Promise<EventRecord> {
  const startedAt = ctx.now();
  const base = { type: "event" as const, eventId: ev.id, kind: ev.kind, wallet: "wallet" in ev ? ev.wallet : undefined, plannedAt, startedAt };
  let rec: EventRecord;
  try {
    const r = await dispatch(ctx, ev);
    rec = { ...base, status: "ok", finishedAt: ctx.now(), hashes: r.hashes, data: r.data };
  } catch (e) {
    rec = { ...base, status: e instanceof SkipEvent ? "skipped" : "failed", finishedAt: ctx.now(), hashes: [], error: (e as Error).message };
  }
  ctx.files.append(rec);
  return rec;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/loadtest/steps.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/loadtest/steps.ts tests/loadtest/steps.test.ts
git commit -m "feat(loadtest): checkpointed event steps mirroring the UI onboarding"
```

---

### Task 7: Driver loop + run CLI

**Files:**
- Create: `scripts/loadtest/driver.ts`, `scripts/loadtest/run.ts`
- Test: `tests/loadtest/driver.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–6
- Produces (driver.ts): `parseScale(s: string): number`, `dueAt(startedAt, atMin, timeScale): number`, `interface DriverOpts { events; startedAt; timeScale; finished: Set<string>; now(); sleep(ms); exec(ev, plannedAt): Promise<void>; log(msg) }`, `runPlan(o: DriverOpts): Promise<number>`
- Produces (run.ts): `interface RunMeta { runId; startedAt; timeScale; baseUrl; walletCount; planSeed; agentPublicKey; usdcSac; gitSha }` (type-only use by Task 9)

- [ ] **Step 1: Write the failing test** — `tests/loadtest/driver.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { dueAt, parseScale, runPlan } from "../../scripts/loadtest/driver";
import type { PlanEvent } from "../../scripts/loadtest/schedule";

const evs: PlanEvent[] = [
  { id: "snapshot:0000", atMin: 0, kind: "snapshot" },
  { id: "onboard:w00", atMin: 5, kind: "onboard", wallet: 0, fundUsdc: 1 },
  { id: "tick:0010", atMin: 10, kind: "tick" },
];

function clock(start: number) {
  let t = start;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    advance: (ms: number) => (t += ms),
    slept,
  };
}

describe("driver", () => {
  it("parseScale accepts decimals and fractions", () => {
    expect(parseScale("1")).toBe(1);
    expect(parseScale("1/96")).toBeCloseTo(1 / 96);
    expect(() => parseScale("0")).toThrow(/positive/);
    expect(() => parseScale("x")).toThrow(/positive/);
  });

  it("dueAt maps plan minutes to wall time", () => {
    expect(dueAt(1000, 10, 1)).toBe(601_000);
    expect(dueAt(1000, 1440, 1 / 96)).toBe(901_000);
  });

  it("runs events in order, sleeping until each is due", async () => {
    const c = clock(0);
    const ran: Array<[string, number, number]> = [];
    const n = await runPlan({
      events: evs, startedAt: 0, timeScale: 1, finished: new Set(), now: c.now, sleep: c.sleep, log: () => {},
      exec: async (ev, plannedAt) => void ran.push([ev.id, plannedAt, c.now()]),
    });
    expect(n).toBe(3);
    expect(ran).toEqual([["snapshot:0000", 0, 0], ["onboard:w00", 300_000, 300_000], ["tick:0010", 600_000, 600_000]]);
  });

  it("on resume skips finished events and runs overdue ones immediately", async () => {
    const c = clock(700_000);
    const ran: string[] = [];
    await runPlan({
      events: evs, startedAt: 0, timeScale: 1, finished: new Set(["snapshot:0000"]), now: c.now, sleep: c.sleep, log: () => {},
      exec: async (ev) => void ran.push(ev.id),
    });
    expect(ran).toEqual(["onboard:w00", "tick:0010"]);
    expect(c.slept).toEqual([]);
  });

  it("a slow event delays the next one instead of overlapping it", async () => {
    const c = clock(0);
    const starts: number[] = [];
    await runPlan({
      events: evs, startedAt: 0, timeScale: 1, finished: new Set(), now: c.now, sleep: c.sleep, log: () => {},
      exec: async () => {
        starts.push(c.now());
        c.advance(400_000);
      },
    });
    expect(starts).toEqual([0, 400_000, 800_000]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/loadtest/driver.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** — `scripts/loadtest/driver.ts`

```ts
import type { PlanEvent } from "./schedule";

/** "1" → 1 (real time), "1/96" → 24 h squeezed into 15 min (smoke runs). */
export function parseScale(s: string): number {
  const [a, b] = s.split("/");
  const v = b === undefined ? Number(a) : Number(a) / Number(b);
  if (!Number.isFinite(v) || v <= 0) throw new Error(`--scale must be a positive number or fraction, got "${s}"`);
  return v;
}

export function dueAt(startedAt: number, atMin: number, timeScale: number): number {
  return startedAt + Math.round(atMin * 60_000 * timeScale);
}

export interface DriverOpts {
  events: PlanEvent[];
  startedAt: number;
  timeScale: number;
  finished: Set<string>;
  now(): number;
  sleep(ms: number): Promise<void>;
  exec(ev: PlanEvent, plannedAt: number): Promise<void>;
  log(msg: string): void;
}

/**
 * Walk the plan in order, one event at a time. Strictly serial on purpose: the
 * load-test agent pays every authorize + supply and the faucet admin signs every
 * mint, so two in-flight txs from either collide on the account sequence number
 * (tx_bad_seq). A long tick therefore delays later events instead of
 * overlapping them; the plannedAt/startedAt gap in events.jsonl records the lag.
 */
export async function runPlan(o: DriverOpts): Promise<number> {
  let ran = 0;
  for (const ev of o.events) {
    if (o.finished.has(ev.id)) continue;
    const due = dueAt(o.startedAt, ev.atMin, o.timeScale);
    const wait = due - o.now();
    if (wait > 0) {
      o.log(`waiting ${Math.round(wait / 1000)} s for ${ev.id}`);
      await o.sleep(wait);
    }
    o.log(`→ ${ev.id}`);
    await o.exec(ev, due);
    ran++;
  }
  return ran;
}
```

`scripts/loadtest/run.ts`

```ts
/**
 * On-chain load test driver — N wallets × 24 h against a running YieldSeeker.
 *
 *   set -a; source .env.loadtest; set +a
 *   caffeinate -dimsu npx tsx scripts/loadtest/run.ts --run loadtest-runs/<id> \
 *     [--wallets 97] [--scale 1] [--base-url http://localhost:3100] [--seed <int>]
 *
 * The first call initialises <id>/ (plan.json, wallets.json, run.json); calling
 * again with the same --run resumes it — the stored startedAt/scale/plan win
 * over flags. NEVER prints secrets: only public G…/C… ids and tx hashes.
 */
import { execSync } from "node:child_process";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { rpc } from "@stellar/stellar-sdk";
import { EXEC_USDC_CONTRACT_ID } from "../../src/lib/onboarding";
import { createApi } from "./api";
import { assetFromSacName, createChainOps, readContractString } from "./chain";
import { parseScale, runPlan } from "./driver";
import { finishedEventIds, openRunDir } from "./manifest";
import { buildPlan, type Plan } from "./schedule";
import { runEvent, type StepCtx } from "./steps";
import { assertSameWallets, deriveWallet } from "./wallets";

export interface RunMeta {
  runId: string;
  startedAt: number;
  timeScale: number;
  baseUrl: string;
  walletCount: number;
  planSeed: number;
  agentPublicKey: string;
  usdcSac: string;
  gitSha: string;
}

const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main() {
  const { values } = parseArgs({
    options: {
      run: { type: "string" },
      wallets: { type: "string", default: "97" },
      scale: { type: "string", default: "1" },
      "base-url": { type: "string", default: "http://localhost:3100" },
      seed: { type: "string" },
    },
  });
  if (!values.run) throw new Error("--run <dir> is required (e.g. loadtest-runs/full-20261006)");
  const seedHex = process.env.LOADTEST_SEED;
  if (!seedHex) throw new Error("LOADTEST_SEED is not set — source .env.loadtest first");

  const files = openRunDir(values.run);
  let meta = files.readJson<RunMeta>("run.json");
  const api = createApi(meta?.baseUrl ?? values["base-url"]!, { cronSecret: process.env.CRON_SECRET || undefined });
  const { agentPublicKey } = await api.agent();

  if (!meta) {
    const walletCount = Number(values.wallets);
    const planSeed = values.seed ? Number(values.seed) : parseInt(seedHex.slice(0, 8), 16);
    const plan = buildPlan({ walletCount, seed: planSeed });
    files.writeJson("plan.json", plan);
    files.writeJson("wallets.json", plan.wallets.map((w) => ({ ...w, owner: deriveWallet(seedHex, w.index).publicKey() })));
    meta = {
      runId: basename(values.run),
      startedAt: Date.now(),
      timeScale: parseScale(values.scale!),
      baseUrl: values["base-url"]!,
      walletCount,
      planSeed,
      agentPublicKey,
      usdcSac: process.env.EXEC_USDC_CONTRACT_ID ?? EXEC_USDC_CONTRACT_ID,
      gitSha: execSync("git rev-parse HEAD").toString().trim(),
    };
    files.writeJson("run.json", meta); // written last: its presence marks the run as initialised
    log(`initialised ${meta.runId}: ${walletCount} wallets, ${plan.events.length} events, scale ${meta.timeScale}, agent ${agentPublicKey}`);
  } else if (agentPublicKey !== meta.agentPublicKey) {
    throw new Error(`server agent ${agentPublicKey} ≠ this run's agent ${meta.agentPublicKey} — wrong server or env`);
  }

  const plan = files.readJson<Plan>("plan.json")!;
  assertSameWallets(files.readJson<Array<{ index: number; owner: string }>>("wallets.json")!, (i) => deriveWallet(seedHex, i).publicKey());

  const server = new rpc.Server(process.env.EXEC_RPC_URL ?? "https://soroban-testnet.stellar.org");
  const asset = assetFromSacName(await readContractString(server, meta.usdcSac, "name", meta.agentPublicKey));
  const ctx: StepCtx = {
    api,
    chain: createChainOps({ server, asset }),
    files,
    wallet: (i) => deriveWallet(seedHex, i),
    now: Date.now,
    sleep,
    log,
    retry: { attempts: 3, baseDelayMs: 5_000, outageWaitMs: 30_000, maxOutageWaits: 40 },
  };

  const ran = await runPlan({
    events: plan.events,
    startedAt: meta.startedAt,
    timeScale: meta.timeScale,
    finished: finishedEventIds(files.read()),
    now: Date.now,
    sleep,
    log,
    exec: async (ev, plannedAt) => {
      const r = await runEvent(ctx, ev, plannedAt);
      log(`  ${r.status} ${ev.id}${r.error ? ` — ${r.error}` : ""}`);
    },
  });
  log(`plan complete (${ran} event(s) this session). Next: npx tsx scripts/loadtest/export.ts --run ${values.run}`);
}

main().catch((e) => {
  console.error("FATAL:", (e as Error).message);
  process.exit(1);
});
```

- [ ] **Step 4: Run tests + CLI smoke**

Run: `npx vitest run tests/loadtest/driver.test.ts && npx tsx scripts/loadtest/run.ts; echo "exit=$?"`
Expected: PASS (5 tests); the CLI prints `FATAL: --run <dir> is required …` and `exit=1`.

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit 2>&1 | grep -c "error TS" || true`. Expected: equals the baseline.

```bash
git add scripts/loadtest/driver.ts scripts/loadtest/run.ts tests/loadtest/driver.test.ts
git commit -m "feat(loadtest): serial, resumable driver and run CLI"
```

---

### Task 8: Preflight

**Files:**
- Create: `scripts/loadtest/preflight-checks.ts`, `scripts/loadtest/preflight.ts`
- Test: `tests/loadtest/preflight.test.ts`

**Interfaces:**
- Consumes: `createApi` (Task 4), `loadHorizonAccount`, `xlmBalance`, `readContractString`, `TESTNET_PASSPHRASE` (Task 5); `deriveOwnerKeypair` (`src/lib/faucet.ts`), `getCollection` (`src/lib/mongo.ts`), `SMART_ACCOUNT_WASM_HASH` (`src/lib/smartAccount.ts`), `EXEC_POOL_ID`, `EXEC_USDC_CONTRACT_ID` (`src/lib/onboarding.ts`)
- Produces: `interface PreflightFacts`, `interface Check { name; ok; detail }`, `evaluatePreflight(f): Check[]`

- [ ] **Step 1: Write the failing test** — `tests/loadtest/preflight.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { evaluatePreflight, type PreflightFacts } from "../../scripts/loadtest/preflight-checks";

const good: PreflightFacts = {
  mongoDb: "yieldseeker_loadtest_20261006",
  mongoWritable: true,
  envAgent: "GAGENT",
  serverAgent: "GAGENT",
  agentXlm: 10_000,
  faucetAdmin: "GFAUCET",
  sacAdmin: "GFAUCET",
  faucetAdminXlm: 8_741,
  poolStatus: 0,
  smartAccountWasm: true,
  rpcRetentionLedgers: 120_960,
};

describe("evaluatePreflight", () => {
  it("passes a healthy setup", () => {
    expect(evaluatePreflight(good).filter((c) => !c.ok)).toEqual([]);
  });

  const cases: Array<[string, Partial<PreflightFacts>, string]> = [
    ["the production Mongo db", { mongoDb: "yieldseeker" }, "isolated Mongo db"],
    ["an unset Mongo db", { mongoDb: undefined }, "isolated Mongo db"],
    ["an unwritable Mongo db", { mongoWritable: "not authorized" }, "Mongo writable"],
    ["a server on another agent (prod?)", { serverAgent: "GPROD" }, "server runs the load-test agent"],
    ["a server that is down", { serverAgent: null }, "server runs the load-test agent"],
    ["a poor agent", { agentXlm: 50 }, "agent XLM ≥ 1000"],
    ["a faucet key that is not the SAC admin", { sacAdmin: "GOTHER" }, "faucet key is the USDC SAC admin"],
    ["a frozen pool", { poolStatus: 4 }, "exec pool accepts supply"],
    ["a missing smart-account wasm", { smartAccountWasm: false }, "smart-account wasm installed"],
    ["a short RPC history", { rpcRetentionLedgers: 17_280 }, "RPC keeps ≥ 2 days of history"],
  ];
  it.each(cases)("fails on %s", (_label, patch, name) => {
    expect(evaluatePreflight({ ...good, ...patch }).filter((c) => !c.ok).map((c) => c.name)).toEqual([name]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/loadtest/preflight.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** — `scripts/loadtest/preflight-checks.ts`

```ts
/** Pure preflight evaluation — preflight.ts gathers the facts, this decides. */
export interface PreflightFacts {
  mongoDb: string | undefined;
  /** true, or the error message of the insert+delete probe. */
  mongoWritable: true | string;
  /** G of AGENT_SIGNER_SECRET in this shell (.env.loadtest). */
  envAgent: string;
  /** agentPublicKey from the running server's /api/agent; null if unreachable. */
  serverAgent: string | null;
  agentXlm: number;
  faucetAdmin: string;
  sacAdmin: string;
  faucetAdminXlm: number;
  poolStatus: number;
  smartAccountWasm: boolean;
  rpcRetentionLedgers: number;
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export function evaluatePreflight(f: PreflightFacts): Check[] {
  return [
    {
      name: "isolated Mongo db",
      ok: !!f.mongoDb && f.mongoDb !== "yieldseeker",
      detail: `MONGODB_DB=${f.mongoDb ?? "(unset → production db 'yieldseeker')"}`,
    },
    { name: "Mongo writable", ok: f.mongoWritable === true, detail: f.mongoWritable === true ? "insert+delete ok" : f.mongoWritable },
    {
      name: "server runs the load-test agent",
      ok: f.serverAgent === f.envAgent,
      detail: `server=${f.serverAgent ?? "unreachable"} env=${f.envAgent}`,
    },
    { name: "agent XLM ≥ 1000", ok: f.agentXlm >= 1000, detail: `${f.agentXlm} XLM` },
    { name: "faucet key is the USDC SAC admin", ok: f.faucetAdmin === f.sacAdmin, detail: `faucet=${f.faucetAdmin} sac.admin=${f.sacAdmin}` },
    { name: "faucet admin XLM ≥ 200", ok: f.faucetAdminXlm >= 200, detail: `${f.faucetAdminXlm} XLM` },
    { name: "exec pool accepts supply", ok: f.poolStatus <= 3, detail: `status=${f.poolStatus} (0/1 active, 2/3 on ice, ≥4 frozen)` },
    { name: "smart-account wasm installed", ok: f.smartAccountWasm, detail: f.smartAccountWasm ? "found" : "missing — testnet reset?" },
    {
      name: "RPC keeps ≥ 2 days of history",
      ok: f.rpcRetentionLedgers >= 34_560,
      detail: `${f.rpcRetentionLedgers} ledgers ≈ ${((f.rpcRetentionLedgers * 5) / 86_400).toFixed(1)} days`,
    },
  ];
}
```

`scripts/loadtest/preflight.ts`

```ts
/**
 * Preflight for the on-chain load test. Run with .env.loadtest sourced and the
 * load-test server up:
 *
 *   set -a; source .env.loadtest; set +a
 *   npx tsx scripts/loadtest/preflight.ts [--base-url http://localhost:3100]
 *
 * Exit 1 if any check fails. Prints only public ids.
 */
import { parseArgs } from "node:util";
import { PoolV2 } from "@blend-capital/blend-sdk";
import { Keypair, rpc } from "@stellar/stellar-sdk";
import { deriveOwnerKeypair } from "../../src/lib/faucet";
import { getCollection, mongoDbName } from "../../src/lib/mongo";
import { EXEC_POOL_ID, EXEC_USDC_CONTRACT_ID } from "../../src/lib/onboarding";
import { SMART_ACCOUNT_WASM_HASH } from "../../src/lib/smartAccount";
import { createApi } from "./api";
import { loadHorizonAccount, readContractString, TESTNET_PASSPHRASE, xlmBalance } from "./chain";
import { evaluatePreflight, type PreflightFacts } from "./preflight-checks";

async function probeMongo(): Promise<true | string> {
  try {
    const coll = await getCollection("_preflight");
    const { insertedId } = await coll.insertOne({ at: Date.now() });
    await coll.deleteOne({ _id: insertedId });
    return true;
  } catch (e) {
    return (e as Error).message;
  }
}

async function main() {
  const { values } = parseArgs({ options: { "base-url": { type: "string", default: "http://localhost:3100" } } });
  const env = process.env;
  const rpcUrl = env.EXEC_RPC_URL ?? "https://soroban-testnet.stellar.org";
  const server = new rpc.Server(rpcUrl);
  if (!env.AGENT_SIGNER_SECRET) throw new Error("AGENT_SIGNER_SECRET is not set — source .env.loadtest first");
  const envAgent = Keypair.fromSecret(env.AGENT_SIGNER_SECRET).publicKey();
  const faucetAdmin = deriveOwnerKeypair().publicKey();
  const api = createApi(values["base-url"]!, { cronSecret: env.CRON_SECRET || undefined });

  const agentAcc = await loadHorizonAccount(envAgent);
  const adminAcc = await loadHorizonAccount(faucetAdmin);
  const pool = await PoolV2.load({ rpc: rpcUrl, passphrase: TESTNET_PASSPHRASE }, env.EXEC_POOL_ID ?? EXEC_POOL_ID);

  const facts: PreflightFacts = {
    // Read exactly as the server does, so "blank" counts as unset.
    mongoDb: mongoDbName() === "yieldseeker" ? undefined : mongoDbName(),
    mongoWritable: env.MONGODB_URI ? await probeMongo() : "MONGODB_URI is not set",
    envAgent,
    serverAgent: await api.agent().then((a) => a.agentPublicKey, () => null),
    agentXlm: agentAcc ? xlmBalance(agentAcc) : 0,
    faucetAdmin,
    sacAdmin: await readContractString(server, env.EXEC_USDC_CONTRACT_ID ?? EXEC_USDC_CONTRACT_ID, "admin", faucetAdmin).catch(
      (e: Error) => `error: ${e.message}`,
    ),
    faucetAdminXlm: adminAcc ? xlmBalance(adminAcc) : 0,
    poolStatus: pool.metadata.status,
    smartAccountWasm: await server.getContractWasmByHash(Buffer.from(SMART_ACCOUNT_WASM_HASH, "hex")).then(() => true, () => false),
    rpcRetentionLedgers: (await server.getHealth()).ledgerRetentionWindow,
  };

  const checks = evaluatePreflight(facts);
  for (const c of checks) console.log(`${c.ok ? "✅" : "❌"} ${c.name} — ${c.detail}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n${failed} check(s) failed — do not start the run.` : "\nall checks passed");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", (e as Error).message);
  process.exit(1);
});
```

- [ ] **Step 4: Run the tests + typecheck**

Run: `npx vitest run tests/loadtest/preflight.test.ts && npx tsc --noEmit 2>&1 | grep -c "error TS" || true`
Expected: PASS (11 tests), tsc count = baseline. If tsc reports `metadata.status` or `ledgerRetentionWindow` missing, read `node_modules/@blend-capital/blend-sdk/dist/**/pool*.d.ts` / `node_modules/@stellar/stellar-sdk/lib/rpc/api.d.ts`, use the real field name, and note it in the commit body.

- [ ] **Step 5: Commit**

```bash
git add scripts/loadtest/preflight-checks.ts scripts/loadtest/preflight.ts tests/loadtest/preflight.test.ts
git commit -m "feat(loadtest): preflight guards against prod db/agent and a broken testnet"
```

---

### Task 9: Export + summary

**Files:**
- Create: `scripts/loadtest/report.ts`, `scripts/loadtest/export.ts`
- Test: `tests/loadtest/report.test.ts`

**Interfaces:**
- Consumes: `ManifestRecord`, `RunFiles`, `walletStates`, `EventStatus` (Task 3); `Plan`, `Cohort`, `COHORT_ORDER` (Task 2); `FetchLike`, `HORIZON_URL`, `simulateCall`, `TESTNET_PASSPHRASE` (Task 5); `RunMeta` (Task 7, type-only); `createDb` (`src/lib/db.ts`), `registry` (`src/lib/registry.ts`), `readSpendingLimitData` (`src/lib/smartAccount.ts`)
- Produces (report.ts): `collectHashes(recs): string[]`, `type HorizonTx = { hash: string; created_at: string } & Record<string, unknown>`, `horizonAccountTxs(address, sinceIso, fetchFn?): Promise<HorizonTx[]>`, `type PostJson`, `rpcGetTransaction(rpcUrl, hash, post?): Promise<Record<string, unknown>>`, `interface ActivityEntry { ts; kind; message; meta: Record<string, unknown> | null }`, `parseActivity(rows: Array<{ ts; kind; message; meta: string | null }>): ActivityEntry[]`, `interface CohortSummary`, `interface Summary`, `summarize(plan, recs, activity: ActivityEntry[] | null): Summary`

- [ ] **Step 1: Write the failing test** — `tests/loadtest/report.test.ts`

```ts
import { describe, expect, it } from "vitest";
import type { FetchLike } from "../../scripts/loadtest/chain";
import type { EventRecord, ManifestRecord, StepRecord } from "../../scripts/loadtest/manifest";
import { collectHashes, horizonAccountTxs, parseActivity, rpcGetTransaction, summarize } from "../../scripts/loadtest/report";
import type { Plan } from "../../scripts/loadtest/schedule";

const ev = (p: Partial<EventRecord> & Pick<EventRecord, "eventId" | "kind" | "status">): EventRecord => ({
  type: "event", plannedAt: 0, startedAt: 0, finishedAt: 0, hashes: [], ...p,
});
const st = (p: Partial<StepRecord> & Pick<StepRecord, "eventId" | "step">): StepRecord => ({ type: "step", at: 0, hashes: [], ...p });

describe("collectHashes", () => {
  it("dedupes step + event hashes in first-seen order", () => {
    const recs: ManifestRecord[] = [
      st({ eventId: "onboard:w00", step: "deploy", hashes: ["a"] }),
      ev({ eventId: "onboard:w00", kind: "onboard", status: "ok", hashes: ["a", "b"] }),
    ];
    expect(collectHashes(recs)).toEqual(["a", "b"]);
  });
});

describe("horizonAccountTxs", () => {
  it("follows next links until an empty page and keeps only the run window", async () => {
    const first = "https://horizon-testnet.stellar.org/accounts/GA/transactions?order=asc&limit=200";
    const pages: Record<string, unknown> = {
      [first]: {
        _embedded: { records: [{ hash: "old", created_at: "2026-10-05T00:00:00Z" }, { hash: "a", created_at: "2026-10-06T10:00:00Z" }] },
        _links: { next: { href: "p2" } },
      },
      p2: { _embedded: { records: [{ hash: "b", created_at: "2026-10-06T11:00:00Z" }] }, _links: { next: { href: "p3" } } },
      p3: { _embedded: { records: [] }, _links: { next: { href: "p4" } } },
    };
    const fetchFn: FetchLike = async (url) => ({ status: 200, json: async () => pages[url] });
    expect((await horizonAccountTxs("GA", "2026-10-06T09:00:00Z", fetchFn)).map((t) => t.hash)).toEqual(["a", "b"]);
  });
  it("returns [] for an account Horizon does not know", async () => {
    const fetchFn: FetchLike = async () => ({ status: 404, json: async () => ({}) });
    expect(await horizonAccountTxs("GX", "2026-10-06T09:00:00Z", fetchFn)).toEqual([]);
  });
});

describe("rpcGetTransaction", () => {
  it("keeps the raw result and tags it with the hash", async () => {
    const post = async () => ({ result: { status: "SUCCESS", envelopeXdr: "E", resultMetaXdr: "M", ledger: 7 } });
    expect(await rpcGetTransaction("http://rpc", "h1", post)).toEqual({ hash: "h1", status: "SUCCESS", envelopeXdr: "E", resultMetaXdr: "M", ledger: 7 });
  });
  it("records an RPC error instead of throwing", async () => {
    const post = async () => ({ error: { message: "boom" } });
    expect(await rpcGetTransaction("http://rpc", "h1", post)).toEqual({ hash: "h1", status: "RPC_ERROR", error: "boom" });
  });
});

describe("summarize", () => {
  const plan: Plan = { seed: 1, wallets: [{ index: 0, cohort: "whale" }, { index: 1, cohort: "dust" }], events: [] };
  const recs: ManifestRecord[] = [
    st({ eventId: "onboard:w00", wallet: 0, step: "fund", data: { usdc: 5000 } }),
    ev({ eventId: "onboard:w00", kind: "onboard", wallet: 0, status: "ok", data: { smartWallet: "CSA0" } }),
    ev({ eventId: "onboard:w01", kind: "onboard", wallet: 1, status: "failed", plannedAt: 100, startedAt: 2_100 }),
    st({ eventId: "topup:w00:1", wallet: 0, step: "mint-sa", data: { usdc: 3000 } }),
    ev({ eventId: "topup:w00:1", kind: "topup", wallet: 0, status: "ok" }),
    ev({ eventId: "tick:0010", kind: "tick", status: "ok", data: { durationMs: 1000 } }),
    ev({ eventId: "tick:0030", kind: "tick", status: "ok", data: { durationMs: 3000 } }),
    ev({ eventId: "tick:0050", kind: "tick", status: "failed" }),
  ];
  const activity = parseActivity([
    { ts: 1, kind: "peruser", message: "supplied", meta: JSON.stringify({ smartWallet: "CSA0", hashes: ["s1"], amount: "20000000000" }) },
    { ts: 2, kind: "peruser", message: "supplied", meta: JSON.stringify({ smartWallet: "CSA0", hashes: ["s2"], amount: "20000000000" }) },
    { ts: 3, kind: "error", message: "per-user supply failed for GAAA…: simulate failed", meta: JSON.stringify({ smartWallet: "CSA0", hashes: [] }) },
    { ts: 4, kind: "error", message: "tick failed: boom", meta: null },
    { ts: 5, kind: "peruser", message: "skip GAAA… — no idle USDC", meta: JSON.stringify({ smartWallet: "CSA0" }) },
  ]);

  it("counts per cohort from events + the server's activity log", () => {
    const s = summarize(plan, recs, activity);
    expect(s.cohorts.whale).toEqual({ wallets: 1, onboarded: 1, onboardFailed: 0, mintedUsdc: 8000, supplies: 2, suppliedUsdc: 4000, supplyErrors: 1 });
    expect(s.cohorts.dust).toMatchObject({ wallets: 1, onboarded: 0, onboardFailed: 1 });
    expect(s.ticks).toEqual({ ok: 2, failed: 1, avgDurationMs: 2000, maxDurationMs: 3000, serverTickFailures: 1 });
    expect(s.events).toEqual({ ok: 4, failed: 2, skipped: 0 });
    expect(s.maxLagMs).toBe(2000);
    expect(s.activityIncluded).toBe(true);
  });
  it("works without the activity log (--local-only)", () => {
    const s = summarize(plan, recs, null);
    expect(s.activityIncluded).toBe(false);
    expect(s.cohorts.whale.supplies).toBe(0);
    expect(s.cohorts.whale.mintedUsdc).toBe(8000);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/loadtest/report.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** — `scripts/loadtest/report.ts`

```ts
/** Pure(ish) export helpers — network access is injectable for tests. */
import { HORIZON_URL, type FetchLike } from "./chain";
import type { EventStatus, ManifestRecord } from "./manifest";
import { COHORT_ORDER, type Cohort, type Plan } from "./schedule";

export function collectHashes(recs: ManifestRecord[]): string[] {
  return [...new Set(recs.flatMap((r) => r.hashes))];
}

export type HorizonTx = { hash: string; created_at: string } & Record<string, unknown>;

/** Every tx of `address` since `sinceIso`, oldest first, following Horizon's next links. */
export async function horizonAccountTxs(address: string, sinceIso: string, fetchFn: FetchLike = fetch): Promise<HorizonTx[]> {
  const out: HorizonTx[] = [];
  let url = `${HORIZON_URL}/accounts/${address}/transactions?order=asc&limit=200`;
  for (;;) {
    const res = await fetchFn(url);
    if (res.status === 404) return out;
    if (res.status !== 200) throw new Error(`horizon ${url} → HTTP ${res.status}`);
    const body = (await res.json()) as { _embedded: { records: HorizonTx[] }; _links: { next: { href: string } } };
    const page = body._embedded.records;
    if (!page.length) return out;
    out.push(...page.filter((t) => t.created_at >= sinceIso));
    url = body._links.next.href;
  }
}

export type PostJson = (url: string, body: unknown) => Promise<unknown>;

const postJson: PostJson = async (url, body) =>
  (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();

/** Raw getTransaction (envelope/result/meta XDR) — only RPC still serves Soroban meta. */
export async function rpcGetTransaction(rpcUrl: string, hash: string, post: PostJson = postJson): Promise<Record<string, unknown>> {
  const res = (await post(rpcUrl, { jsonrpc: "2.0", id: 1, method: "getTransaction", params: { hash } })) as {
    result?: Record<string, unknown>;
    error?: { message: string };
  };
  if (res.error) return { hash, status: "RPC_ERROR", error: res.error.message };
  return { hash, ...res.result };
}

export interface ActivityEntry {
  ts: number;
  kind: string;
  message: string;
  meta: Record<string, unknown> | null;
}

export function parseActivity(rows: Array<{ ts: number; kind: string; message: string; meta: string | null }>): ActivityEntry[] {
  return rows.map((r) => {
    let meta: Record<string, unknown> | null = null;
    try {
      meta = r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : null;
    } catch {
      meta = null;
    }
    return { ts: r.ts, kind: r.kind, message: r.message, meta };
  });
}

export interface CohortSummary {
  wallets: number;
  onboarded: number;
  onboardFailed: number;
  mintedUsdc: number;
  supplies: number;
  suppliedUsdc: number;
  supplyErrors: number;
}

export interface Summary {
  activityIncluded: boolean;
  events: Record<EventStatus, number>;
  /** Worst startedAt − plannedAt: how far the serial driver fell behind the plan. */
  maxLagMs: number;
  cohorts: Record<Cohort, CohortSummary>;
  ticks: { ok: number; failed: number; avgDurationMs: number; maxDurationMs: number; serverTickFailures: number };
}

const MINT_STEPS = new Set(["fund", "mint-sa", "mint-g"]);

export function summarize(plan: Plan, recs: ManifestRecord[], activity: ActivityEntry[] | null): Summary {
  const cohortOf = new Map(plan.wallets.map((w) => [w.index, w.cohort]));
  const cohorts = Object.fromEntries(
    COHORT_ORDER.map((c) => [c, { wallets: 0, onboarded: 0, onboardFailed: 0, mintedUsdc: 0, supplies: 0, suppliedUsdc: 0, supplyErrors: 0 }]),
  ) as Record<Cohort, CohortSummary>;
  for (const w of plan.wallets) cohorts[w.cohort].wallets++;

  const events: Record<EventStatus, number> = { ok: 0, failed: 0, skipped: 0 };
  const walletBySa = new Map<string, number>();
  const tickDurations: number[] = [];
  let tickFailed = 0;
  let maxLagMs = 0;

  for (const r of recs) {
    if (r.type === "step") {
      if (r.wallet !== undefined && MINT_STEPS.has(r.step)) cohorts[cohortOf.get(r.wallet)!].mintedUsdc += Number(r.data?.usdc ?? 0);
      continue;
    }
    events[r.status]++;
    maxLagMs = Math.max(maxLagMs, r.startedAt - r.plannedAt);
    if (r.kind === "tick") {
      if (r.status === "ok") tickDurations.push(Number(r.data?.durationMs ?? 0));
      else tickFailed++;
    }
    if (r.kind === "onboard" && r.wallet !== undefined) {
      const c = cohorts[cohortOf.get(r.wallet)!];
      if (r.status === "ok") {
        c.onboarded++;
        walletBySa.set(String(r.data?.smartWallet), r.wallet);
      } else c.onboardFailed++;
    }
  }

  let serverTickFailures = 0;
  for (const a of activity ?? []) {
    if (a.kind === "error" && a.message.startsWith("tick failed")) {
      serverTickFailures++;
      continue;
    }
    const sa = typeof a.meta?.smartWallet === "string" ? a.meta.smartWallet : undefined;
    const idx = sa ? walletBySa.get(sa) : undefined;
    if (idx === undefined) continue;
    const c = cohorts[cohortOf.get(idx)!];
    if (a.kind === "peruser" && typeof a.meta?.amount === "string") {
      c.supplies++;
      c.suppliedUsdc += Number(BigInt(a.meta.amount) / 10_000n) / 1000; // stroops → USDC, 3 decimals
    }
    if (a.kind === "error") c.supplyErrors++;
  }

  const total = tickDurations.reduce((s, d) => s + d, 0);
  return {
    activityIncluded: activity !== null,
    events,
    maxLagMs,
    cohorts,
    ticks: {
      ok: tickDurations.length,
      failed: tickFailed,
      avgDurationMs: tickDurations.length ? Math.round(total / tickDurations.length) : 0,
      maxDurationMs: tickDurations.length ? Math.max(...tickDurations) : 0,
      serverTickFailures,
    },
  };
}
```

`scripts/loadtest/export.ts`

```ts
/**
 * Archive a load-test run for later on-chain analysis.
 *
 *   set -a; source .env.loadtest; set +a
 *   npx tsx scripts/loadtest/export.ts --run loadtest-runs/<id> [--local-only]
 *
 * --local-only prints the summary from events.jsonl alone (no network) — use it
 * to watch a run in progress. The full export must run inside the RPC history
 * window (~7 days on SDF testnet) and before the next testnet reset
 * (2026-12-16), or the raw XDR is gone for good.
 */
import { parseArgs } from "node:util";
import { PoolV2 } from "@blend-capital/blend-sdk";
import { Address, nativeToScVal, rpc } from "@stellar/stellar-sdk";
import { createDb } from "../../src/lib/db";
import { EXEC_POOL_ID, SPENDING_POLICY_ID } from "../../src/lib/onboarding";
import * as registry from "../../src/lib/registry";
import { readSpendingLimitData } from "../../src/lib/smartAccount";
import { simulateCall, TESTNET_PASSPHRASE } from "./chain";
import { openRunDir, walletStates } from "./manifest";
import { collectHashes, horizonAccountTxs, parseActivity, rpcGetTransaction, summarize } from "./report";
import type { RunMeta } from "./run";
import type { Plan } from "./schedule";

/** JSON can't carry BigInt (same rule as src/lib/serialize.ts): stringify at the edge. */
const plain = <T>(v: T): unknown => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));

async function main() {
  const { values } = parseArgs({ options: { run: { type: "string" }, "local-only": { type: "boolean", default: false } } });
  if (!values.run) throw new Error("--run <dir> is required");
  const files = openRunDir(values.run);
  const meta = files.readJson<RunMeta>("run.json");
  const plan = files.readJson<Plan>("plan.json");
  if (!meta || !plan) throw new Error(`${values.run} is not an initialised run dir`);
  const recs = files.read();

  if (values["local-only"]) return print(summarize(plan, recs, null));

  const rpcUrl = process.env.EXEC_RPC_URL ?? "https://soroban-testnet.stellar.org";
  const server = new rpc.Server(rpcUrl);
  const sinceIso = new Date(meta.startedAt - 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const owners = files.readJson<Array<{ index: number; owner: string }>>("wallets.json")!;

  // 1. Horizon: all txs of the dedicated agent (authorize + every supply, including
  //    the ones only the server saw) and of every wallet G.
  const horizon = new Map<string, Record<string, unknown>>();
  const add = (source: string, txs: Array<{ hash: string }>) => {
    for (const t of txs) if (!horizon.has(t.hash)) horizon.set(t.hash, { _source: source, ...t });
  };
  add("agent", await horizonAccountTxs(meta.agentPublicKey, sinceIso));
  for (const w of owners) add(`wallet:${w.index}`, await horizonAccountTxs(w.owner, sinceIso));
  files.writeJsonl("chain/horizon-transactions.jsonl", [...horizon.values()]);
  console.log(`horizon: ${horizon.size} txs`);

  // 2. RPC: raw XDR for every hash we know (driver-recorded ∪ Horizon), 4 at a time.
  const hashes = [...new Set([...collectHashes(recs), ...horizon.keys()])];
  const raw: Array<Record<string, unknown>> = [];
  for (let i = 0; i < hashes.length; i += 4) {
    raw.push(...(await Promise.all(hashes.slice(i, i + 4).map((h) => rpcGetTransaction(rpcUrl, h)))));
  }
  files.writeJsonl("chain/rpc-transactions.jsonl", raw);
  const rpcNotFound = raw.filter((r) => r.status === "NOT_FOUND").length;
  console.log(`rpc: ${raw.length} txs (${rpcNotFound} NOT_FOUND)`);

  // 3. Final per-wallet state.
  const pool = await PoolV2.load({ rpc: rpcUrl, passphrase: TESTNET_PASSPHRASE }, process.env.EXEC_POOL_ID ?? EXEC_POOL_ID);
  const reserve = pool.reserves.get(meta.usdcSac);
  const finalState: unknown[] = [];
  for (const [index, s] of walletStates(recs)) {
    const err = (e: Error) => `error: ${e.message}`;
    const usdcBalance = await simulateCall(
      server, meta.usdcSac, "balance", [nativeToScVal(Address.fromString(s.smartWallet), { type: "address" })], meta.agentPublicKey,
    ).catch(err);
    const blendCollateral = await pool
      .loadUser(s.smartWallet)
      .then((u) => (reserve ? u.getCollateral(reserve) : null))
      .catch(err);
    const spending = await readSpendingLimitData({
      server,
      spendingPolicy: process.env.SPENDING_POLICY_ID ?? SPENDING_POLICY_ID,
      smartWallet: s.smartWallet,
      ruleId: s.usdcRuleId,
      networkPassphrase: TESTNET_PASSPHRASE,
      readerSource: meta.agentPublicKey,
    }).catch(err);
    finalState.push({ index, ...s, usdcBalance, blendCollateral, spending });
  }
  files.writeJson("state/final-wallets.json", plain(finalState));

  // 4. Off-chain: the server's activity log (supply hashes, skip reasons, tick
  //    failures) and registry — same MONGODB_DB the server used.
  const rows = (await createDb().recentLog(1_000_000)).filter((r) => r.ts >= meta.startedAt / 1000 - 3600).reverse();
  files.writeJsonl("offchain/activity.jsonl", rows);
  const users = await registry.listUsers();
  files.writeJson(
    "offchain/users.json",
    plain(await Promise.all(users.map(async (u) => ({ ...u, position: await registry.getUserPosition(u.smartWallet) })))),
  );

  const summary = { ...summarize(plan, recs, parseActivity(rows)), chain: { horizonTxs: horizon.size, rpcTxs: raw.length, rpcNotFound } };
  files.writeJson("summary.json", summary);
  print(summary);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("FATAL:", (e as Error).message);
    process.exit(1);
  },
);
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run tests/loadtest/report.test.ts && npx tsc --noEmit 2>&1 | grep -c "error TS" || true`
Expected: PASS (7 tests), tsc count = baseline. If tsc flags `pool.loadUser` / `getCollateral`, read the `PoolUser` (or `User`) declarations under `node_modules/@blend-capital/blend-sdk/dist/` and use the method that returns the collateral position in underlying token units (`bigint`) for a reserve. Keep the `.catch(err)` wrapper.

- [ ] **Step 5: Commit**

```bash
git add scripts/loadtest/report.ts scripts/loadtest/export.ts tests/loadtest/report.test.ts
git commit -m "feat(loadtest): export run archive (Horizon, RPC XDR, final state, activity) + summary"
```

---

### Task 10: Runbook + CLAUDE.md

**Files:**
- Create: `scripts/loadtest/README.md`
- Modify: `CLAUDE.md` (Commands block)

- [ ] **Step 1: Write the runbook** — `scripts/loadtest/README.md`

````markdown
# On-chain load test (97 wallets × 24 h)

Plan + rationale: `docs/superpowers/plans/2026-10-05-onchain-loadtest-97-wallets.md`.

## One-time env (`.env.loadtest`, gitignored)

```bash
vercel link                                           # the yieldseeker project
vercel env pull .env.prod.local --environment=production
stellar keys generate ys-loadtest-agent --network testnet --fund
{
  cat .env.prod.local
  echo "AGENT_SIGNER_SECRET=$(stellar keys show ys-loadtest-agent)"
  echo "LOADTEST_SEED=$(openssl rand -hex 32)"
  echo "MONGODB_DB=yieldseeker_loadtest_$(date +%Y%m%d)"
  echo "AGENT_LOOP_ENABLED=0"
  echo "CRON_SECRET="
} > .env.loadtest
```
Later lines win when sourced. If `vercel env pull` returns empty sensitive values, fill
`STELLAR_WALLET_MNEMONIC`, `MONGODB_URI` and `ANTHROPIC_API_KEY` by hand.

## Server (tmux window 1)

```bash
npm run build
set -a; source .env.loadtest; set +a
npx next start -p 3100 2>&1 | tee -a loadtest-runs/server.log
```

## Preflight → smoke → full run → export (tmux window 2)

```bash
set -a; source .env.loadtest; set +a
npx tsx scripts/loadtest/preflight.ts                                   # all ✅
npx tsx scripts/loadtest/run.ts --run loadtest-runs/full-$(date +%Y%m%d) --wallets 97   # under caffeinate -dimsu
npx tsx scripts/loadtest/export.ts --run loadtest-runs/full-YYYYMMDD --local-only      # progress, no network
npx tsx scripts/loadtest/export.ts --run loadtest-runs/full-YYYYMMDD                   # after T+24h, within 7 days
```
Resume after any crash: rerun the exact `run.ts` command (same `--run`).
````

- [ ] **Step 2: CLAUDE.md** — in the Commands code block, after the `npx tsc --noEmit` line, add:

```bash
# 24h on-chain load test (testnet; see scripts/loadtest/README.md):
npx tsx scripts/loadtest/preflight.ts                      # guards: isolated MONGODB_DB, load-test agent, pool, wasm
npx tsx scripts/loadtest/run.ts --run loadtest-runs/<id>   # resumable serial driver
npx tsx scripts/loadtest/export.ts --run loadtest-runs/<id> [--local-only]
```

- [ ] **Step 3: Full verification**

Run: `npm test 2>&1 | tail -5 && npx tsc --noEmit 2>&1 | grep -c "error TS" || true`
Expected: all suites pass (the old ones + 8 new files); tsc count = baseline.

- [ ] **Step 4: Commit**

```bash
git add scripts/loadtest/README.md CLAUDE.md
git commit -m "docs: on-chain load test runbook"
```

---

## Run Phase (operational — on the operator's Mac)

### R1: Environment + keys (T−60 m)

- [ ] Create `.env.loadtest` exactly as in `scripts/loadtest/README.md` → "One-time env".
- [ ] `grep -c . .env.loadtest` > 20, and `grep -E '^(MONGODB_DB|AGENT_LOOP_ENABLED)=' .env.loadtest` shows the load-test values. **Do not print the file.**
- [ ] `mkdir -p loadtest-runs`

### R2: Server (T−55 m)

- [ ] `npm run build` → succeeds.
- [ ] tmux window 1, smoke db: `set -a; source .env.loadtest; set +a; MONGODB_DB=yieldseeker_loadtest_smoke npx next start -p 3100 2>&1 | tee -a loadtest-runs/server-smoke.log`
- [ ] `curl -s localhost:3100/api/agent` → `agentPublicKey` = `stellar keys address ys-loadtest-agent`.

### R3: Preflight (T−45 m)

- [ ] tmux window 2: `set -a; source .env.loadtest; set +a; export MONGODB_DB=yieldseeker_loadtest_smoke LOADTEST_SEED=$(openssl rand -hex 32); npx tsx scripts/loadtest/preflight.ts` (smoke gets its own wallets so they never mix with the full run's)
Expected: 10 × ✅ (incl. "server writes to this db"), `all checks passed`. Any ❌ → fix before going on.

### R4: Smoke run (T−40 m → T−15 m)

- [ ] Same shell: `SMOKE=loadtest-runs/smoke-$(date +%Y%m%d-%H%M); caffeinate -dimsu npx tsx scripts/loadtest/run.ts --run $SMOKE --new --wallets 5 --scale 1/96`
Expected: ~15–25 min (the plan is 15 min; serial ticks add lag), ending with `plan complete`.
- [ ] `npx tsx scripts/loadtest/export.ts --run $SMOKE`
Expected in `summary.json`: 5/5 onboarded. `steady`, `drip`, `dust` each with ≥ 1 supply. `whale` with 3 supplies, 5000 USDC supplied and `supplyErrors` ≥ 1 after its top-up. `churn` with exactly 1 supply. `rpcNotFound = 0`.
- [ ] Spot-check one supply hash from `offchain/activity.jsonl` on `https://stellar.expert/explorer/testnet/tx/<hash>`.
- [ ] Stop the server (Ctrl-C in window 1) and restart it **without** the inline override, so it uses the dated full-run db: `set -a; source .env.loadtest; set +a; npx next start -p 3100 2>&1 | tee -a loadtest-runs/server-full.log`
- [ ] In a **fresh** shell (drops the smoke `MONGODB_DB`/`LOADTEST_SEED`): `set -a; source .env.loadtest; set +a; npx tsx scripts/loadtest/preflight.ts` → all ✅ and `MONGODB_DB=yieldseeker_loadtest_<yyyymmdd>`.

### R5: Full run (T0 → T+24 h)

- [ ] Laptop on power, lid open, Wi-Fi stable. In tmux window 2 (same fresh shell), record the path once — `$(date)` changes at midnight:
`echo loadtest-runs/full-$(date +%Y%m%d) > loadtest-runs/CURRENT; RUN=$(cat loadtest-runs/CURRENT); caffeinate -dimsu npx tsx scripts/loadtest/run.ts --run $RUN --new --wallets 97 2>&1 | tee -a $RUN.log`
- [ ] T+1 h: `npx tsx scripts/loadtest/export.ts --run $RUN --local-only` → ≥ 24 onboarded, `failed` ≈ 0.
- [ ] T+6 h and T+12 h: same command; `maxLagMs` < 30 min; tick failures explained by the server log.
- [ ] If the driver dies: `RUN=$(cat loadtest-runs/CURRENT); caffeinate -dimsu npx tsx scripts/loadtest/run.ts --run $RUN 2>&1 | tee -a $RUN.log` — **without** `--new` (it resumes; a 2nd copy is refused by `driver.lock`). If the server dies: restart it as in R4's last step and re-run preflight; the driver waits as long as the connection is refused.
- [ ] T+24 h: driver prints `plan complete`.

### R6: Export + archive (T+24 h → T+25 h)

- [ ] `npx tsx scripts/loadtest/export.ts --run $(cat loadtest-runs/CURRENT)` (refuses unless the shell's `MONGODB_DB` is the run's) → `summary.json`, `chain/`, `state/`, `offchain/` written; `rpcNotFound = 0`.
- [ ] Compare against "Expected observations" (Design). Note deviations as findings; do not "fix" them during the run.
- [ ] `RUN=$(cat loadtest-runs/CURRENT); tar czf ~/yieldseeker-loadtest-$(basename $RUN).tgz -C loadtest-runs $(basename $RUN)` and store the tarball outside the repo. Do this before the 7-day RPC window closes and before the 2026-12-16 testnet reset.
- [ ] Stop the server; `stellar keys address ys-loadtest-agent` stays in `.env.loadtest` for the analysis.
