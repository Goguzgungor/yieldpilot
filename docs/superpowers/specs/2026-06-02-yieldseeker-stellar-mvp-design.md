# YieldSeeker · Stellar — MVP Design Spec

- **Date:** 2026-06-02
- **Status:** Design approved; the next step is the implementation plan (writing-plans)
- **Context source:** `yieldseeker-stellar-feasibility-report.md` (feasibility + architecture research)

---

## 1. Purpose & Summary

An autonomous DeFi yield-optimization AI agent on Stellar (Soroban) for idle USDC. The agent periodically scans the USDC yields of Blend Capital testnet pools, picks the best risk-adjusted yield with an LLM (Claude), and moves the user's funds to the better pool **with real Soroban testnet transactions**.

**One-sentence UX:** The user sets up once (deposits USDC into a smart wallet + authorizes the agent with a passkey); the agent handles the rest autonomously.

> **Design update (2026-06-02 — during implementation):** Scanning/listing reads **real Blend MAINNET pools** (many pools, real ~4-8% USDC yield); execution (deposit) happens on **TESTNET** (real tx, no real money). Reason: testnet has a single pool at ~0.05% APR → pure testnet data does not look realistic in a demo. The chosen mainnet pool is mapped to the single testnet exec pool at deposit time. Config is split into `SCAN_*` (mainnet) and `EXEC_*` (testnet).

This spec covers the **agent backend (the system)**. The web dashboard (frontend) is a separate later phase and consumes this backend's API.

## 2. Goals / Non-Goals

**Goals (MVP):**
- Real Soroban **testnet** execution: real USDC deposit/withdraw into Blend pools, real tx hashes.
- A real LLM agent: decision + natural-language rationale through Claude tool-use.
- One-time user setup → autonomous rebalancing without approvals afterwards.
- Policy-signer smart wallet: the agent can only take permitted actions (it cannot drain funds).
- An API + activity log for the frontend to consume.

**NOT goals (in the MVP):**
- Mainnet / real money.
- Atomic (single-tx) rebalance (2 consecutive txs are accepted because of the 1-op-per-tx limit).
- Production-grade audit, a custom Soroban orchestrator/vault contract (SEP-56) — marked as "production upgrade".
- Many protocols; the MVP is limited to Blend pools (+DeFindex if needed).
- Web frontend (separate phase).

## 3. Architecture (Approach A: off-chain LLM agent + Blend SDK)

A single TypeScript/Node package. Off-chain agent backend; it connects to Soroban directly through the SDKs (no custom contract).

```
┌─────────────────────────── orchestrator (loop) ───────────────────────────┐
│  tick (~30s or on-demand):                                                 │
│    scanner.scan() → risk.score(tolerance) → agent.decide()                 │
│       → (if rebalance) executor.rebalance() → state + log + API feed       │
└────────────────────────────────────────────────────────────────────────────┘
        │            │              │                    │
     scanner        risk          agent (Claude)       executor → wallet
   (Blend SDK,    (deterministic) (tool-use)          (stellar-sdk,
    Soroban RPC)                                        blend-sdk, passkey-kit)
```

## 4. Components (single responsibility + clear interface)

| Module | Responsibility | Interface (draft) | Dependency |
|-------|------------|------------------|------------|
| `scanner` | Fetch the USDC supply APY + state of Blend testnet pools, normalize | `scan(): Promise<PoolYield[]>` | `@blend-capital/blend-sdk-js`, Soroban RPC, (opt. DefiLlama API) |
| `risk` | Assign each pool a risk score (TVL, utilization, oracle-health flag), filter by tolerance | `score(pools: PoolYield[], tolerance: RiskTolerance): ScoredPool[]` | pure TS |
| `agent` | Claude tool-use loop: scored pool + position + tolerance → decision + rationale | `decide(ctx: DecisionContext): Promise<Decision>` | `@anthropic-ai/sdk` |
| `executor` | Build/simulate/sign/submit the Blend withdraw→deposit tx; return the tx hash | `rebalance(from: PoolId, to: PoolId, amount: bigint): Promise<TxResult>` | `@stellar/stellar-sdk`, blend-sdk, `wallet` |
| `wallet` | Restricted autonomous signing with a smart wallet (contract account) + agent policy signer | `sign(tx)`, `address()`, `setupPolicy(...)` | `passkey-kit` |
| `orchestrator` | Loop + state + activity log persistence + guards | `tick()`, `start()`, `stop()` | the above + `better-sqlite3` |
| `api` | Expose position/scan/decision/log (for the frontend) | REST + `/events` (SSE) | orchestrator state |

**Agent tools (given to Claude, zod-validated):** `scan_yields()`, `get_position()`, `rebalance(fromPool, toPool, amount)`.

**Type drafts:**
- `PoolYield { poolId, asset:"USDC", apyBase, apyReward?, tvl, utilization }`
- `RiskTolerance = "conservative" | "balanced" | "aggressive"`
- `ScoredPool extends PoolYield { riskScore:number, eligible:boolean, reason?:string }`
- `Decision { action:"hold"|"rebalance", toPool?:PoolId, amount?:bigint, rationale:string }`
- `TxResult { hashes:string[], success:boolean, error?:string }`

## 5. Data Flow

1. `orchestrator.tick()` fires (timer ~30s or API on-demand).
2. `scanner.scan()` → the current USDC yield of all candidate Blend pools.
3. `risk.score(pools, tolerance)` → risk score + an eligibility filter by tolerance (e.g. an oracle-risky/low-TVL pool is excluded).
4. `agent.decide()` → Claude picks the best move from the scored pools + current position + tolerance; returns `hold` or `rebalance` + a rationale.
5. If the decision is `rebalance`, `executor.rebalance(from,to,amount)`: withdraw(from) tx → deposit(to) tx (simulate → sign(policy signer) → submit). Real tx hashes.
6. `orchestrator` updates the state and the activity log and pushes them to the `api` feed.

## 6. Wallet & Authorization Model (the system's security core)

**One-time user setup:**
1. The user creates a **smart wallet** (Soroban contract account, `passkey-kit`) with a passkey.
2. Deposits USDC (testnet) into the smart wallet.
3. Authorizes a **policy signer** for the agent: only **`submit` (deposit/withdraw) to registered Blend pool contracts** + per-tx & daily USDC cap. (A single passkey approval.)
4. Chooses the **risk tolerance** (`conservative` / `balanced` / `aggressive`). It is stored in state; `risk.score` and `agent.decide` consume this value. (It can be changed after setup if wanted, but "set once" is enough for the flow.)

**Afterwards (autonomous):**
- The agent rebalances within the policy limits without user approval.
- Even if the server/agent is compromised, funds can move **only between registered Blend pools** and cannot leave (drain protection).
- **Gas is abstracted away from the user:** in the MVP, wallet/transaction fees are covered by the system (funded with testnet XLM; fee-bump/sponsored). Apart from the one-time deposit, the user does not deal with XLM/gas. (OpenZeppelin Relayer in production.)

> If `passkey-kit` is legacy/deprecated, `smart-account-kit` (audited OZ stellar-contracts) is used — confirm at the start of the build.

## 7. Concrete Demo Scenario (what actually happens on testnet)

1. 1,000 test-USDC in the smart wallet, in Blend Pool A (e.g. X%).
2. The agent scans: Pool B pays X+Δ% and its risk is acceptable.
3. Claude: "The best risk-adjusted yield is Pool B (+Δ%). Moving." → `rebalance(A, B, 1000)`.
4. Executor: `withdraw(A)` tx + `deposit(B)` tx → **real testnet tx hashes**.
5. Position + activity log are updated (the frontend will show them).

## 8. Error Handling & Guards (MVP-grade)

- **Simulate** before every tx submit; on error → log it, do not crash the loop.
- Pool scan error → skip that pool, continue.
- LLM tool arguments are validated with **zod**; if invalid, nothing is executed.
- Guards: **min-yield-delta threshold** (no move for an insignificant difference), **rebalance cooldown**, **per-tx & daily cap** (also enforced on-chain by the policy signer).
- Idempotency: do not start a new rebalance while a tx is pending.

## 9. Test (MVP-grade)

- **Unit:** scanner parsing, risk score, decision-threshold logic (the deterministic parts).
- **Integration:** a **real deposit/withdraw smoke test** against Soroban testnet (assert tx success + balance change).
- **The LLM is mocked:** a deterministic decision is injected in tests → tests do not depend on Claude/the network.

## 10. Stack

`@stellar/stellar-sdk` · `@blend-capital/blend-sdk-js` · `passkey-kit` (or `smart-account-kit`) · `@anthropic-ai/sdk` (Claude tool-use) · Soroban RPC (testnet) · `better-sqlite3` (state/log) · Node + TypeScript.

## 11. Risks to Verify at Build Time

1. **Blend testnet pool availability:** The demo needs ≥2 USDC pools (so there is somewhere to move to). If there are not, we deploy our own test pools — **the first step of the build confirms this**.
2. **passkey-kit vs smart-account-kit:** use whichever is the current/canonical way to set up a policy signer; verify the policy-signer flow on testnet with an early spike.
3. **Blend APR calculation:** APR is not returned directly; it is computed off-chain from the `Reserve` struct (+BLND emissions separately) — the scanner must include this.
4. **Anthropic API key / model:** env config for Claude tool-use; mocked in tests.

## 12. Open Scope Note

The frontend (web dashboard) is outside this spec; it is the next phase. The backend `api` layer is designed to feed the previously drafted dashboard (position, live scan table, agent decision, activity log, chat).
