## Project name
**Vigil** (by the YieldPilot team)

## One-line description
Open-source risk ratings for every pool of Blend's V2 and v2.1 deployments and for four DeFindex strategies built on them. Ratings are signed every 30 minutes into a Soroban registry designed for several publishers (one, ours, today), and an OpenZeppelin smart-account policy enforces them: a deposit into a pool rated below the owner's minimum is refused, while withdrawals always stay open.

## Track
Open Track (developer tooling / infrastructure)

## Problem

Stellar lending is concentrated in Blend V2's permissionless pools, and every pool's risk lives in its configuration:
- which oracle prices each collateral asset
- how large the backstop is and how much of it is queued to leave
- the pool status
- the reserve parameters

Blend's own documentation leaves the job of checking these to the user ("Choosing Pools"). Wallets, yield apps and AI agents that move user funds have no machine-readable, on-chain way to do it.

The failure mode is real:
- **YieldBlox pool loss.** On 22 Feb 2026 about $10.2–11M (gross) was drained from the YieldBlox pool; about 48M XLM of it (~$7.2–7.5M) was then frozen in the attacker's accounts by Tier-1 validators, and Script3 said the pool's depositors would be compensated. [rekt.news/yieldblox-rekt; Halborn; Protos] USTRY was pushed on SDEX from ~$1.06 to $106.74 and used as collateral. [DefiLlama hacks entry for blend-pools-v2; rekt.news/yieldblox-rekt; BlockSec] The pool's oracle aggregator has a per-update `max_dev` limit. Our reading of the aggregator source (`price_data.rs`) is that it only compares the newest price with the one before it, so a manipulated price held for two rounds passes; rekt.news reports the poisoned price was ingested in two consecutive rounds.
- **Comet exploit.** On 25 Aug 2026 the Comet BLND–USDC pool, whose LP tokens make up Blend's backstop, lost $717K to an accounting bug ("Incorrect Share Accounting"). [DefiLlama hacks entry for CometDEX] Today the V2 backstop's `pool_data` reports 0 BLND and 0 USDC behind every V2 pool. Blend relaunched the same pool code as **v2.1** on 2026-09-30, with a new backstop and factory (blend-ui PR #238).

The main Blend pools were in these states on 2026-11-02 16:02 UTC, read from mainnet:

| Pool | Status | Notes |
|---|---|---|
| Fixed (V2) | 3 (On_Ice, borrowing disabled) | $168.8M supplied, $39.6M borrowed; DeFindex's USDC strategy has **~$18.8M** in it, read from the strategy's own pool position. Backstop $0. |
| YieldBlox | 3 (On_Ice) | backstop withdrawal queue 97.8%, past the 60% at which `update_status` would freeze it |
| Etherfuse | 4 (Admin_Frozen, deposits disabled) | |
| Fixed v2.1 | 1 (Active) | $149.2K supplied. At 13:59 UTC its USDC reserve was **96.1% borrowed against its own 90% `max_util`**: of $43.6K of USDC supplied, $1.7K could be withdrawn. A ~$3K deposit brought it to 89.9% by 14:32 ($4.7K of $46.6K). Backstop 7.12M BLND + 11.9K USDC, 44.5% of it queued for withdrawal |

The V2 backstop's reward zone is empty; v2.1's holds its one pool.

**Status alone is not enough.** Blend's status only changes when someone calls `update_status()`. It says nothing about the oracle and collateral configuration, which is what failed in February.

**What the engine finds today** (engine v2.5, mainnet, the deployment's run of 2026-11-02 16:02 UTC, archived as [`/api/ratings/runs?at=1793635344`](https://yieldpilot.org/api/ratings/runs?at=1793635344); `npx tsx scripts/vigil-verify.ts 1793635344` matches all 17 ratings and the registry). Run it locally with `npx tsx scripts/vigil-ratings.ts`; full table, sources and version history in `docs/vigil/methodology.md` §7 and §10.
- **Coverage.** All 13 pools deployed by Blend's two V2-code factories are read: 12 from V2 and 1 from v2.1, found from each factory's full `deploy` history and confirmed with `is_pool`. Each pool is measured against the backstop named in its own config. 4 configured DeFindex strategies are rated from their pools; the vaults created by DeFindex's factory are not enumerated yet (deliverable 1.1). Blend V1 pools are out of scope.
- **Grades.** 5 Blend pools are graded and 8 are **not rated (NR)**: five never launched, and three hold under $10K. The grade rates the pool's setup; Blend's status is shown next to it and decides whether deposits are possible. 4 of the 17 ratings accept deposits, all C 57, and **none reaches the default RiskGate minimum of 60**, so the gate refuses every new deposit today.
- **Fixed v2.1 is C 64 and not eligible: its lenders were locked in within the last 6 hours.** Its setup scores 89 (CEX-priced collateral, no SDEX exposure, a backstop worth 69% of its liabilities after the queue). At 13:59 UTC its USDC was 96.1% borrowed against its own 90% `max_util`, so lenders could take out $1.7K of $43.6K. Under v2.3 it was B 74, the one pool above 60, because utilization is one factor of seven; v2.4's HR10 made a pool at or past its `max_util` not eligible and at most C. At 14:32 a ~$3K deposit put USDC at 89.9%, just under the line, and v2.4, reading only the current state, graded it B 75 and published 75. v2.5 (live since the 15:02 run) holds HR10 for 6 hours after any read at `max_util`, so the pool stays not eligible until six hours pass without one (19:59 UTC if it stays under). Its way back is market-side: borrowers repaying or lenders adding USDC.
- **Fixed (V2) is C 57.** Its backstop covers $0 of $39.6M of borrows: lenders carry the first loss, so the grade is capped at C however clean its price feeds are. DeFindex's three Fixed strategies ($18.8M in USDC) inherit C 57.
- **YieldBlox is not eligible.** 97.8% of its backstop is queued for withdrawal; Blend's own rule freezes a pool at 60% as soon as anyone calls `update_status`, so the engine applies that rule now. The frozen Etherfuse pool (CETES/USTRY/TESOURO from the pool admin's own push oracle) is C 53.
- **Orbit `CAE7QV…` is E 34 in this run.** It prices CETES through an adapter whose output matches the Reflector DEX price exactly (inferred from price matching; the adapter is not open source). Pushing CETES ×100 on SDEX, against about $180K borrowable, costs $64.5K plus $2.1K of collateral on the thinnest of the 8 books the deployment has read in the last 24 h (10:59 UTC; a CLI run without that history read $148K from the 13:50 book); on 2026-11-01 it moved in and out of grade E as the book changed ($275 at 15:07 UTC, $253K at 19:17, $268 at 20:19). Since v2.3 SDEX manipulation is rated on the thinnest book of the last 24 h, so a thin book keeps the pool at E for a day instead of flipping back within the hour. The pool is Admin_Frozen, so nothing can be borrowed from it today.
- **Etherfuse push oracle.** On the Etherfuse pools, CETES, USTRY and TESOURO are priced by a push oracle whose admin is the pool admin's own key. On one pool that oracle has been stale since 2025-11-24.
- **The methodology is frozen at v2.5 for this round.** Six versions shipped in two days (v2.0 to v2.5), each after an internal review of the previous one's live output; the reasons are in methodology §10. v2.3 was announced as frozen; that was broken twice, both times for the liquidity rule above (v2.4 added it, v2.5 gave it the 6-hour window), and the methodology says so. From here it changes only through the public review in 1.2, published with every comment and our answer.

**Backtest.** The YieldBlox pool's configuration on 2026-02-22 00:00 UTC was reconstructed:
- Status and reserves come from admin events.
- Supply and borrows come from replaying 53,537 pool events.
- The USTRY order book comes from the post-mortem.

The engine gives that configuration **grade E, not eligible**. Pushing USTRY ×100 cost about $5. $190K of collateral could then borrow $13.1M; the attacker actually took $10.9M. Without the SDEX rule it would have scored 49 (D), one point under the deposit line, mostly because its USDC reserve was 80% borrowed; earlier engine versions, which averaged utilization over the whole pool, gave it C. The result is labelled a reconstruction, because historical order books do not exist.

## Solution

1. **Risk engine (open source, TypeScript).**
   - **Inputs:** each pool's status, admin, backstop (size vs. pool liabilities, withdrawal queue, Blend's backstop threshold), reserve configuration (c_factor, l_factor, supply cap, utilization) and **per-asset oracle-source attribution**. Attribution covers the Blend oracle aggregator's `oracles()`/`asset_configs()`, Reflector CEX/DEX/fiat feeds, fixed pegs and issuer push oracles.
   - **Manipulation cost:** only for collateral that is actually priced from SDEX/DEX. The cost to move the price, on the thinnest order book of the last 24 h, is compared with the value borrowable against it. Because the deployed aggregators' `max_dev` check only compares consecutive prices, the attacker is modelled as holding the price for two rounds.
   - **DeFindex:** strategies are rated from their underlying pools.
   - **Output:** a score (0–100) and grade (A–E) per pool, or NR for a pool that never launched or holds under $10K, with the factors behind it, plus a `reasonsHash`, the sha256 of the canonical inputs and factors. Each published run is archived for 90 days with everything it was computed from, order books included, and `scripts/vigil-verify.ts` recomputes every published hash from that archive, re-rates every pool and compares with the registry. A permanent archive outside our deployment is deliverable 1.1.
2. **`RiskRegistry` (Soroban).** Registered publishers sign `(pool, score, timestamp, reasonsHash)`. Readers get an M-of-N aggregate: the conservative median of fresh submissions, with the oldest timestamp used for freshness. Below the threshold, the aggregate is "no rating".
3. **`RiskGate` (Soroban, OpenZeppelin smart-account policy).** It attaches to the context rules a smart account gives an agent or app.
   - **Blend `submit` / `claim`:** `from = spender = to` must be the account, and only supply/withdraw request types are allowed.
   - **Token transfers:** they may only go to the pool.
   - **Deposits:** they need a fresh rating ≥ the owner's minimum. Withdrawals are never rating-gated.
4. **TypeScript SDK and public API** for wallets, vault managers and agents. YieldPilot, our autonomous yield agent, is the first consumer.

## What exists today (built before this application, all verifiable)

| | Evidence |
|---|---|
| `vigil-guard` (RiskGate) and `vigil-registry` on testnet | guard `CD6BDS7R5K3IUCQSJUZUWAGLTR47EZOYEVCO5MPT7YGNBNQRHSNY5VMS`, registry `CB4LXLCCD7YDND5FBVXPKPHUQMF7JFSDRVXHG7ZZTWWNPJ6WDCXDNDF6`. 79 contract tests, plus 1 that runs the built wasm. A compatibility suite runs the *deployed* OpenZeppelin smart-account wasm (0.7.x build): the External ed25519 agent cases run with no auth mocked, the Delegated-signer cases mock the signer's auth. |
| On-chain proof on a real smart account and the real Blend pool (testnet) | **Before the guard:** the agent key withdrew a user's position to an attacker address ([`afd85af7…`](https://stellar.expert/explorer/testnet/tx/afd85af79be5399e6171debf100c9f405fa1b31dcd01a792f71a1947916a49a9)); a legitimate supply worked ([`36ee6d02…`](https://stellar.expert/explorer/testnet/tx/36ee6d02b4db4fa9a75aa8fb861a3be0605c3a2311f8ab525c554311d0bcbd84)). **The owner adds the guard:** [`3741e356…`](https://stellar.expert/explorer/testnet/tx/3741e35695821fd241a7d92be6ac9b1eeb844ab136fa6b8c651c3d883a397f04), [`3fc7a2bc…`](https://stellar.expert/explorer/testnet/tx/3fc7a2bcb4e87142943510bd2af91cb0b49c7ec030a4af1c3e82aad1440da0ba). **After the guard:** a supply at rating 80 succeeds ([`e97b7128…`](https://stellar.expert/explorer/testnet/tx/e97b7128d04a29c7e784ad695f3d28efaaf9937a9bb0e9552a650a6a606360b9)), and a withdrawal back to the account at rating 30 succeeds ([`18c14f1a…`](https://stellar.expert/explorer/testnet/tx/18c14f1a3d255151d5c74b7717d6fa0ea20ab55b6d4ccf7669987a1f48cacf86)). The guard rejects these inside `__check_auth` when simulated against live testnet state, so they cannot be submitted: withdrawal to the attacker `#4109`, direct transfer `#4113`, borrow `#4111`, supply at rating 30 `#4115`. The ratings in this demo were published by hand (80, then 30); see the next row for engine output. |
| User-owned smart accounts | New wallets are owned by the user's own Freighter (now Varial) account (`Signer::Delegated(G)`), which also signs the agent's rules; no backend key can change them. The 7 testnet wallets registered before 2026-11-01 were owned by the backend demo key with no guard on their pool rule. On 2026-11-02 the migration added the guard (with the rating gate) to both agent rules of each and made each user co-owner, so the backend can no longer change them alone ([21 testnet transactions](https://github.com/Goguzgungor/yieldpilot/blob/feat/yieldseeker-mvp/docs/legacy-migration-2026-11-02.md)); the backend key leaves each wallet when its user signs "Finalize ownership" in the app. |
| Source code | [github.com/Goguzgungor/yieldpilot](https://github.com/Goguzgungor/yieldpilot), Apache-2.0: contracts in `contracts/`, engine in `src/lib/vigil/`, SDK in `packages/vigil-sdk/`, proofs in `scripts/` |
| Risk engine v2.5 on mainnet data | 13/13 Blend pools across the V2 and v2.1 deployments + 4 DeFindex strategies; 157 engine tests (455 in the repo); SDEX manipulation rated on the thinnest order book of a rolling 24 h window; a pool whose lenders could not withdraw in any read of the last 6 h is not eligible; versioned changes v2.0 → v2.5 documented with the reason for each, frozen for the review round; methodology with sources ([`docs/vigil/methodology.md`](https://github.com/Goguzgungor/yieldpilot/blob/feat/yieldseeker-mvp/docs/vigil/methodology.md)) |
| Public ratings page + JSON API | [yieldpilot.org/ratings](https://yieldpilot.org/ratings) and [/api/ratings](https://yieldpilot.org/api/ratings), recomputed from mainnet every 30 minutes. Each pool shows its factors, hard rules, current supply/borrow APR and what would raise it to B or A. |
| Engine ratings published on-chain every 30 minutes (testnet) | The deployment publishes them itself: [`/api/cron/publish`](https://github.com/Goguzgungor/yieldpilot/blob/feat/yieldseeker-mvp/src/app/api/cron/publish/route.ts) refreshes the live ratings and signs the graded ones into the registry with `publish_batch`, using a testnet key that can only publish. An external scheduler (cron-job.org) calls it every 30 minutes, since 2026-11-02 14:00 UTC: Vercel's Hobby plan runs crons at most daily, and GitHub never started a scheduled run of the Actions job that did this first, which is now the manual backup. First run with the full archive, 2026-11-02 13:59:59 UTC, engine v2.4.0: [`822bba5c…`](https://stellar.expert/explorer/testnet/tx/822bba5c1cbaf5fb97411903b9e675a3feee01395745bedff89856ac19b62406), [`e589a45a…`](https://stellar.expert/explorer/testnet/tx/e589a45a729dedc99529ebd860d5eee15089cdd55d1082e071a8a0c46a669527) (archived as [`/api/ratings/runs?at=1793627999`](https://yieldpilot.org/api/ratings/runs?at=1793627999)). Engine v2.5.0 runs since 15:02 UTC. At the time of writing the registry holds the 16:02:24 UTC run: [`1190d0f3…`](https://stellar.expert/explorer/testnet/tx/1190d0f3066866e73a14a2d8cf7306d5cb477c260e454f2e54643f5784400ec8), [`446fea45…`](https://stellar.expert/explorer/testnet/tx/446fea45771a9082ce1d5610433542b94e1b0b3e9cef60c7dce71c02d78b397b); `npx tsx scripts/vigil-verify.ts` checks the latest run and matched all 17 ratings and the registry entries of the 9 graded ones and the stand-in. An older run is checked by its timestamp: its hashes still match, its re-rate needs the commit of its engine version, and the registry reports that it holds a later run. `get_rating` returns the engine's score for all 9 graded ratings and the execution pool's stand-in (57, from Fixed). Each run is kept for 90 days at [`/api/ratings/runs`](https://yieldpilot.org/api/ratings/runs) under the timestamp `get_rating` returns, with everything it was computed from: each pool's snapshot and every order book of the 24 h window, stored once by hash. [`scripts/vigil-verify.ts`](https://github.com/Goguzgungor/yieldpilot/blob/feat/yieldseeker-mvp/scripts/vigil-verify.ts) needs no keys: it recomputes every `reasonsHash` of a run from the archive, re-rates every pool, and compares with each publisher's submission in the registry. The registry is 1-of-1: our key is its only publisher. The engine version is inside `reasonsHash`, but the registry entry does not store it or the eligibility flag yet (deliverable 1.3). The first publication, on 2026-11-01 with engine v2.0, is superseded. |
| SDK v0.1 | `packages/vigil-sdk`: guard params, registry client, error decoding |
| YieldPilot, the reference consumer (live app) | yieldpilot.org scans Blend + DeFindex on mainnet (read-only) and executes per-user on testnet through OZ smart accounts. The rating gate is on: new wallets get RiskGate with a minimum of 60 against the registry, and the agent applies the same check before it chooses, so it only routes to a pool with a fresh, eligible Vigil rating ≥ 60 (`src/lib/vigilGate.ts`). The testnet execution pool carries the rating of the mainnet pool YieldPilot holds, refreshed every 30 minutes. Today no pool passes the gate: Fixed v2.1 is not eligible (its USDC lenders were locked in within 6 h) and Fixed is C 57, so the agent holds and idle USDC stays idle. Vigil is what stops it from adding to either. Withdrawals stay open. |


## Stellar integration
- **Soroban contracts:** `RiskRegistry` and `RiskGate`. RiskGate implements the OpenZeppelin `stellar-accounts` `Policy` trait and is called from the smart account's `__check_auth`.
- **OpenZeppelin smart accounts:** context rules, External ed25519 and Delegated (G-account) signers, the spending-limit policy.
- **Blend V2 and v2.1:** pool, backstop and oracle-aggregator reads, each pool against its own deployment's backstop; `submit` request semantics enforced on-chain.
- **DeFindex:** strategy positions in Blend pools.
- **Oracles:** Reflector and SEP-40 feeds; SDEX order books via Horizon, for SDEX-priced collateral only.
- **Freighter:** owners sign rule changes as ordinary transactions.

## How Vigil relates to existing work
Stellar already has risk data for Blend, and other chains already have on-chain risk ratings:

| Project | What it does | How Vigil differs |
|---|---|---|
| Alterscope (SCF #24/#26) | Blend risk reads through an API, including an agent API, MCP and webhooks; closed source | Vigil's ratings and contracts are open source and enforced in the user's own smart account; Alterscope data could feed a Vigil publisher |
| Stenion (github.com/stenion-lab/stenion, MIT, since Aug 2026; stenion.vercel.app) | Open source. Live 0–100 safety scores for five Stellar markets (Blend's Fixed, YieldBlox and Etherfuse pools, Kinetic, Aquarius XLM/USDC) through a public API, with lending factors that include admin-key control and withdrawable liquidity | The closest open-source peer. Its admin-key factor covers a risk Vigil does not model (methodology §9). It has no on-chain registry or enforcement; a Stenion publisher would bring its factors into the registry, which is how we would like to work with it |
| Riskon | Open source. Rates Blend lending pools and asset issuers from chain data, with the raw inputs shown; commits per-user risk scores to a Soroban testnet contract | Vigil models each collateral's price source and SDEX manipulation cost, signs ratings into a multi-publisher registry and gates deposits in the user's account |
| Tsuna (HackMeridian, Oct 2026; github.com/CHAAIISE/tsuna) | Agent vaults on OpenZeppelin smart accounts with on-chain limits on Blend and DeFindex calls; its testnet demo rejects a withdrawal to an attacker | The closest match to RiskGate's enforcement half. Its limits are fixed rules; RiskGate's deposit gate follows published ratings, and it lives in the user's own account rather than a vault |
| DD (SCF #38) | Decisioning and risk-data scoring for digital assets and wallets | Scores assets and wallets, not lending-pool configuration, and is not enforced in a smart account |
| Sentora, Upshift | Curated vault infrastructure with risk controls, entering Stellar | Risk is managed inside their own vaults; Vigil is a public rating any wallet or vault can enforce, and could be one of their inputs |
| Dig (SCF #43), Tezoro (SCF #42) | Dig: analytics and on-chain alerts across Blend and DeFindex. Tezoro: yield aggregation by user-chosen risk level | Monitoring and allocation products; neither publishes a rating that a contract can read |
| Stellar Oracle Shield (SCF #43) | Health scores for oracle asset pairs; single operator; testnet | Vigil works at pool level; Oracle Shield scores are designed as an input |
| Orion (SCF #41), DeRisk (#20), Hoops (#29/#30), Untangled/Credio | Exposure APIs, early warnings and risk analytics | None of them is enforced on-chain inside a user's account |
| Hypernative (SCF #26) | Custom Blend monitors and alerts | A monitoring channel, not a published rating |
| Policywright (SCF #44), REAPP (SCF #43) | Least-privilege OpenZeppelin policies and policy enforcement for agents | Vigil's guard is one such policy, specialised to Blend submits and fed by ratings; it could be packaged as a Policywright template |
| Credora by RedStone + Newton Protocol (EVM) | Credora rates Morpho and Spark vaults; Newton's policy layer (mainnet beta) blocks transactions when a Credora rating crosses a curator's threshold. RedStone already prices one Blend pool | The closest precedent for ratings enforced by policy, on EVM. A Credora feed could be a Vigil publisher input |
| Exponential.fi, Chaos Labs Risk Oracles, Gauntlet (EVM) | Exponential grades DeFi pools A–F; Chaos Labs and Gauntlet push risk parameters on-chain for the protocols that hire them | Off Stellar. Exponential's grades are not read by contracts; Chaos/Gauntlet set a protocol's own parameters rather than gate a user's deposit |
| Bluechip (SCF #44) | Factor-based safety ratings for stablecoins | Rates assets, not lending pools; a Bluechip grade could inform Vigil's collateral source quality |
| Blend pool status | On-chain deposit gate that follows backstop queues; changes only when someone calls `update_status()` | Says nothing about oracle or collateral configuration, the YieldBlox failure mode |

Rating-gated enforcement exists on EVM (Credora + Newton), and fixed-rule agent limits exist on Stellar (Tsuna, Policywright). What is new on Stellar is the combination of three things:
- ratings computed from each pool's oracle and collateral configuration
- signed into a Soroban registry by multiple publishers
- enforced by a policy in the user's own smart account, where deposits can be blocked but withdrawals never are


## Team
- **Göktuğ Oğuz Güngör: lead engineer.** Cloud & platform engineer. Built YieldPilot (yieldpilot.org; Stellar InstAward, $5K, [the team's announcement, 2026-11-01](https://x.com/AsteriaStellar/status/2116984521077727404)), Hourglass (github.com/Goguzgungor/hourglass), Soroban token streaming with linear, tranched and recurring streams and NFT receipts, on testnet with 111 contract tests, and Sonata, an API/MCP layer for Stellar contracts. During the grant Vigil is his main work (the plan takes 81% of his calendar time); Hourglass and Sonata get maintenance only. GitHub: github.com/Goguzgungor
- **Melike Keçelioğlu: product manager.** Technical Product Owner (London), ex-Borsa İstanbul, and a Stellar Türkiye ambassador. Product lead of Vestellar (Rise In × Stellar InstAward, $5K, [Stellar Türkiye's post, 2026-07-22](https://x.com/Stellar_Turkey/status/2079809008613863608)). In Vigil she runs the public methodology review (1.2), publisher outreach (2.3) and integration outreach (3.4). Her work is product and partnerships, not code.

## Deliverables

Indicative dates assume an award on **2027-01-11**; weeks are counted from the award. Everything listed under "What exists today" is excluded; each deliverable below is the work that remains. The plan is 19.5 effort-weeks in 24 calendar weeks (81%), with the audit submitted on the code that will be deployed.

### T0: 10% ($6,540), automatic

### T1 · MVP: 20% ($13,080). Weeks 1–6, by 2027-02-22
| # | Deliverable | Done when |
|---|---|---|
| 1.1 | **Ratings service v1.** Publishing every 30 minutes, a 90-day archive of every input and a verify script exist; v1 makes the record permanent, the check a one-line command, and covers all of DeFindex. | Every run, order books included, copied to a permanent public store outside our deployment, content-addressed. `npx vigil verify <run>` ships in the SDK and works without cloning the repo. Every vault and strategy created by the DeFindex factory is rated (today: 4 configured strategies). The API serves fresh ratings ≥99% of hours over 14 consecutive days. |
| 1.2 | **Methodology v1.0 + backtest suite.** The methodology is frozen at v2.5 until this review. | The v1.0 draft and its backtests are open for public comment for ≥3 weeks: announced on the Stellar developer Discord and the SCF forum, and sent to the Blend (Script3) and DeFindex (PaltaLabs) teams and to the risk projects listed above. Every comment is answered in a public changelog, and v1.0 is published with the changes and a new version number. Backtests cover ≥3 historical configurations with published inputs: YieldBlox before 22 Feb 2026 (exists), the backstop after the Comet drain, and one pool whose oracle changed. |
| 1.3 | **RiskRegistry v1.1.** | Every submission carries the engine version that produced it and the rating's eligibility flag, and `get_rating` returns both, so an owner's minimum can be pinned to a methodology and a not-eligible pool is refused whatever its score. Contract tests extended; deployed on testnet and used by the publisher. |

### T2 · Testnet: 30% ($19,620). Weeks 7–14, by 2027-04-19
| # | Deliverable | Done when |
|---|---|---|
| 2.1 | **RiskGate v1.** | Refuses ratings flagged not eligible or from an engine version the owner did not accept. Closes the known gap where the agent can transfer USDC directly to the pool without a `submit` (a submit-scoped ticket). Adds DeFindex vault deposit/withdraw support. Tested against a smart account deployed from OpenZeppelin `stellar-accounts` 0.8.0, which signs a different auth digest than today's deployed 0.7 account. Branch coverage of `enforce` ≥95%, plus property tests. **Code freeze for RiskRegistry v1.1 + RiskGate v1 in week 10.** |
| 2.2 | **Audit readiness.** | Audit Bank application submitted in week 10 on the frozen code, the exact code to be deployed, with threat model, invariants and test report. |
| 2.3 | **RiskRegistry run as a real M-of-N set.** The contract logic exists; this deliverable is the operation. Three publishers run by one team prove the operation, not independence: independence starts when an outside organization joins. | Testnet registry at threshold 2 with ≥3 publishers on separate keys and separate hosting (at least one outside Vercel), and an admin that is a multisig contract. Publisher client + runbook published, so an outside organization can join by registering one key; the teams listed above are invited, and any that join are listed. 30 days of publishing every 30 minutes, with ≤1% of runs missed. |

### T3 · Mainnet: 40% ($26,160). Weeks 15–24, by 2027-06-28
T3 has no testnet fallback. If the Audit Bank report arrives late, 3.1, 3.2 and 3.5 move with it, and T3 is claimed when they are met on mainnet. If the report has not arrived by week 20, 3.3 and 3.4 are delivered on schedule and we ask SCF in writing to extend 3.1, 3.2 and 3.5, rather than deploy unaudited contracts to mainnet.

| # | Deliverable | Done when |
|---|---|---|
| 3.1 | **Mainnet contracts.** | RiskRegistry and RiskGate deployed on mainnet within 2 weeks of the Audit Bank report, with all high and medium findings fixed and the report published. |
| 3.2 | **Mainnet publishing.** | ≥3 publishers live on the mainnet registry for ≥14 consecutive days, with fresh ratings ≥99% of hours. |
| 3.3 | **SDK v1 + integration guide.** SDK v0.1 exists (`packages/vigil-sdk`). | The SDK published on npm with a guide and a working example: a wallet built on `smart-account-kit` installs RiskGate on a smart account. |
| 3.4 | **External integration support.** The work is ours; whether an outside project ships it is theirs, so adoption is reported, not billed. | The RiskGate integration offered upstream as public pull requests to ≥2 open-source Stellar wallet or vault codebases (for example the `smart-account-kit` examples, or a DeFindex vault adapter), with the maintainers' responses linked. The public metrics page shows external API consumers and `get_rating` callers. Any outside production use is reported at T3 completion. |
| 3.5 | **YieldPilot mainnet beta as the reference integration.** | Capped beta (≤$500 per user, ≤50 users) running through RiskGate on mainnet, on smart accounts built from OpenZeppelin `stellar-accounts` ≥0.8, with ≥25 accounts protected by RiskGate and a public metrics page. It is the first real-funds use of the gate, and it shows integrators the full flow. |

## Budget (bottom-up)

Rates are within SCF's published rate benchmarks for Soroban and full-stack developers. The audit is not included; it goes through the Audit Bank. Göktuğ is the Soroban and full-stack engineer on all lines. Melike, as product manager, owns the non-engineering side of 1.2, 2.3 and 3.4; her time is not paid from this award. YieldPilot's InstAward funds the YieldPilot app itself: nothing in this budget pays for that work, and 3.5 covers only YieldPilot's RiskGate path on mainnet.

| Tranche | Deliverable | Role | Effort | Rate | Cost |
|---|---|---|---|---|---|
| T1 | 1.1 Ratings service v1 (permanent archive, verify in the SDK, DeFindex coverage, SLO) | Full-stack | 2 wk | $3,000 | $6,000 |
| T1 | 1.2 Methodology v1.0 + backtest suite | Risk/full-stack | 2 wk | $3,000 | $6,000 |
| T1 | 1.3 RiskRegistry v1.1 (engine version + eligibility) | Soroban | 1 wk | $3,500 | $3,500 |
| T2 | 2.1 RiskGate v1 | Soroban | 3 wk | $3,500 | $10,500 |
| T2 | 2.2 Audit readiness | Soroban | 1 wk | $3,500 | $3,500 |
| T2 | 2.3 Registry operations: publisher client, multisig admin, onboarding | Soroban | 2 wk | $3,500 | $7,000 |
| T3 | 3.1 Mainnet deploy + audit remediation | Soroban | 2 wk | $3,500 | $7,000 |
| T3 | 3.2 Publisher onboarding + monitoring | Full-stack | 2 wk | $3,000 | $6,000 |
| T3 | 3.3 SDK v1 + guide + example | Full-stack | 1.5 wk | $3,000 | $4,500 |
| T3 | 3.4 External integration support (upstream PRs, metrics page) | Full-stack | 2 wk | $3,000 | $6,000 |
| T3 | 3.5 YieldPilot mainnet beta | Full-stack | 1 wk | $3,000 | $3,000 |
| T3 | Infra: RPC, archive, hosting (6 months) | — | — | $400/mo | $2,400 |
| | **Total** | | **19.5 wk** | | **$65,400** |

Work by tranche: T1 $15,500, T2 $21,000, T3 $28,900. The tranche payouts are fixed at 10/20/30/40% of the total: $6,540, $13,080, $19,620 and $26,160. T0 covers T1's head start. There are no marketing, legal or contingency lines. The publisher, the 90-day archive with its verify script, and YieldPilot's use of the rating gate were built before applying and are not in the plan. Alerts come after month 6, and the audit is submitted on the code freeze.

## After month 6
- **Publishers.** A run's two testnet transactions above (9 graded ratings plus the execution pool's stand-in, in batches of 8 and 2; NR pools are not published) were charged 0.0037 XLM together (0.0028 + 0.0009). Every 30 minutes that is about 0.18 XLM a day per publisher, plus the RPC reads behind it. That is small enough for wallets and vault curators that already run Stellar infrastructure to carry themselves, which is the model the registry is designed for.
- **Engine and contracts.** Both stay open source, and the team maintains them through YieldPilot, which depends on them.
- **Hosted API.** The ratings API is served from cached runs; its cost fits YieldPilot's hosting.
- **Alerts.** Webhook and Telegram alerts on grade changes and stale ratings follow after month 6; until then the API and `get_rating` are the interface.

## Risks
- **Registry trust.** Ratings are only as good as the publisher set. The testnet registry is 1-of-1 today (our publisher, a dedicated testnet key), and T2 makes it ≥3 publishers with threshold 2 and a multisig admin.
- **Fail-closed deposits.** A stale registry blocks deposits. Withdrawals never depend on it.
- **Blend backstop recovery** is outside our control. Ratings stay meaningful either way.
- **Methodology changes.** Each engine version is documented with the reason for the change. v2.5 is frozen until the public review in 1.2. v2.3 had been announced as frozen; that was broken twice on 2026-11-02, both times for the liquidity rule HR10, after internal reviews of the live output: v2.4 added it, and v2.5 gave it a 6-hour window when it flipped between two runs. From 1.3 published ratings carry the version, so a consumer's threshold never changes meaning silently.
- **No outside commitments yet.** No integrator, methodology reviewer or second publisher has committed. The deliverables pay for work the team controls (the review process, the publisher operation, the integration code), and outside participation is reported as it happens.
- **Single engineer.** One engineer carries the plan at 81% of calendar time; the slack is in T2 and T3, where the external dependencies (Audit Bank, partners) sit.
- **Competition:** Alterscope may add on-chain enforcement. Vigil's contracts and ratings are open source and can consume Alterscope's or Oracle Shield's data as inputs.

