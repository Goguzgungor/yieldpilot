# Building YieldSeeker on Stellar (Soroban) — Feasibility & Architecture Report

> **Question:** "An autonomous AI agent that hunts the best DeFi yield for idle USDC, continuously scanning lending vaults and automatically moving the position to the highest yield according to the user's risk tolerance" (YieldSeeker; the original runs on Base with Coinbase AgentKit + AWS Bedrock + Morpho/Spark.fi + The Graph): **how is it built on Stellar/Soroban?**
> **Date:** 2 June 2026

---

## ⚠️ Methodology & Provenance of This Report

This report was written from data **salvaged** from a multi-agent deep-research workflow. After launching ~119 agents, the workflow **hung** (on an unresponsive web-fetch) and the final synthesis agent could not run. On your instruction we did not re-run it; instead we extracted the **80 completed `StructuredOutput`** outputs from the transcripts:

- **6 search angles** + ~30 sources (official Stellar Docs, GitHub repos, DefiLlama API, Messari, Stellar Community Fund)
- **Claims extracted from 28 sources** + **45 adversarial verification votes** → **38 verified, 7 refuted**
- **I** wrote the final synthesis (this report); the workflow's own synthesis layer did not run.

**Confidence labels:** `[✓ verified]` (refuted=false in the verify step), `[⚠ refuted/disputed]` (refuted=true), `[? unverified]` (could not be confirmed in the source). Live metrics (TVL/APR) change after this date.

---

## Executive Summary — Feasibility Verdict: **FEASIBLE** (at a medium-to-high maturity cost)

Stellar/Soroban provides **all of YieldSeeker's core primitives** — and on one point it is **stronger** than Base:

| Dimension | Status | Note |
|-------|-------|-----|
| **Yield source** | ✅ Strong | Blend Capital USDC supply APY **~8%+** — clearly above Aave V3 / SparkLend on Base at 2-5% `[✓]`. The yield-arbitrage thesis is stronger on Stellar. |
| **USDC + token interface** | ✅ Ready | Native Circle USDC + SAC (CAP-46-6) + SEP-41 token interface; programmatic `transfer`/`approve`/`transfer_from` from a Soroban contract `[✓]`. |
| **Vault standard** | 🟡 Draft | SEP-56 (ERC-4626 equivalent) exists but is an early draft (v0.1.2, Nov 2025), with no guarantee of adoption `[✓]`. |
| **Agent wallet model** | ✅ Mature primitives | Soroban smart wallets (contract accounts) + passkey + **policy signers** + fee-bump/sponsored reserves; the "full control never rests with the agent" principle is native `[✓]`. |
| **AgentKit equivalent** | 🟠 Weakest link | There is NO Coinbase-calibre AgentKit. The closest are **Stellar AI Agent Kit** (single developer, SCF ~$108K, MCP-based) and a few open-source MCP servers — all early stage `[✓]`. |
| **DeFi action library** | 🔴 None | AgentKit's ready-made Morpho/Compound adapters have no Stellar counterpart; **Blend/Soroswap adapters have to be written from scratch** `[✓]`. |
| **Data/indexing** | ✅ Multiple options | Mercury (Retroshades), Goldsky, SubQuery + DefiLlama API as the fast path `[✓]`. |
| **Agentic payment rails** | ✅ Live | x402 settlement is live on Stellar mainnet; MPP (Stripe+Tempo) went live on 3 April 2026 and sponsors XLM gas `[✓]`. |

**Conclusion:** Technical feasibility is high; the real work is **filling the missing tooling** (DeFi adapters + agent action layer) and working with a **small DeFi surface** (~$235M total TVL, mostly Blend + a few DEXs). A hackathon MVP can be stood up in a few days; production requires an audit + orchestrator contract + indexer + oracle-risk model.

---

## Section 0 — Reference Product (YieldSeeker) Teardown

YieldSeeker's **verified** component stack (ETHGlobal Agentic Ethereum 2025 Finalist, AgentKit Pool Prize) `[✓]`:

| Component | Role | Source |
|---------|-----|--------|
| **Coinbase AgentKit** | Agent wallet + on-chain action framework; API hosted in a Docker container on Autonome | [ethglobal showcase](https://ethglobal.com/showcase/yieldseeker-crg12) |
| **AWS Bedrock LLM** | Reasoning/risk scoring (chain-independent, **portable**) | ibid. |
| **Morpho + Spark.fi** | USDC lending/yield vaults on Base (extensible) | ibid. |
| **The Graph** | Indexing and querying yield options and tokens | ibid. |
| **Proprietary risk score** | A risk score for each yield option from on-chain data; matched to the user's risk tolerance | ibid. |
| **Wallet security** | "Coinbase TEE isolated accounts", non-custodial; "only you and your agent can move funds"; Nethermind Security + AuditAgent audit | [yieldseeker.xyz](https://www.yieldseeker.xyz/) |
| **Framework choice** | **Hand-coded** agent instead of elizaOS | [ethglobal showcase](https://ethglobal.com/showcase/yieldseeker-crg12) |

> ⚠️ **Refuted claim:** One source said "AgentWalletKit is YieldSeeker's wallet infrastructure"; this was **refuted** `[⚠ near 0-3]`. YieldSeeker's own site describes its wallet security as "Coinbase TEE isolated accounts" and never mentions AgentWalletKit. **AgentWalletKit** is a *separate* reference design built by the same team (EVM-only, Base) — it was NOT confirmed as YieldSeeker's live infrastructure. Still, its security pattern (parameter-level address validation, immutable AdapterRegistry, admin freeze) is a good reference for the Stellar policy-signer mapping. Source: [agentwalletkit.tokenpage.xyz](https://agentwalletkit.tokenpage.xyz/).

---

## Section 1 — Stellar DeFi Yield Landscape

Stellar total DeFi TVL: **~$235–241M** (1-2 June 2026, DefiLlama) `[✓]`; according to Messari it was $174.4M at the end of Q1 2026 (growing) `[✓]`.

| Protocol | Type | TVL | USDC yield | Programmatic access | Source |
|----------|-----|-----|---------------|--------------------|--------|
| **Blend Capital** | Lending (main target; Morpho/Spark equivalent) | **~$155M** (DefiLlama Jun '26) / $100.6M (Messari Q1) | **USDC ~8%+** (pool average 4.45%) | ✅ `PoolContract.submit()` / `submit_with_allowance()`; `@blend-capital/blend-sdk-js` | [DefiLlama](https://defillama.com/protocol/blend) · [Blend docs](https://docs.blend.capital/tech-docs/integrations/integrate-pool) |
| **Aquarius (Aqua)** | AMM/DEX | ~$34–37M | LP yield | ✅ via Soroswap | [DefiLlama Stellar](https://defillama.com/chain/stellar) |
| **DeFindex** | **Yield Aggregator** (vault routing; closest to Morpho) | ~$1.4M | — | ✅ (Soroban vault) | [DefiLlama Stellar](https://defillama.com/chain/stellar) |
| **Soroswap** | DEX **aggregator** (swap/routing layer) | ~$1.33M | — | ✅ API quote + XDR build + submit | [soroswap.finance](https://soroswap.finance/) |
| **Phoenix** | DEX | ~$1.82M | LP | ✅ via Soroswap | [DefiLlama Stellar](https://defillama.com/chain/stellar) |
| **FxDAO** | CDP stablecoin (USDx/EURx) | ~$4.3M debt | Stability pool | ✅ Soroban | [fxdao.io/docs](https://fxdao.io/docs/borrowing/) |
| **YieldBlox** | ⚠️ No longer independent | — | — | Blend V2's **YBX-DAO/Yieldblox V2 pool** | [Messari Q1'26](https://messari.io/report/state-of-stellar-q1-2026) |

**Critical findings:**
- **The yield-arbitrage thesis is stronger on Stellar:** Blend USDC APY has been **>8%** for months (vs 2-5% for Aave V3 & SparkLend on Base/EVM) `[✓]`. The growth comes not from token incentives but from tokenized Treasuries/RWA (Spiko, Ondo, Franklin Templeton) `[✓]`.
- **Liquidity exists:** ~$727M of USD stablecoins circulating on Stellar; USDC mcap ~$256M (end of Q1 '26), ~$10.2M/day of smart-contract volume `[✓]`.
- **The rebalancing surface is narrow:** Realistically the agent rebalances mostly **between Blend pools** + among a few DEXs/DeFindex. The dozens of venues on EVM are not there — this both simplifies things and limits yield diversity.
- ⚠️ **Oracle risk is real:** Blend Pools V2 (~$10.97M, 22 Feb 2026) and YieldBlox (~$10.2M) suffered **oracle manipulation** attacks `[✓]`. The autonomous agent's risk model MUST include an **oracle/liquidity-depth filter**. Source: [Halborn](https://www.halborn.com/blog/post/explained-the-yieldblox-hack-february-2026).

---

## Section 2 — USDC & Soroban Token Interface

- **Native USDC** (Circle) + PYUSD + USDY are natively supported on Stellar `[✓]` ([x402 on Stellar](https://stellar.org/blog/foundation-news/x402-on-stellar)).
- **SAC (Stellar Asset Contract)** — implements CAP-46-6 + SEP-41; makes classic Stellar assets (including USDC) callable from a Soroban contract. It wraps an existing asset **without redeploying** it; the SAC address is reserved, and anyone can deploy it `[✓]` ([SAC docs](https://developers.stellar.org/docs/tokens/stellar-asset-contract)).
- **SEP-41 Token Interface** (Draft v0.4.1, Aug 2025) — `transfer`, `transfer_from`, `approve`, `allowance`, `balance`, `burn` + metadata. `require_auth()` authorization model; `spender.require_auth()` for `transfer_from` → **the mechanism by which the agent's smart wallet/policy signer authorizes rebalancing moves** `[✓]` ([SEP-41](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md)).
- Practical pattern: the vault/rebalancer contract uses **`approve` + `transfer_from`** (allowance-based) — as in ERC-20.

---

## Section 3 — Soroban Smart Contract Capabilities & LIMITS

These are the architecture's most critical constraints:

- 🔴 **ONE operation per transaction** (excluding fee-bump) `[✓]`. Classic Stellar allows 100 ops; Soroban does not. So a **"withdraw from vault A + deposit into vault B"** rebalance cannot be done as a single classic multi-op tx. Solution: it is executed in a single invocation, atomically (all-or-nothing), through **nested cross-contract calls** inside an **orchestrator/vault contract** `[✓]` ([fees & limits](http://developers.stellar.org/docs/learn/fundamentals/fees-resource-limits-metering) · [cross-contract call](https://developers.stellar.org/docs/build/smart-contracts/example-contracts/cross-contract-call)).
- **Resource metering has 6 dimensions:** CPU instructions, number of ledger reads/writes, I/O bytes, tx size, event/return size, **ledger rent (TTL)**. These dimensions limit how many protocols a single atomic rebalance can touch `[✓]`.
- **100 smart-contract txs per ledger** (vs 1000 classic ops); more frequent surge pricing `[✓]`. This affects the autonomous agent's transaction frequency/cost.
- **No refund** for over-declared resources → the agent must estimate the resource fee correctly `[✓]`. TTL/state-rent cost has to be budgeted.
- **SEP-56 Tokenized Vault Standard** (ERC-4626 equivalent, Draft v0.1.2, Nov 2025, OpenZeppelin) — `deposit/mint`, `withdraw/redeem`, `convert_to_shares/assets`, `preview_*`, `total_assets`. **It does not impose strategy/rebalancing/authorization logic** → you write the autonomous yield routing yourself on top of this vault's deposit/withdraw flow `[✓]` ([SEP-56](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0056.md)).
- 🔴 **NO native scheduling/cron.** "Continuous scanning + scheduled rebalancing" requires an off-chain scheduler (cron/worker); there is no on-chain automation.

---

## Section 4 — AI-Agent Tooling (AgentKit Equivalent) — The Most Critical Gap

**Coinbase AgentKit** does NOT SUPPORT Stellar (EVM + Solana only) `[✓]`. 50+ TS/30+ Python actions, ready-made Morpho/Compound/Moonwell/Jupiter adapters, framework-agnostic (LangChain, OpenAI Agents SDK, Vercel AI, MCP, ElizaOS). **The LLM/orchestration layer is portable; the wallet + on-chain-action layer is chain-specific** `[✓]` ([coinbase/agentkit](https://github.com/coinbase/agentkit)).

Equivalents on the Stellar side (all early stage):

| Tool | What it provides | Maturity | Source |
|------|-----------|----------|--------|
| **Stellar AI Agent Kit** (`stellar-mcp`, Jose C. Toscano) | Soroban→MCP toolkit; generates a production-ready MCP server from any contract (TS/Python). **Policy Signer Generator CLI** + Smart Wallet template (PasskeyKit) + Policy Signer Sandbox. 3 app templates (Telegram bot, passkey wallet, CLI agent). | 🟠 Single developer, ~**$108K** funding from SCF #37. **MCP-based**, not a LangChain/AgentKit clone. LangChain/ElizaOS integration is **not documented** `[? ]` | [SCF project](https://communityfund.stellar.org/project/stellar-ai-agent-kit-mr6) · [DoraHacks buidl](https://dorahacks.io/buidl/25271) |
| **syronlabs/stellar-mcp** | A working open-source MCP server (MIT); Stellar Classic + Soroban; account/payment/contract build-deploy-invoke. | 🔴 18 stars/19 commits. **Signing takes the secret key as a parameter → UNACCEPTABLE for autonomous production**, prototype only `[✓]` | [github](https://github.com/syronlabs/stellar-mcp/) |
| **stellar-mcp-cli / -server** (DoraHacks 25271) | Turns a Soroban contract into an MCP server with a single command; the agent signs/submits XDR **without full account access** using a passkey-based policy signer + Passkey Kit + LaunchTube. The "move 5% of my account to the best yield" demo = **exactly the YieldSeeker scenario** `[✓]` | [DoraHacks](https://dorahacks.io/buidl/25271) |

**Agentic payment rails (live):**
- **x402 on Stellar** — an official SDF initiative; settlement is **live on mainnet** (millions of payments since May 2025); OpenZeppelin's **non-custodial x402 Facilitator**; native USDC/PYUSD/USDY. The x402-**MCP** server is still in active development `[✓]`. ⚠️ Nuance: the `awesome-x402` list counts EVM+Solana as x402 production networks and does not count Stellar `[✓]` — so **the general x402 ecosystem is Base/Coinbase-centric**, but **SDF's Stellar-x402 settlement is separately live**. An ElizaOS x402 plugin (ag402) exists but is EVM-bound.
- **MPP (Machine Payments Protocol)** — Stripe + Tempo; **live on Stellar as of 3 April 2026**; the SDK provides **XLM gas sponsorship** (the agent does not have to hold XLM); session-based (authorize a limit → micro-payments → batch settle); 100+ services (Stripe, Anthropic, OpenAI, Visa) `[✓]` ([Messari Q1'26](https://messari.io/report/state-of-stellar-q1-2026) · [agentic-payments docs](https://developers.stellar.org/docs/build/agentic-payments)).

> **Gap summary:** There is NO ready-made "Stellar AgentKit + DeFi action library". The closest is a one-person MCP toolkit. **You will write the Blend/Soroswap/DeFindex actions yourself.** This is the project's largest work item.

---

## Section 5 — Autonomous Agent Wallet/Account Model (Secure Signing)

Stellar offers strong, mature primitives here:

- **Contract accounts / Smart wallets** — a contract implementing `CustomAccountInterface` + `__check_auth` = a C-address smart wallet. When `require_auth` is called, the Soroban host runs `__check_auth`; "who can transact, under what conditions" lives entirely in the contract. Signer types: **passkey/WebAuthn (secp256r1), ed25519, policy signer, session key**. On-chain spend caps/allowlists/timelocks can be layered on → **"full control never rests with the agent"** `[✓]` ([contract-accounts docs](https://developers.stellar.org/docs/build/guides/contract-accounts)). (Protocol 21, 18 Jun 2024, brought native secp256r1.)
- **passkey-kit** (kalepail) — TS SDK; 3 signer types; **policy signers** restrict a signer to a specific contract + co-signer (`SignerLimits`). ⚠️ **Now deprecated/legacy** → the maintainer directs new projects to **`smart-account-kit`** (built on the audited OpenZeppelin stellar-contracts); the demo code is unaudited and should not be used for real value `[✓]` ([passkey-kit](https://github.com/kalepail/passkey-kit)).
- **OpenZeppelin stellar-contracts/accounts** — `SmartAccount` trait + context rules; **production-grade**, granular per-action policy. Audited components instead of writing a custom `__check_auth` `[✓ /? maturity]` ([OZ accounts](https://github.com/OpenZeppelin/stellar-contracts/tree/main/packages/accounts)).
- **Gasless/sponsored:**
  - **fee-bump** — one account pays the fee for a tx signed by another account (sponsor/relayer model); the outer envelope wraps the inner tx `[✓]` ([fee-bump docs](https://developers.stellar.org/docs/build/guides/transactions/fee-bump-transactions)).
  - **sponsored reserves** — the `BeginSponsoringFutureReserves`/`End` sandwich.
  - ⚠️ **Launchtube** (Soroban op submit + fee sponsorship) — **archived on 9 March 2026 (read-only)**, replaced by **OpenZeppelin Relayer + Channels Plugin** (the recommended solution) `[✓]` ([launchtube](https://github.com/stellar/launchtube)).
  - **MPP SDK** XLM gas sponsorship (Section 4).
- ⚠️ **Important Soroban constraint:** Soroban contracts cannot pay the Stellar tx fee, and they keep a **nonce**, not a sequence number; two signing paths — G-account full-tx signing, and G/C-account **auth-entry signing** with a sponsored fee `[✓]`.

**Recommended agent signing model:** The user opens a smart wallet (contract account) with a passkey; the agent is given a **restricted policy signer** (only "deposit/withdraw to registered Blend/Soroswap contracts" actions + per-tx/daily cap + allowlist). The agent builds the XDR, signs it with the policy signer and submits it gaslessly via OZ Relayer/MPP. Even if the server is compromised, funds can move **only between pre-approved vault addresses** (the Stellar counterpart of the AgentWalletKit pattern).

---

## Section 6 — Data / Indexing (The Graph Counterpart)

| Layer | Tool | Use | Source |
|--------|------|----------|--------|
| **Fast APR feed (MVP)** | **DefiLlama API** (`api.llama.fi/v2/chains`, `/protocol/blend`, `/overview/dexs/stellar`) | Pull Blend/Stellar TVL+APY without setting up an indexer; normalize `apyBase/apyReward` | [DefiLlama](https://defillama.com/chain/stellar) |
| **Soroban-native indexer** | **Mercury Retroshades** (parallel SVM fork, custom data structures, an indexer in minutes) + Mercury Classic (GraphQL contract events) | Index vault deposit/withdraw/rate events in a rich structure | [Mercury docs](https://docs.mercurydata.app/retroshades/introduction-to-retroshades) |
| **ETL → own DB** | **Goldsky** Mirror/Turbo Pipelines (push to Postgres/ClickHouse, reorg-safe) | Low-latency APR pipeline | [Goldsky Stellar](https://goldsky.com/chains/stellar) |
| **Decentralized (The Graph-like)** | **SubQuery** (300+ chains, OnFinality hosting) | The model closest to The Graph | [Stellar indexer providers](https://developers.stellar.org/docs/data/indexers/indexer-providers) |
| **Historical/backtest** | **Hubble** (SDF BigQuery dataset) | Historical APR trend analysis/backtest — **NOT real-time** (intraday batch) `[✓]` | [Hubble docs](https://developers.stellar.org/docs/data/analytics/hubble) |
| **DIY (cheapest)** | **Soroban RPC `getEvents`** + cron + SQLite | RPC keeps events for **only ~7 days** → ingesting into your own DB is MANDATORY | [event ingest docs](https://developers.stellar.org/docs/build/guides/events/ingest) |

⚠️ **Horizon is being deprecated** — even the data on Horizon will need an indexing service in the future → in production a **dedicated indexer is not optional but mandatory** `[✓]`.
⚠️ Blend **does not return APR directly**; it is computed off-chain from the `Reserve` struct + the BLND emission APR is separate `[✓]`.

---

## Section 7 — Architecture Mapping Table (YieldSeeker → Stellar)

| YieldSeeker (Base) | Stellar/Soroban Counterpart | Status |
|--------------------|---------------------------|-------|
| **Coinbase AgentKit** (agent wallet + action) | **Stellar AI Agent Kit (stellar-mcp)** / syronlabs-mcp + **custom Blend/Soroswap action layer** | 🟠 Partial; actions still to be written |
| **AWS Bedrock LLM** | Same (any LLM) — **portable** | ✅ Unchanged |
| **Morpho / Spark.fi vaults** | **Blend Capital** (main) + **DeFindex** (aggregator) + SEP-56 vaults | ✅ Available (narrow) |
| **The Graph** | **Mercury (Retroshades) / Goldsky / SubQuery** + **DefiLlama API** (fast path) | ✅ Multiple options |
| **Proprietary risk score** | Same off-chain logic + **oracle/liquidity-depth filter** (mandatory after the Blend/YieldBlox hacks) | ✅ Portable + strengthen |
| **Coinbase TEE wallet** | **Soroban smart wallet (contract account)** + **smart-account-kit/passkey** + **policy signers** | ✅ Mature primitive |
| **Swap/routing** | **Soroswap API** (quote + XDR + submit) | ✅ Ready |
| **Gasless tx** | **fee-bump + OpenZeppelin Relayer** (Launchtube archived) / **MPP gas sponsorship** | ✅ Ready |
| **Atomic multi-step transaction** | **Orchestrator contract + nested cross-contract call** (1-op-per-tx limit) | 🟡 Extra contract work |
| **Scheduling/cron** | **Off-chain worker** (no native cron on Soroban) | 🟡 Off-chain |
| **Vault standard (ERC-4626)** | **SEP-56** (early draft) | 🟡 Draft |

---

## Section 8 — Recommended Architecture: Hackathon MVP vs Production

### 🏃 Hackathon MVP (days)
1. **Data:** Scan Blend USDC APY + a few pools with the DefiLlama API (do not set up an indexer).
2. **Agent:** Simple risk scoring with an off-chain Node/TS worker + LLM (Bedrock/any); Soroban tool layer with **stellar-mcp** (Jose Toscano or syronlabs).
3. **Wallet:** Smart wallet with passkey-kit/smart-account-kit; a single **policy signer** for the agent (Blend deposit/withdraw + cap).
4. **Execution:** `submit()` deposit/withdraw with `@blend-capital/blend-sdk-js`; the Soroswap API if a swap is needed. Pool rebalancing within a single protocol (Blend) is enough.
5. **Gasless:** OZ Relayer or MPP.
> Risk: syronlabs-mcp's secret-key signing is not suitable for production — use a demo wallet in the MVP, do not put in real funds.

### 🏗️ Production (weeks–months)
1. **Orchestrator/Vault contract (Rust):** SEP-56 compliant; atomic rebalance in a single invocation via **nested cross-contract calls**; per-protocol **immutable, audited adapters** (AdapterRegistry pattern); admin pause/freeze.
2. **Wallet:** **smart-account-kit** (audited OZ stellar-contracts) + granular policy signers + parameter-level target-address validation.
3. **Data:** Own indexer with Mercury Retroshades or Goldsky + backtesting on Hubble; RPC `getEvents` fallback.
4. **Risk model:** oracle-health + liquidity-depth + TVL-threshold + protocol-audit filters (the lesson of the Blend/YieldBlox oracle hacks).
5. **Gasless/fee:** OZ Relayer (Channels Plugin) + MPP; resource-fee estimation (no refund).
6. **Audit:** Nethermind-style + AuditAgent (the path YieldSeeker followed).
7. **Funding path:** Stellar Community Fund (the channel through which Stellar AI Agent Kit received $108K).

---

## Section 9 — Gaps, Risks & Unverified Items

**Clear gaps `[✓]`:**
- NO Coinbase-calibre AgentKit + ready-made DeFi action library → the largest development burden.
- A LangChain/ElizaOS Stellar plugin is **not documented** `[?]` (the MCP path exists).
- The SEP-56 vault standard is an early draft, with no guarantee of adoption.
- The DeFi surface is narrow (~$235M; mostly Blend + a few DEXs) → limited rebalancing diversity.
- 1-op-per-tx + 7-day RPC event retention + Horizon deprecation + Launchtube archival → extra infrastructure decisions.

**Risks `[✓]`:** Oracle manipulation (Blend $10.97M, YieldBlox $10.2M, Feb 2026); surge pricing; state-rent (TTL) cost; dependence on single-developer tooling.

**Advantages `[✓]`:** Blend USDC ~8%+ (2-3x Base's) → a strong yield-arbitrage thesis; mature smart-wallet/passkey/policy-signer primitives; live x402+MPP agentic payment rails; a fast MVP via the DefiLlama API; DeFindex as a ready-made aggregator primitive; the SCF funding path.

**⚠️ Refuted / disputed claims (for transparency):**
- "AgentWalletKit = YieldSeeker's wallet infrastructure" → **refuted** (multiple votes). YieldSeeker's official site says "Coinbase TEE isolated accounts".
- Coinbase Agentic Wallets' **"true self-custody"** wording is **disputed** — independent sources (dev.to, Cobo) describe the model as "custodial/MPC, keys held by Coinbase".
- Coinbase's **"3am automatic rebalancing"** narrative is framed in the independent press (Yahoo Finance) as **"aspirational/infrastructure-mode"**, not as a shipped feature.

**`[? unverified]`:** Soroswap's exact USDC APR/TVL; the current independent status of FxDAO/YieldBlox; the maturity of StellarYield ([github](https://github.com/edehvictor/StellarYield) — an AI yield aggregator on Stellar, *an independent community repo*, unclear whether it is live or hackathon-stage); the audit status of OZ stellar-contracts; some x402-Stellar facilitator details; third-party claims about Lumexo/MPP.

---

## References (Primary & Secondary)

**Reference product:** [ethglobal.com/showcase/yieldseeker-crg12](https://ethglobal.com/showcase/yieldseeker-crg12) · [yieldseeker.xyz](https://www.yieldseeker.xyz/) · [agentwalletkit.tokenpage.xyz](https://agentwalletkit.tokenpage.xyz/) · [coinbase/agentkit](https://github.com/coinbase/agentkit) · [Coinbase Agentic Wallets](https://www.coinbase.com/developer-platform/discover/launches/agentic-wallets)

**Stellar DeFi/yield:** [DefiLlama Stellar](https://defillama.com/chain/stellar) · [DefiLlama Blend](https://defillama.com/protocol/blend) · [Blend integrate-pool](https://docs.blend.capital/tech-docs/integrations/integrate-pool) · [Soroswap](https://soroswap.finance/) · [FxDAO docs](https://fxdao.io/docs/borrowing/) · [Messari State of Stellar Q1 2026](https://messari.io/report/state-of-stellar-q1-2026) · [Halborn YieldBlox hack](https://www.halborn.com/blog/post/explained-the-yieldblox-hack-february-2026)

**Token/Soroban:** [SAC docs](https://developers.stellar.org/docs/tokens/stellar-asset-contract) · [SEP-41](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md) · [SEP-56 vault](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0056.md) · [fees/resource limits](http://developers.stellar.org/docs/learn/fundamentals/fees-resource-limits-metering) · [cross-contract call](https://developers.stellar.org/docs/build/smart-contracts/example-contracts/cross-contract-call)

**Agent tooling/payments:** [Stellar AI Agent Kit (SCF)](https://communityfund.stellar.org/project/stellar-ai-agent-kit-mr6) · [syronlabs/stellar-mcp](https://github.com/syronlabs/stellar-mcp/) · [DoraHacks stellar-mcp](https://dorahacks.io/buidl/25271) · [x402 on Stellar](https://stellar.org/blog/foundation-news/x402-on-stellar) · [agentic-payments docs](https://developers.stellar.org/docs/build/agentic-payments) · [awesome-x402](https://github.com/xpaysh/awesome-x402)

**Wallet/signing:** [contract-accounts](https://developers.stellar.org/docs/build/guides/contract-accounts) · [passkey-kit](https://github.com/kalepail/passkey-kit) · [OZ stellar-contracts/accounts](https://github.com/OpenZeppelin/stellar-contracts/tree/main/packages/accounts) · [fee-bump](https://developers.stellar.org/docs/build/guides/transactions/fee-bump-transactions) · [launchtube (archive)](https://github.com/stellar/launchtube)

**Data/indexing:** [indexer providers](https://developers.stellar.org/docs/data/indexers/indexer-providers) · [Mercury Retroshades](https://docs.mercurydata.app/retroshades/introduction-to-retroshades) · [Goldsky Stellar](https://goldsky.com/chains/stellar) · [event ingest](https://developers.stellar.org/docs/build/guides/events/ingest) · [Hubble](https://developers.stellar.org/docs/data/analytics/hubble)

---

*This report was synthesized by hand from 80 structured agent outputs (38 verified + 7 refuted claims, 6 search angles, ~30 sources) salvaged from a deep-research workflow that hung. The final automatic-synthesis layer did not run; the confidence labels and "unverified" markers were kept. For production decisions, confirm the marked primary sources (especially Blend SDK, smart-account-kit, SEP-56) directly.*
