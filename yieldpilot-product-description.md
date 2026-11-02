# YieldPilot · Stellar — Product Description

> **One-sentence definition:** An autonomous AI agent that hunts the best DeFi yield for your idle USDC day and night and automatically moves the money to the highest yield according to your risk tolerance — you set it up once, and the agent handles the rest.

- **Document type:** Product description (product overview) — product manager's perspective
- **Date:** 3 June 2026
- **Status:** Working MVP / hackathon demo
- **Network:** Stellar (Soroban) — yields are read from the real mainnet, transactions are executed with real txs on testnet (no real money)

---

## 1. Executive Summary

People have **stablecoins sitting idle** (USDC) in their wallets and on exchanges. Most of the time this money does no work at all, because finding the best yield, assessing the risk and constantly moving the funds to the right place is **a full-time job** and too technical for the ordinary user.

**YieldPilot** hands this job to an autonomous AI agent. The user deposits their money once and gives the agent a limited permission; from then on the agent continuously scans the market, picks the best risk-adjusted yield and moves the money there itself. The user does not have to approve each move one by one.

The core of the product comes down to three promises:

1. **Passive income, zero effort** — "set it once, forget it." The agent works 24/7.
2. **Safe delegation** — the agent **cannot take your money out**; it can move only between pre-approved yield pools, under a daily spending limit. Even if the server is compromised, the funds cannot be carried off.
3. **Transparency** — the agent shows what it is doing and why, on a live screen and in plain language. Not a black box, but an assistant you can follow.

YieldPilot is the original **YieldSeeker** concept, born on the Base network and an **ETHGlobal Agentic Ethereum 2025 finalist**, ported to the Stellar network and redesigned. The core commercial logic of moving to Stellar: the main lending protocol on Stellar, **Blend, has offered ~8%+ yield on USDC for months** — clearly above similar protocols on the Base/Ethereum side (2-5%). So the "yield hunter" thesis works better here.

---

## 2. Problem

**An idle stablecoin is missed yield.** Today hundreds of millions of dollars of USDC sit on-chain without producing any yield. A user who wants to put it to work runs into four separate walls:

| Obstacle | The difficulty the user faces |
|-------|------------------------------|
| **Complexity** | Dozens of protocols, constantly changing interest rates, risk parameters that are hard to understand. Which pool is safe, and which is a trap? |
| **Continuity** | The best yield is not fixed; it changes hourly. Tracking this by hand and moving the money is practically impossible. |
| **Trust** | Most automation solutions ask for your wallet's key. Nobody clearly guarantees "it can manage the money but cannot steal it". |
| **Risk blindness** | The oracle manipulation attacks on Stellar in 2026 (Blend, YieldBlox) showed that high yield is not always safe. The ordinary user cannot see this risk. |

Result: the yield opportunity **exists**, but most people **do not have** the time, knowledge and trust needed to reach it.

---

## 3. Solution

YieldPilot closes this gap between the user and DeFi yield with an **autonomous agent**. The product consists of three layers:

**1) The eye that keeps scanning.** The agent regularly scans the yield sources on Stellar (Blend and DeFindex today; more tomorrow) and reads each pool's current yield, size and health.

**2) The brain that decides.** After each scan, an AI model (Claude) picks the best move according to the user's risk tolerance. First a rule-based **risk score** eliminates risky/shallow/unhealthy pools; then the agent picks the highest yield among the remaining candidates and **justifies its decision in plain language** ("Best risk-adjusted yield is pool B, +Δ%. Moving.").

**3) The hand that executes.** If the decision is "move", the agent withdraws the money from the old pool and deposits it into the new one — with real blockchain transactions, without further approval from the user, but **within security limits drawn in advance**.

On the user's side the experience is very simple: connect your wallet → set it up once → watch the agent.

---

## 4. Target User

| Persona | Who | Need | YieldPilot's answer |
|---------|-----|---------|------------------------|
| **"The saver who wants passive earnings"** | A user who holds stablecoins but does not want to manage them actively | "I want my money to work, but I don't want to deal with it." | Set it up once and let the agent optimize continuously. |
| **"Yield hunter with no time"** | A user who knows DeFi and chases the best rate but cannot be at the screen 24/7 | "I don't want to miss the best rate." | The agent catches hourly opportunities; no manual tracking needed. |
| **"Cautious beginner"** | A user new to DeFi who is wary of risk | "Is my money safe? Will I lose it?" | Drain-protected permission + risk filter + transparent rationale. |
| **(Future) Institutional / treasury** | Teams that manage a stablecoin treasury | "Putting idle cash to work by policy, in an auditable way." | Rule-based, limited, traceable autonomous management. |

Common denominator: **"I want the yield, but not the management burden or the trust risk."**

---

## 5. Value Proposition

Four core benefits that set YieldPilot apart from its competitors and from "doing it by hand":

### 🔁 Set it up once, let the agent work
The user does a one-time setup (create an account, grant the agent permission, deposit money). After that they do not have to approve any move one by one. The agent chases the best yield even while the user sleeps.

### 🔒 Your money is entrusted not to the agent, but to rules
This is the heart of the product. The permission given to the agent is **limited and written into the chain**:
- The agent can move the money **only between pre-approved yield pools** — it **cannot send** it out to another address.
- There is a **daily spending cap** (5,000 USDC/day in the demo).
- Even if the server or the agent's key is compromised, the attacker **cannot steal** the funds — the worst they can do is put the money into an approved yield pool anyway.

This is the "full control never rests with the agent" principle turned into a product.

### 🧠 Transparent and explainable decisions
Every scan, every decision and every transaction is visible **in a live feed**. The agent explains in natural language why it moved (or why it did not). The user trusts not a black box but an assistant that **says what it is doing**.

### 🛡️ High yield ≠ blind risk
The agent does not blindly pick the highest rate. A **risk score** evaluates the pool's size (TVL), its utilization rate and its **oracle health**. Since the 2026 Stellar oracle attacks, pools flagged as unhealthy are excluded automatically. The user chooses a risk tolerance (cautious / balanced / aggressive); the agent stays within that frame.

### 💸 Gas/technical burden hidden
The user does not deal with transaction fees, blockchain mechanics or technical details such as "stroop". These are abstracted away in the background.

---

## 6. How It Works — User Journey

What the user sees is a four-step setup followed by a passive monitoring screen.

**Setup (one-time, ~four steps):**

1. **Connect the wallet** — The user connects their Freighter wallet.
2. **Create a smart account** — A personal "smart account" belonging to the user is created. (The money sits in this account, not with the agent.)
3. **Grant the agent permission** — A restricted rule is defined for the agent: it can manage only yield pools, with a daily limit. (This is where drain protection comes from.)
4. **Deposit & activate** — The user chooses how much USDC to entrust to the agent and hands it over to the autonomous loop.

**Afterwards (autonomous):**
- The agent scans the market periodically (or on demand).
- It picks the best risk-adjusted pool and moves the money if needed.
- All of this streams **on a live screen**: which pools are being watched, what the best yield is, what the latest decision was.

**Monitoring experience — "Living Network":**
The product's main screen shows the agent as a **live network map**: the agent at the centre, with the yield pools it watches around it as nodes. As scans run, the nodes come alive, decisions appear in a feed strip, and at the bottom sit live metrics such as "How many pools are being watched", "Best yield" and "Idle USDC". The aim: to turn an autonomous system into something that is not **a cold log screen** but **has a pulse and is enjoyable to watch**.

---

## 7. Core Features

| Feature | Benefit to the user | Status |
|---------|---------------------|-------|
| **Autonomous yield scanning** | Chases the best rate for you 24/7 | ✅ Working (real mainnet data) |
| **AI decision + plain rationale** | You understand what it does; not a black box | ✅ Working (Claude) |
| **Drain-protected permission** | The agent cannot steal your money; it only moves it to approved pools | ✅ Working (on-chain rule + daily limit) |
| **Per-user smart account** | Each user's funds are isolated in their own account | ✅ Working |
| **Risk score + oracle filter** | Protection from high-yield traps | ✅ Working |
| **Risk tolerance selection** | Cautious/balanced/aggressive — you are in control | ✅ Working |
| **Multi-protocol** | Not dependent on a single pool; more opportunities | 🟡 Blend + DeFindex active; Soroswap/Aquarius/Phoenix "coming soon" |
| **Live "Living Network" dashboard** | Watch the agent in real time, in an understandable way | ✅ Working |
| **Real on-chain transactions** | Not a demo: real tx hashes (testnet) | ✅ Working |
| **Gas abstraction** | The technical fee burden is hidden from the user | ✅ Working |

---

## 8. Differentiation — Why YieldPilot?

**Versus "doing it by hand":** A person cannot track hourly rate changes and move the money; the agent does.

**Versus ordinary yield aggregators:** Most aggregators run on static rules and **give no explanation**. YieldPilot decides with an AI and **justifies its decision in words** — trust and transparency are where it differs.

**Versus wallet-custody automations:** Many automation solutions take over control of the funds. YieldPilot's **drain-protected permission model, written into the chain,** guarantees that "the money stays with you and only moves between yield pools".

**Ecosystem timing:** Blend's **~8%+ USDC yield** on Stellar makes this product's commercial thesis stronger than on Base/Ethereum. In addition, Stellar's mature "smart wallet / restricted signer" infrastructure supports the secure agent model natively.

> **Market context:** Autonomous DeFi agents were the dominant theme of the hackathon and commercial scene in 2025-2026 (e.g. autonomous stablecoin yield agents on Base such as Giza ARMA reported billions of dollars in volume). YieldPilot is a **security-first take on this wave, brought to Stellar**.

---

## 9. Current Status (Honest Assessment)

YieldPilot is currently **a working MVP / hackathon demo**. It is important to be clear about what is real and what is still simulated:

**What is real:**
- The yield scan reads **real mainnet** Blend and DeFindex data (real ~4-8% USDC rates).
- The decision is made by a real AI model (Claude).
- Transactions are executed as **real Soroban testnet txs** (real tx hashes, verifiable).
- Each user gets a real personal smart account; the drain-protected permission is actually enforced on-chain.

**Not there yet (deliberately out of scope):**
- **No real money.** Execution is on testnet; no transactions are made with real funds on mainnet.
- **No production-grade audit.** A custom, audited smart contract (orchestrator/vault) is marked as a "production upgrade".
- **Narrow protocol surface.** Mostly Blend for now; DeFindex was added on the scanning side.

> **Why read mainnet + execute on testnet?** The Stellar testnet has a single, low-yield (~0.05%) pool; that would make the demo unrealistic. So the product **reads real yields from mainnet** but **executes safely on testnet** — it shows the user the real market without real-money risk.

---

## 10. Roadmap

| Stage | Goal | Product value |
|-------|-------|-------------|
| **Now (MVP)** | Mainnet scanning + testnet execution + secure agent + live dashboard | Proof of concept, demo, demonstration of the trust model |
| **Near term** | More yield sources (Soroswap, Aquarius, Phoenix) | A wider opportunity surface, better diversification |
| **Medium term** | Mainnet execution + audited smart contract (atomic rebalance) | Real yield with real money |
| **Medium term** | Strengthened risk model (oracle + liquidity-depth + audit filters) | Safer autonomy, institutional trust |
| **Long term** | User notifications, performance history/reporting, multi-asset | Loyalty, trust, institutional use |
| **Long term** | Third-party audit + community fund (SCF) path | Production readiness, sustainability |

---

## 11. Risks & Open Questions

**Product/market risks:**
- **Narrow DeFi surface:** Stellar's total DeFi size (~$235M) is relatively small; rebalancing diversity is not as rich as on EVM. The number of opportunities is limited.
- **Oracle/protocol risk:** High-yield pools can be attacked (this happened in 2026). The risk model has to be strengthened continuously — this is not a "set and forget" security decision.
- **Trust threshold:** Bringing the user to the point of "let the agent manage my money" is a behaviour change. Transparency and drain protection are the key to it, but it takes education/communication.

**Maturity risks:**
- On the Stellar side there is no ready-made "agent toolkit + DeFi action library"; protocol integrations are written by hand. This can slow down how fast new sources are added.
- Moving to production requires additional engineering and cost items such as an audit, a custom contract and mainnet signing.

**Open product questions:**
- What will the revenue model be? (performance fee / management fee / freemium?)
- Which yield sources should be added, and in what order? (Should the prioritization criterion be TVL, yield or security?)
- How much should the user be able to intervene in the agent's decisions? (Fully autonomous, or should there also be a "propose-approve" mode?)

---

## 12. Success Metrics (Proposal)

Key indicators that can be tracked to measure the product's success:

- **Activation:** What percentage of users who connect a wallet complete the setup and activate the agent?
- **Value entrusted (TVL):** Total USDC entrusted to the agents.
- **Yield gained:** The additional yield the agent earns for the user compared with "leaving it manually" (basis points).
- **Number / accuracy of autonomous moves:** The number of rebalances the agent makes and whether they actually moved the money to a better yield.
- **Trust signal:** How long users leave the agent active (retention) and the rate at which they increase the amount they entrust.
- **Security:** Zero fund loss / zero drain incidents (the most critical trust metric).

---

## 13. Summary

YieldPilot is a product that makes concrete, on the Stellar network, the idea of **"entrusting idle stablecoins to a secure and transparent AI agent and earning passive yield"**. Three things are at the centre of its value: **autonomy** (set it up once, let the agent work), **trust** (the agent cannot steal your money — the rules are on-chain) and **transparency** (you see what it does, live and in plain language).

Today, as a working MVP, it combines real market data, a real AI decision and real on-chain transactions (on testnet). The road ahead: more yield sources, real money on mainnet and a production-grade security audit.

---

*This document was prepared from a product manager's perspective by reviewing the project's codebase, the feasibility report (`yieldseeker-stellar-feasibility-report.md`), the design specs and the working MVP. For technical architecture details, see the spec and plan files under `docs/superpowers/`.*
