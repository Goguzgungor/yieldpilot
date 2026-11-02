# Vigil: competitor analysis

> **The current table is in the application:** `submission.md` → "How Vigil relates to existing work", rechecked against its sources on 2026-11-02. This file is the research of 2026-11-01, and parts of it are out of date: Riskon now gives YieldBlox C 58, Sentora and Upshift are live on Stellar, REAPP is not an OpenZeppelin policy project, and Tsuna's vaults are their own Soroban contracts. Findings made later are only in the application: Stenion, Tsuna, Credora + Newton, Webacy's vault ratings, the SCF #44 policy builders (Policywright, Crediolabs.ai, Gateway.fm), OpenZeppelin Monitor and Alterscope's smart-wallet sessions.

**Date:** 2026-11-01. All URLs below were accessed on this date.
**Method:**
- SCF submission pages, project sites and documentation were read.
- GitHub commit histories were checked with `gh api`.
- Public API endpoints were queried with `curl`.
- Blend on mainnet was only read and simulated; no tx was sent.
- A Stellar Ecosystem DB snapshot was used (lumenloop/stellar-ecosystem-db, commit `efaa048`, 2026-10-30). The search used mechanism keywords: risk, score, rating, monitor, alert, oracle, insur, audit, firewall, guard, health factor and others. It returned 172 matches in total.
- For the EVM players (Credora, Chaos, Gauntlet, Exponential, DeFi Safety, LlamaRisk, Block Analitica, Sherlock/Cantina, Forta), a single parallel research round was run. These rows are marked with †. I re-verified only the Hypernative date and Riskon myself.

> **Note on SCF amounts.** The "Total awarded" on the SCF project page and `awarded_total` in the DB often differ. Examples:
> - Oracle Shield: $120K / $36K
> - Orion: $122.2K / $73,333
> - Hoops: $150K / $116,667
>
> The DB value looks like **paid tranches**. This is an inference, not verified. The table gives both, as "page / DB".

---

## 0. What you need to know first

1. **Pool-level ratings for Blend already exist.** Evidence:
   - **Alterscope** (SCF #24 + #26, $137.6K) is live on Stellar mainnet. It covers Blend lending pools and offers an API and an MCP server aimed at agents. Its documentation has a "pre-deposit check" recipe: if the risk band exceeds the user's tolerance, the deposit is refused.
   - **Riskon** (no SCF funding, a small project) publishes a live API that today gives A–F grades to the Fixed V2 and YieldBlox V2 pools.
   - So the first half of the draft's sentence **"No pool-level, on-chain-enforceable rating exists on Stellar"** is wrong and should be removed.
2. **In this search I did not find:**
   - A system that writes ratings to Soroban and enforces them **in the user's smart account**.
   - A system that scores DeFindex vaults.

   This is a search result, not an absolute claim. It should not be used as "first/only" in the application.
3. **Alterscope's public OpenAPI spec** has "autonomous strategies" endpoints that work with Stellar smart wallets. Their structure:
   - `register_session` / `revoke_session` calls and a `policyJson.assetCaps[...].max_per_tx` limit.
   - An autopilot that supplies to Blend.
   - Capital flow is turned off by the `AUTONOMY_SHADOW_MODE_ENABLED` flag.

   This structure overlaps with both YieldPilot and Vigil's consumer story.
4. **Blend already has its own on-chain gate.** When the pool status is `Frozen`, deposits are closed. But this gate is lazy:
   - YieldBlox V2 is at `status 3` (On_Ice) today, and its backstop Q4W is 97.75%.
   - A simulation of `update_status()` returned `5` (Frozen). So deposits stay open until someone calls it.
   - Riskon gives the same pool an **"A"**.

---

## 1. Table

Abbreviations:
- **Level:** P = pool/market/vault level, A = asset or asset pair, Pr = protocol, W = wallet, address or transaction.
- **Enforcement:** whether the result blocks an on-chain decision.

### 1a. Stellar-native projects and those from the SCF DB

| Project | Level | Stellar coverage (Blend / DeFindex) | On-chain enforcement | Open source | Status (evidence date) | SCF funding (page / DB) |
|---|---|---|---|---|---|---|
| **Alterscope** (Solity Network UG) | P (Blend "lending pool metrics", a 1–5 risk band and factor scores per opportunity), A (oracle), Pr | **Live.** Blend connector: 24 opportunities, ~$170M TVL. Aquarius and SDEX too. **No DeFindex.** | None for ratings ("never holds assets, submits transactions"). A smart-wallet autopilot is in the spec, but in shadow mode. | **No.** Code is not public. The methodology is documented; the weights are hidden as "calibrated internally". | **Active.** `blend` connector `last_success` 2026-11-01T14:21Z. A new MD joined in September 2026. The docs portal opened on 2026-05-02. | #24 $38.4K + #26 $99.2K = **$137.6K** / $137.6K |
| **Riskon** (mericcintosun/riskon) | **P**: 2 Blend V2 pools, A–F, 4 factors | **Live.** Fixed V2 = "B" (47), YieldBlox V2 = **"A"** (30). No DeFindex. | None for pool ratings. The testnet contract only holds a wallet risk tier (per the repo description). | Code public, **no license file** | Active. Last push 2026-10-12, pool-rating commits 2026-07-15/16. The API responded on 2026-11-01. | Not found (the "SCF 2024 Q1" claim could not be verified) |
| **Hoops Finance** | P: AMM pool analytics, "risk-assessed vaults" (methodology not published) | Adapters for Aqua, Comet, Soroswap and Phoenix. The "Blend weighted pools and backstop" deliverable is "Ongoing" on the #30 page. | Strategy contracts (router/account) exist; no rating enforcement. | Contracts repo public, license not stated | Slowed down. Last commit 2026-02-11, last blog post 2025-07-28. FlashPool and Vaults still "TESTNET". | #29 $50K + #30 $100K = $150K / $116,667 |
| **DD** (Webacy) | W and token on Stellar. Vault ratings (0–100, A+–F) on EVM, but **not on Stellar**. | Stellar address and token risk in **beta**. Soroban is out of scope in the submission: "Maybe in the future". | None ("are not smart contracts themselves") | No | Active (vault docs screenshots 2026-04). Could not verify that the Stellar product went live. | #38 $150K / $150K |
| **Stellar Oracle Shield** (Sun Zu Lab) | **A**: a 0–100 score per `(base, quote)` pair → Healthy/Degraded/Unsafe | Testnet contract `CCMSDP…YE7P`. Blend and DeFindex are not mentioned by name. | **Yes, partly.** Protocols query `get_status`; the integrating protocol makes the decision. There is a single operator role; a 2-of-3 quorum is at the planning stage. | **Apache-2.0** | Active. v0.1.3 released 2026-08-26, last commit 2026-09-11. Mainnet is not in the README, although the T3 date was 2026-09-11. | #43 $120K / $36K |
| **Orion** (lightgatehq) | **W**: position, health factor, backstop Q4W exposure | Live on mainnet: Blend, Aquarius, Soroswap (FxDAO is mentioned on the page). No DeFindex. | None, read-only API | Adapters Apache-2.0 (`lidapters`) | Active. Changelog 2026-09-24, repo 2026-10-20. Free, 60 rpm. | #41 $122.2K / $73,333 |
| **DeRisk** (Carmine) | Early warning at credit and protocol level | The Stellar side is only a Futurenet event scraper | None | Repo public | **Dormant.** `derisk-stellar-events` last commit 2023-11-30. The site timed out on 2026-11-01. | #20 $50K / $50K |
| **Latch** (3000-Labs) | Not a risk product. C-address onboarding and an OZ smart account wallet (with policies). | OZ smart account infrastructure. A wallet that could host RiskGate. | Policy infrastructure, no risk data | Repo public, no license seen | Last commit 2026-05-15 | #41 $120K / $72K |
| **Hypernative** | W/contract: monitoring the user sets up. Not a rating. | **Yes.** An SDF tutorial (2026-07-16) reads `get_reserve()` on a Blend pool and sets up a utilization alert. | Alert actions include "contract invocations to run onchain events". Automatic pause on Stellar could not be verified. | No | Active (2026-07-16) | #26 $50K (Activation) |
| **Blockaid** | W/transaction/token/dApp | Transaction scanning in Freighter and Lobstr. Did forensics after YieldBlox (2026-05-20). | Warning or block in the wallet UI, not at contract level | No | Active (2026-05-20) | No SCF award found (SDF "partnership") |
| **Bluechip** | **A**: stablecoin letter grades (SMIDGE) | A Stellar wallet rating tool. USDC "B+", CETES "B+". | None. The page does not mention on-chain publishing. | Methodology public, code not stated | Awarded in #44. Activity not checked separately. | #44 $136.5K / $136.5K |
| **Dig** | Token risk flags, alerts, protocol metrics | Blend, Aquarius, Soroswap and DeFindex analytics | None | MIT (`dig-stellar`) | Active (push 2026-10-30) | #43 $75K / $75K |
| **Tezoro** | Internal market scoring. "Security Layer" is live on Ethereum, not on Stellar. | A vault with a Blend v2 adapter | Not stated | Stellar repo public, no license | Last push to the Stellar repo 2026-04-23. tezoro.io now shows the "Warren" brand. | #42 $143.8K / $143.8K |
| **Policywright** / **Gateway.fm OZ Accounts Policy Builder** | Static least-privilege OZ policy generation | OZ smart account | Policy yes, **no risk data** | Policywright repo public | #44 | Policywright: DB $33K ($55K on the page, a sub-agent's finding, I did not verify it). Gateway.fm: $98K. |
| **CertiK** #25, **CyVers** #26, **Merkle Science** #41, **Scorechain** #36, **Range** | W/address/transaction, KYT/AML | Stellar address and transaction side | None | No | Could not verify that their Stellar products shipped | #25 $50K, #26 ~$50K, #41 DB $82.8K, #36 $85K, Range #34 not verified |

### 1b. General and EVM players (†: single research round, not re-verified)

| Project | Level | Stellar coverage | On-chain enforcement | Open source | Status | SCF |
|---|---|---|---|---|---|---|
| **Credora** (now "Credora by RedStone") † | P/vault (aggregates Morpho markets into vault ratings), A | **None.** RedStone price feeds have been on Stellar since 2026-03-04; "Blend… preparing to integrate RedStone feeds". Credora ratings are not on Stellar. No Credora–Euler integration found. | On Morpho, only in the UI (with curator approval). No on-chain risk feed found. | Methodology public, code not | Active (2026-03) | None |
| **Chaos Labs** (Edge Risk Oracles) † | Market and parameter level | None | **Yes**: pushes parameters on-chain on Aave | No | Left Aave on 2026-04-06 | None |
| **Gauntlet** † | Market parameters, curated vaults | None | Through governance and the curator role | No | Active (~2026-04) | None |
| **Exponential.fi** † | **P** (A–F) | No grade for Blend. No grade shows on the DefiLlama Blend page. | None | No | exponential.fi redirects to yo.xyz/risk (308). The retail product closed on 2025-09-20. | None |
| **DeFi Safety** † | Pr (process quality) | None | None | Criteria public | Turned to consulting | None |
| **LlamaRisk** † | A/market | None | Through governance | Reports public | Active (2026-07) | None |
| **Block Analitica** † | Market/vault | None | Through the curator role | No | 2026 activity could not be verified | None |
| **Sherlock / Spearbit-Cantina** † | Audit; no monitoring product | Cantina is approved in the Audit Bank; it ran the Aquarius Soroban contest. No Soroban monitoring product. | — | — | — | Audit Bank (not an award) |
| **Forta Firewall** † | Transaction | None (EVM rollups) | At sequencer level | Partly | 2025 | None |

### 1c. Blend's and DeFindex's own tools

| Source | What it does | Rating / verified list? |
|---|---|---|
| Blend pool status (on-chain) | **Pool level, on-chain.** `update_status()` is open to anyone. Based on Q4W and `met_threshold` it sets status 3 (On_Ice: borrowing closed) or 5 (Frozen: borrowing and **deposits** closed). | Only a binary state, no score. **It is lazy:** on YieldBlox V2, with Q4W at 97.75%, the status is still 3. The simulation returns `5`. |
| blend-ui (Script3) | Status banners (On Ice, Frozen, oracle error). `.env.production` has **a single** `NEXT_PUBLIC_BLOCKED_POOLS` entry (`CBVOPI6…AKO7`). The default pool list is `MAINNET_V2_REWARD_ZONE` (4 pools). The user keeps their own "tracked pools" list. | No numeric risk score or "verified pools" list. Only a blocklist and the reward-zone default. |
| Blend docs "Choosing Pools" | Gives the user a checklist: backstop size, Q4W, collateral quality, risk parameters, oracle reliability, admin trust. | The assessment is left to the user. **This is the list Vigil automates.** |
| DeFindex (defindex-io / PaltaLabs) | Whitelisted strategies. The Manager and Emergency Manager can `pause` / `rescue` a strategy ("in collaboration with chain analysis tools"). Withdrawals are always open. The defindex.io/strategies page has Strategy, Type, Asset, TVL and APY columns. | **No risk score.** A natural consumer of Vigil, as a pause and rescue trigger. No LOI of any kind. |

---

## 2. The 5 closest competitors

### 1) Alterscope — the biggest threat
- **Overlap:**
  - A risk-data platform, funded twice by SCF, that covers Blend on Stellar live today.
  - Its target audience explicitly includes "automated strategies and agents". It offers an MCP server, webhooks and REST.
  - The "Score a vault before depositing" recipe in its documentation is agent code that refuses the deposit when the risk band exceeds the tolerance. This is the same as Vigil's off-chain half.
  - The Stellar autonomous-strategy endpoints in the spec (smart-wallet session, `max_per_tx` cap, Blend autopilot, fail-closed on `STALE_ORACLE`) are very close to YieldPilot's model.
- **Honest difference:**
  - **Closed source and paid** (Free, Analyst, Team, Enterprise). Ratings are not published on-chain; there is no enforcement, and the decision is "your strategy decides".
  - The depth of its Blend coverage appears in the docs as "Lending pool metrics". The deepest layer is Morpho; oracle classification is limited to "Morpho-style Chainlink adapters" for now.
  - `GET /v2/pool/CCCCIQ…/risk-scores` (YieldBlox V2) returned `no_risk_score_coverage`. Note: the ID format may be different.
  - DeFindex is not covered.
  - Data quality problems observed today: the yield cache is ~13 hours stale (`cache_age 46702`), the Aquarius average APY is an absurd value of 11,626%, and `data-manifest` returns an error.
- **For the application:** This difference should be presented not as "we are building what does not exist" but as "we are building **the open, on-chain one**".

### 2) Riskon — already publishes pool-level ratings on Blend
- **Overlap:** A live site that gives Blend V2 pools A–F grades and serves a JSON API. This is the concrete evidence for the objection "Pool-level rating for Blend exists".
- **Honest difference:**
  - Only 2 pools and 4 factors: utilization 35%, collateral factor 25%, HHI 25%, depth 15%.
  - **No** oracle source, backstop and Q4W, pool status or collateral market depth.
  - The result: it gives **"A"** to YieldBlox V2, whose on-chain status is On_Ice, whose Q4W is 97.75% and whose `update_status()` simulation returns Frozen, and "B" to Fixed V2.
  - No license, 4 stars, no SCF funding, no on-chain publishing.
- **For the application:**
  - It does not weaken the application as a competitor, but it rules out a "first" claim.
  - A public example of the argument "utilization/TVL-based scores show a frozen pool as safe". The same error as our YieldPilot `/api/scan` example.

### 3) Stellar Oracle Shield (Sun Zu Lab, SCF #43)
- **Overlap:** Architecturally the closest project.
  - An operator writes the score to a Soroban contract.
  - It has a staleness check (default 3,600 s).
  - Its documentation recommends that consumers fail closed.
  - Its Rust client crate is published.
- **Difference:**
  - It works at asset-pair level and is aimed at protocol developers. Vigil works at pool and vault level and is aimed at the depositor's smart account.
  - In Oracle Shield, the protocol writes the enforcement in its own contract. In Vigil, the user does it with an OZ policy.
  - Today it is on testnet with a single operator. Mainnet and 2-of-3 do not exist yet.
- **What a reviewer will ask:** "Why don't you add a pool key to Oracle Shield's contract?" The answer should be ready:
  - A pool rating's inputs are more than oracle health: backstop, status, collateral parameters, admin.
  - The consumer side is different: the user's policy, not the protocol.
  - Vigil will read Oracle Shield's `get_status` as an input for collateral pairs.

### 4) Hypernative (SCF #26)
- **Overlap:**
  - SDF's own tutorial shows how to read `get_reserve()` on a Blend pool and set up a utilization alert.
  - For Stellar it comes under an "ecosystem package", with access sponsored by the network (a sub-agent's finding).
  - Alert actions include an on-chain contract call.
- **Difference:**
  - Not a published rating, but monitoring that each customer sets up themselves.
  - Closed source. The result is not enforced in the user's account.
  - Automatic pause on Stellar could not be verified.
- **For the application:** Not a competitor, a channel. A drop in a Vigil rating could be a Hypernative alert condition.

### 5) DD / Webacy (SCF #38)
- **Overlap:** It has a mature vault rating product on EVM. Its outputs:
  - a 0–100 score and an A+–F grade
  - `listing_verdict`
  - `withdrawal_state`
  - ~20 sub-scores and an oracle weakest-link model

  Adapting it to DeFindex vaults is technically a short job. The team is already SCF-funded on Stellar.
- **Difference (today):**
  - The Stellar product is only address and token risk, in beta. Vault coverage is 6 EVM chains; no Stellar.
  - The submission explicitly puts Soroban out of scope.
  - Off-chain and closed.
- **Risk:** The chance that Webacy brings its vault ratings to Stellar within Vigil's T1–T2 window is real but not proven.

### Also: Blend's own pool status (not a "project", but the strongest objection)
- **Situation:** There is already an on-chain deposit gate at pool level (Frozen). Three honest answers explain why Vigil is needed:
  1. Status only looks at the backstop Q4W and the threshold. It does not look at the oracle and collateral configuration; the YieldBlox loss of 22 February 2026 was of this class (a pool configuration error, according to BlockSec and Halborn).
  2. Status is lazy. On YieldBlox V2, deposits are still open because nobody has called `update_status()`.
  3. There is no per-user threshold.
- **Caution:** (2) can be solved with a keeper. Vigil should not sell this as its own value; if it wants, it should add it as a single keeper deliverable.

---

## 3. Positioning paragraph (English, 148 words, ready to paste)

> Stellar already has off-chain risk data for Blend: Alterscope (SCF #24/#26) serves risk reads for Blend lending markets through an API, Riskon publishes letter grades for two Blend V2 pools, and Hypernative supports custom Blend monitors. Blend itself gates deposits on-chain through pool status, which follows backstop withdrawal queues. Vigil adds three things. It rates every Blend V2 pool and DeFindex vault from pool configuration: the oracle source behind each collateral, backstop size and queue, pool status and reserve parameters. It publishes signed ratings to a Soroban RiskRegistry from an M-of-N publisher set. And a RiskGate policy lets an OpenZeppelin smart account refuse new deposits when a rating drops or goes stale, while withdrawals always stay open. Vigil is designed to take Stellar Oracle Shield (SCF #43) pair-health scores and Blend's own status as inputs. Its users are wallets, DeFindex vault managers and agents, starting with our YieldPilot.

**Note:**
- "first", "only" and "no existing" were deliberately not used.
- The "DeFindex vault" rating will be derived from the Blend pools under the vault's strategies. This methodology should be written out in the application.
- Oracle Shield is only on testnet today. That is why the phrase "is designed to take" was chosen.

---

## 4. Claims I could not verify

1. **Alterscope Blend scores:** I could not see whether the Blend opportunities actually carry a risk band or factor scores.
   - Why: `/v2/yield/opportunities` requires an API key. `/v2/factors/opportunity/…` returned `catalog_unavailable`. I did not open an account.
   - The "Blend USDC reserve … elevated" line on the home page is labelled "illustrative".
2. **Alterscope autonomous strategies:** The Stellar endpoints were only seen in the OpenAPI spec. I could not verify whether they are live, which smart-wallet contract they use (OZ or their own) or which Blend pool they would supply to. `GET /v2/autonomous-strategies` requires auth.
3. **Alterscope ID mapping:** I do not know whether the `no_risk_score_coverage` result of the `risk-scores` query really means "no coverage", or whether Alterscope uses a different ID format for Blend pools.
4. **Riskon:** The "Selected for SCF 2024 Q1" claim and the information that the testnet contract only holds a wallet tier are a sub-agent's findings; I did not read the contract.
5. **Hypernative:** What the SCF #26 award covers (the page lists no deliverables) and whether an automatic on-chain response works on Stellar.
6. **Hypernative access:** The information that Stellar access is sponsored through an "ecosystem package" (an Alchemy article dated 2024, a sub-agent's finding).
7. **Oracle Shield mainnet:** The T3 deliverable (mainnet, 2-of-3 quorum, a named protocol integration). Its date was 2026-09-11; the README has no mainnet, so it looks late, but there is no confirmation from SCF.
8. **Webacy:** Whether its Stellar API has left beta, and whether the "≥2 Stellar protocol partners" target was reached.
9. **Hoops:** Whether there is a score behind the phrase "risk-assessed vaults", and whether the "Blend weighted pools and backstop" deliverable in #30 is finished. app.hoops.finance redirects to `dashboard-ui-dev.hoops.fi`.
10. **Funding differences:** What the differences between the DB `awarded_total` and the SCF page mean (the inference that they are paid tranches). The Policywright $55K and Merkle Science $138K values are a sub-agent's findings.
11. **† rows (EVM):** The Credora–Euler integration, the terms of Chaos Labs' exit from Aave, Exponential's closure statement (page blocked, only a search snippet), Block Analitica's 2026 activity.
12. **Other SCF projects:** Whether the Stellar products of CertiK, CyVers, Merkle Science and Range went live; Range's #34 award; whether Untangled Credio is on Stellar mainnet.
13. **Adjacent projects whose activity I did not check:** Blip (#28, contract monitoring), Solarkraft (#24/#29, runtime monitoring), SAFU (#44, wallet insurance pool), Trustline (#44, institutional access control and insurance), Cushion (#41), One Click (#32, "AI-powered risk assessments"), and Sentora's and Upshift's Stellar vaults. I saw no sign that any of them publishes pool ratings, but I did not examine them in depth.
14. **X (Twitter):** Posts could not be read (HTTP 402). The "last activity" column is based on GitHub, blog and API evidence.

---

## Sources (all accessed on 2026-11-01)

**Alterscope**
- https://www.alterscope.org/ · https://www.alterscope.org/agents · https://www.alterscope.org/curators · https://www.alterscope.org/about · https://www.alterscope.org/insights
- https://docs.alterscope.org/coverage · https://docs.alterscope.org/trust/methodology/pool-risk-scores · https://docs.alterscope.org/trust/methodology/limitations · https://docs.alterscope.org/recipes/score-vault-before-deposit · https://docs.alterscope.org/pricing · https://docs.alterscope.org/changelog · https://docs.alterscope.org/openapi-public.yaml
- https://api.alterscope.org/v2/yield/protocols · https://api.alterscope.org/v2/yield/connectors/status · https://api.alterscope.org/v2/yield/chains · https://api.alterscope.org/v2/pool/CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS/risk-scores · https://api.alterscope.org/v2/data-manifest
- https://communityfund.stellar.org/submissions/recam5gal7vWgPt9A · https://communityfund.stellar.org/submissions/rec9bGg7CKnZUW3tG

**Riskon:** https://github.com/mericcintosun/riskon · https://riskon.vercel.app/api/pools/ratings

**Hoops:** https://communityfund.stellar.org/submissions/rechiZHwFanNF1nnI · https://communityfund.stellar.org/submissions/recYojyYEHFK01KlM · https://hoops.fi/ · https://github.com/hoops-finance/contracts

**DD / Webacy:** https://communityfund.stellar.org/submissions/recpuas3WNh58u0RB · https://docs.webacy.com/essentials/stellar.md · https://docs.webacy.com/vault-ratings.md · https://docs.webacy.com/vault-risk-intelligence

**Stellar Oracle Shield:** https://communityfund.stellar.org/submissions/recQ4g4OKMNXnHQX4 · https://github.com/sunzu-lab/stellar-oracle-shield · https://www.sunzulab.com

**Orion:** https://communityfund.stellar.org/submissions/recPt6cTMzx8XmiNj · https://orionhq.run/changelog · https://orionhq.run/pricing · https://github.com/lightgatehq

**DeRisk:** https://communityfund.stellar.org/submissions/recWVVLF0ufdI0y0Z · https://github.com/CarmineOptions/derisk-stellar-events

**Latch:** https://communityfund.stellar.org/submissions/recUrEbIUnLVTIbra · https://github.com/3000-Labs/latch

**Bluechip:** https://communityfund.stellar.org/submissions/recbX8pYYdcArFEPe

**Tezoro:** https://communityfund.stellar.org/submissions/recGl3bJHP5TkDOj7 · https://github.com/tezoroproject/tezoro-yield-aggregator-stellar

**Dig:** https://github.com/mael-wnb/dig-stellar · https://getdig.ai

**Gateway.fm:** https://communityfund.stellar.org/submissions/recTFz7yIm9fWFHSx

**Hypernative:** https://stellar.org/blog/developers/monitoring-stellar-with-hypernative (published 2026-07-16) · https://communityfund.stellar.org/project/hypernative-ik0 †

**Blockaid:** https://blockaid.io/blog/73-quarantined-how-blockaid-and-stellar-validators-contained-a-10m-price-manipulation-attack † · https://blockaid.io/blog/stellar-bolsters-ecosystem-wide-security-with-blockaid †

**Credora / RedStone:** https://www.redstone.finance/blog/stellar-finally-gets-the-oracle-infrastructure-it-deserves/ † · https://forum.morpho.org/t/credora-network-risk-ratings-on-morpho/1652 † · https://docs.redstone.finance/docs/redstone-credora/faq/ †

**Chaos Labs:** https://www.theblock.co/news/defi/2026-04-06-top-aave-risk-manager-chaos-labs-exits-amid-governance-dispute-396458 † · https://chaoslabs.xyz/posts/aave-integrates-chaos-labs-edge-risk-oracles †

**Exponential:** https://defillama.com/yields/pool/ecf788e3-d2ef-4fdd-9ece-8a2d96226ddf † · https://help.exponential.fi/en/articles/12084709-how-to-transition-your-exponential-account-by-sept-20-2025 †

**Audit Bank:** https://stellar.gitbook.io/scf-handbook/supporting-programs/audit-bank/official-rules † · https://code4rena.com/audits/2025-02-blend-v2-audit-certora-formal-verification †

**Blend**
- https://docs.blend.capital/users/choosing-pools · https://docs.blend.capital/tech-docs/core-contracts/lending-pool/pool-management (github.com/blend-capital/docs-v2 @2026-10-07)
- https://github.com/blend-capital/blend-ui (@2026-10-26: `.env.production`, `src/utils/version.ts`, `src/components/pool/PoolStatusBanner.tsx`)
- Mainnet read and `update_status` simulation (no tx sent): `mainnet.sorobanrpc.com`, 2026-11-01T14:40Z
  - Fixed V2: status 3, Q4W 6.59%
  - YieldBlox V2: status 3, Q4W 97.75%, simulation result → 5

**DeFindex:** https://docs.defindex.io/advanced-documentation/risks-and-audits.md · https://docs.defindex.io/strategies/blend-autocompound.md · https://www.defindex.io/strategies

**YieldBlox incident:** https://blocksec.com/blog/yieldblox-dao-incident-on-stellar-oracle-misconfiguration-enabled-a-10m-drain · https://www.halborn.com/blog/post/explained-the-yieldblox-hack-february-2026

**Ecosystem DB:** https://github.com/lumenloop/stellar-ecosystem-db (local snapshot `efaa048`, 2026-10-30)
