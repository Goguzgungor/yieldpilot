# Agentic Crypto Projects — Deep Research Report

> **Subject:** Agentic (autonomous AI agent) projects that were finalists/winners at Ethereum hackathons in the last ~12 months (June 2025 – June 2026) + prominent commercial agentic crypto projects in general (Giza ARMA, Olas, Wayfinder, etc.).
> **Date:** 1 June 2026
> **Scope:** 30 agentic projects, 4 hackathons/events + 6 flagship/commercial projects, corporate sponsorship context.

---

## Methodology & Confidence Note

This report is the output of a two-stage research process:

1. **Deep-research harness** (automated, multi-agent): The question was split into 5 search angles → **103 sub-agents**, **21 source fetches**, **98 raw claims extracted**, the most critical **25 claims** went through 3-vote adversarial verification (killing a claim required 2 refutations out of 3) → **22 confirmed, 3 rejected**. This forms the *verified core* of the report.
2. **Enrichment round** (3 parallel research agents): The details of the finalists that deep-research flagged as "open questions" — name verified but functional details not extracted — were pulled directly from the **ethglobal.com/showcase** (primary source) pages.

**Confidence labels:** Each claim carries a `[3-0]` (confirmed unanimously), `[2-1]` (confirmed by majority but not unanimously) or `[medium]` (inconsistent across sources) label. Unlabelled finalist details were verified from the primary ETHGlobal showcase pages.

> ⚠️ **Live data warning:** Traction figures (agent count, transaction volume, market cap) change after this report's date (June 2026). Market cap values are snapshots from ~early 2026. Token *price* is deliberately not given; only structural metrics (raise, market cap, user/agent count) are used.

---

## Executive Summary

**Agentic AI was the dominant theme of Ethereum hackathons in the June 2025 – June 2026 period.** According to attendee observations, ETHDenver 2026 turned into an **"AI × crypto expo"** more than a "DeFi event" `[3-0]`; ETHGlobal events (Agentic Ethereum 2025, New York 2025, New Delhi 2025, Cannes 2026) produced dozens of finalist/winning projects in autonomous AI agent categories.

**Highlights on the hackathon side:**
- **Etherius** — 1st place in the ASI Alliance track at ETHGlobal NYC 2025 (NFT intelligence agent with Fetch.ai uAgents + x402) `[3-0]`
- The 10 finalists of **Agentic Ethereum 2025**, selected from 518 projects `[3-0]`
- **DIVE** — ETHGlobal Cannes 2026 finalist, multi-agent (AI swarm) oracle for prediction markets `[3-0]`

**Verified on the commercial/flagship side:**
- **Giza ARMA** — autonomous stablecoin yield agent on Base (~$3.96B agentic volume reported) `[3-0 category / medium traction]`
- **Olas (Autonolas)** — "AI Agent App Store" (Pearl) + agent-to-agent marketplace (Mech Marketplace); 3,643 agents on-chain, 17.4M+ transactions, $13.8M raise `[3-0]`
- **Wayfinder** — Parallel Studios' omnichain agent protocol (PROMPT token) `[3-0]`
- **Almanak** — $8.45M institutional funding (Delphi Labs, HashKey, NEAR Foundation) `[3-0]`

**Corporate sponsorship was strong:** Hedera ($25K of a $50K pool at ETHDenver 2025 to the "AI & Agents" track) `[3-0]`, ASI Alliance / Fetch.ai+SingularityNET (several ETHGlobal tracks) `[3-0]`, and Kite AI (2026 global hackathon with Encode Club + ETHDenver bounty) `[3-0]` funded agentic builders.

---

## Quick Overview Table

| # | Project | Category | Event / Context | What it does (summary) | Chain |
|---|-------|----------|-------------------|-------------------|--------|
| 1 | **Etherius** | Hackathon 🏆 | ETHGlobal NYC 2025 — ASI Alliance 1st | NFT intelligence agent (natural language → OpenSea) | Base / uAgents |
| 2 | **MintCondition** | Hackathon 🏆 | ETHGlobal NYC 2025 — ASI Alliance 2nd | Multi-agent NFT valuation | Fetch.ai / MeTTa |
| 3 | **Waterfall** | Hackathon 🏆 | ETHGlobal NYC 2025 — ASI Alliance 3rd | OpenSea→Ocean data publishing agent | Fetch.ai / Ocean |
| 4 | **AIMen** | Hackathon | Agentic Ethereum 2025 Finalist | Onchain agent workflows in natural language | EVM / AgentKit |
| 5 | **Nimble** | Hackathon | Agentic Ethereum 2025 Finalist | Solver network + Morpho yield automation | Base / AgentKit |
| 6 | **SecretAgent** | Hackathon | Agentic Ethereum 2025 Finalist | Secret management + kill-switch for agents | Base |
| 7 | **Smol Universe** | Hackathon | Agentic Ethereum 2025 Finalist | World simulation with Twitter-clone agents | Base Sepolia |
| 8 | **Synapze** | Hackathon | Agentic Ethereum 2025 Finalist | One-click hosting for ElizaOS agents | EigenLayer AVS |
| 9 | **bouncer.ai** | Hackathon | Agentic Ethereum 2025 Finalist | Token launchpad with AI "bouncer" agents | Arbitrum |
| 10 | **PvPvAI** | Hackathon | Agentic Ethereum 2025 Finalist | Agentic prediction-market game | Base / Arbitrum |
| 11 | **Shaman** | Hackathon | Agentic Ethereum 2025 Finalist | "Onchain autopilot" agent platform | Arbitrum / MUD |
| 12 | **Streme.fun** | Hackathon 🏆 | Agentic ETH 2025 — Best Social Agent | Agent that deploys tokens via chat on Farcaster | Base |
| 13 | **YieldSeeker** | Hackathon | Agentic Ethereum 2025 Finalist | Autonomous yield hunter for idle USDC | Base |
| 14 | **DIVE** | Hackathon | ETHGlobal Cannes 2026 Finalist | AI swarm oracle for prediction markets | 0G / Hedera |
| 15 | **ENShell** | Hackathon 🏆 | Cannes 2026 — Chainlink CRE prize | On-chain "firewall" for agents | Sepolia / ENS |
| 16 | **maki** | Hackathon | ETHGlobal Cannes 2026 Finalist | Hardware-isolated DeFi agent | EVM / ERC-4337 |
| 17 | **ALMA** | Hackathon 🏆 | Cannes 2026 — Uniswap API 3rd | Autonomous liquidity (LP) rebalancing agent | Base / Uniswap v4 |
| 18 | **npmguard** | Hackathon 🏆 | Cannes 2026 — ENS 3rd | Agentic npm security auditor | Sepolia / 0G |
| 19 | **Corpus** | Hackathon | ETHGlobal Cannes 2026 Finalist | Turns a product into an autonomous "AI agent company" | Hedera / x402 |
| 20 | **Agent Colony** | Hackathon 🏆 | ETHDenver 2026 — Kite AI bounty 3rd | Agent built on agent-native payments/identity | Kite / x402 |
| 21 | **Giza ARMA** | Flagship | Commercial (Base mainnet) | Autonomous stablecoin yield agent | Base |
| 22 | **Olas (Autonolas)** | Flagship | Commercial (8 chains) | AI Agent App Store + A2A marketplace | Multi-chain |
| 23 | **Wayfinder** | Flagship | Commercial (Parallel Studios) | Omnichain autonomous agent protocol | Omnichain |
| 24 | **Almanak** | Flagship | Commercial ($8.45M raise) | DeFi smart-agent platform | Multi-chain |
| 25 | **Fetch.ai** | Flagship | Commercial (ASI Alliance) | uAgents + Agentverse + ASI:One | EVM |
| 26 | **Virtuals Protocol** | Flagship | Commercial (agent launchpad) | Autonomous agent tokenization + ACP | Base / Solana |
| 27 | **AIXBT** | Flagship | Commercial (on Virtuals) | Crypto-market intelligence agent | Ethereum |
| 28 | **Bankr** | Flagship | Commercial (Farcaster/Base) | Chat-based on-chain trading agent | Base |
| 29 | **Griffain** | Flagship | Commercial (Solana) | Autonomous on-chain agent network | Solana |
| 30 | **Theoriq (ChainML)** | Flagship | Commercial ($13M+ raise) | AI agent swarm coordination protocol | Multi-chain |

🏆 = won a specific track/prize &nbsp;·&nbsp; (the others have "finalist" status)

---

# PART 1 — Hackathon Finalist/Winner Agentic Projects

## 1.1 ETHGlobal New York 2025 — ASI Alliance Track (15–17 August 2025)

> ASI Alliance (Fetch.ai & SingularityNET) ran a track with a **$10,000** prize pool; the top three projects are below. `[3-0]`
> Source: [ASI Alliance recap](https://superintelligence.io/ethglobal-nyc-winners/) · [ETHGlobal prizes](https://ethglobal.com/events/newyork2025/prizes/artificial-superintelligence-alliance)

### 1. Etherius — 🏆 ASI Alliance 1st place
- **What it does:** AI-powered NFT intelligence agent; connects OpenSea data to natural-language queries and runs autonomously with x402 payment integration.
- **Team:** Mikhail Vaysman (@mikwiseman)
- **Tech stack:** Fetch.ai uAgents, ASI:One Mini, OpenSea MCP, x402, Coinbase Programmable Wallets
- **Sources:** [ethglobal.com/showcase/etherius-hk782](https://ethglobal.com/showcase/etherius-hk782) · [ASI recap](https://superintelligence.io/ethglobal-nyc-winners/)
- **Confidence:** `[3-0]`

### 2. MintCondition — 🏆 ASI Alliance 2nd place
- **What it does:** Multi-agent NFT valuation system running on multiple LLMs and **MeTTa symbolic reasoning**.
- **Team:** Alex Lu, Lindsay Zhang
- **Tech stack:** Fetch.ai agents, MeTTa, multiple LLMs
- **Source:** [ASI recap](https://superintelligence.io/ethglobal-nyc-winners/)
- **Confidence:** `[3-0]`

### 3. Waterfall — 🏆 ASI Alliance 3rd place
- **What it does:** Data publishing that connects Fetch.ai agents to the OpenSea MCP server and does smart-contract anchoring with Ocean Protocol.
- **Team:** Divyansh Goel, Dayitva Goel
- **Tech stack:** Fetch.ai agents, OpenSea MCP, Ocean Protocol
- **Source:** [ASI recap](https://superintelligence.io/ethglobal-nyc-winners/)
- **Confidence:** `[3-0]`

---

## 1.2 Agentic Ethereum 2025 — 10 Finalists (February 2025, online)

> ETHGlobal's hackathon **dedicated to autonomous AI agents**; 10 finalists were selected **from 518 projects**. This is direct evidence of a hackathon devoted to agentic AI in the Ethereum ecosystem. `[3-0]`
> Source: [ETHGlobal official tweet](https://x.com/ETHGlobal/status/1890448806975795550)
> *(The functional details of the 10 finalists below were verified from the primary ethglobal.com/showcase pages.)*

### 4. AIMen — 🏆 Coinbase AgentKit Pool Prize
- **What it does:** Lets you write reusable, onchain agentic workflows in natural language (the "AIM" language); turns commands such as "filter tokens on Uniswap" into autonomous blockchain workflows (without boilerplate or vendor lock-in).
- **Team:** microchipgnu (solo)
- **Tech stack:** EVM; AIM language + AIMX CLI, Coinbase AgentKit, The Graph, Tailwind, fly.io
- **Sources:** [showcase/aimen-xp5ma](https://ethglobal.com/showcase/aimen-xp5ma) · [GitHub](https://github.com/microchipgnu/agentic-ethereum-aim)

### 5. Nimble — 🏆 Coinbase AgentKit Pool Prize
- **What it does:** AI-agent-based intent/solver network; autonomously finds the best swap price using auction logic, and also does automatic yield optimization into Morpho vaults.
- **Team:** GitHub: PureBl00d
- **Tech stack:** Base (EVM); Coinbase AgentKit, CDP API, Morpho vaults, OpenAI API, Node.js
- **Source:** [showcase/nimble-d5y6f](https://ethglobal.com/showcase/nimble-d5y6f)

### 6. SecretAgent — 🏆 "Best Combination of AgentKit & OnchainKit" + AgentKit Pool Prize
- **What it does:** Secure secret management for crypto-native agents; with pay-as-you-go LLM keys the agent pays for its own LLM access from its wallet, secrets injected through a proxy are invisible to the agent + central monitoring & "kill-switch".
- **Team:** the dmno-dev organization
- **Tech stack:** Base; Coinbase CDP OnchainKit/AgentKit, Privy, Autonome, Next.js, Cloudflare Workers, DMNO
- **Sources:** [showcase/secretagent-nkz1u](https://ethglobal.com/showcase/secretagent-nkz1u) · [GitHub](https://github.com/dmno-dev/secret-agent)

### 7. Smol Universe
- **What it does:** World simulation full of AI clones of Twitter personalities; each character has its own wallet and autonomously tweets, travels, mints NFTs, finds jobs, sends money or goes bankrupt.
- **Team:** Javi Ezpeleta (@javitoshi)
- **Tech stack:** Base Sepolia; Hardhat, Ethers.js, Alchemy (gas subsidy), Google Gemini 2.0 Flash, Replicate, Next.js, Supabase
- **Sources:** [showcase/smol-universe-nqh0z](https://ethglobal.com/showcase/smol-universe-nqh0z) · [GitHub](https://github.com/JaviEzpeleta/smoluniverse-website)

### 8. Synapze — 🏆 AgentKit Pool Prize + EigenLayer "Eigen Agents" Prize
- **What it does:** "One-click" hosting/deploy platform for ElizaOS-based agents; brings agents online instantly and provides real-time monitoring + onchain integration.
- **Team:** GitHub: sekmet
- **Tech stack:** Coinbase AgentKit/OnchainKit, **EigenLayer SDK + AVS**, ElizaOS, TypeScript, Solidity + Rust, PostgreSQL
- **Sources:** [showcase/synapze-vijh5](https://ethglobal.com/showcase/synapze-vijh5) · [GitHub](https://github.com/sekmet/synapzeai)

### 9. bouncer.ai
- **What it does:** Token launchpad made up of AI "bouncer" agents; autonomous agents ask each user spoken questions and score their "vibe"/brand fit in real time to restrict token purchases — filtering out bots, snipers and uninformed speculators.
- **Team:** GitHub: GiantDole
- **Tech stack:** Arbitrum (Foundry + linear bonding curve, Uniswap); parallel "Knowledge/Vibe/Question" agents with LangChain, Autonome, Next.js, Privy, Spline
- **Sources:** [showcase/bouncer-ai-1sd06](https://ethglobal.com/showcase/bouncer-ai-1sd06) · [GitHub](https://github.com/GiantDole/ethglobal_agent)

### 10. PvPvAI — 🏆 Nethermind "Create your Agentic Future" 3rd + AgentKit Pool Prize
- **What it does:** Agentic prediction market game; players create AI agents with different personalities and have them debate tokens, while others bet on the decisions. Conversations can be influenced with "attack/mute/poison" actions (PvP mode).
- **Team:** GitHub org: agentic-2025
- **Tech stack:** Ethereum + Base + Arbitrum (Solidity/Foundry); Eliza-based framework, Autonome, Coinbase AgentKit (oracle)
- **Sources:** [showcase/pvpvai-d66a8](https://ethglobal.com/showcase/pvpvai-d66a8) · [GitHub](https://github.com/agentic-2025/pvp-ai-contracts)

### 11. Shaman
- **What it does:** "Onchain autopilot" — a platform for creating and deploying autonomous AI agents ("Shamans"); AI oracles run the TypeScript code the agent generates in a secure sandbox and interact with smart contracts and APIs without human intervention.
- **Team:** Interstation Research
- **Tech stack:** Arbitrum Sepolia; MUD (ECS World Contract + $ZUG token), Deno sandbox, IPFS/Filebase, Privy, Next.js
- **Sources:** [showcase/shaman-hyeav](https://ethglobal.com/showcase/shaman-hyeav) · [GitHub](https://github.com/Interstation-Research/shaman)

### 12. Streme.fun — 🏆 Autonome "Best Social Agent" 1st place
- **What it does:** Users get a token deployed by talking to the @streme agent on Farcaster; the agent autonomously deploys the token to Base from the user's message + profile. The tokens are "streamable" second by second through Superfluid and carry staking rewards.
- **Team:** @leeknowlton, @mthacks
- **Tech stack:** Base Mainnet; Coinbase AgentKit + OpenAI, Autonome, Neynar (Farcaster), Superfluid, Uniswap v3, Privy, Next.js
- **Sources:** [showcase/streme-fun-4dppy](https://ethglobal.com/showcase/streme-fun-4dppy) · [GitHub](https://github.com/streme-fun)

### 13. YieldSeeker — 🏆 AgentKit Pool Prize (+ later ETHGlobal "Spotlight")
- **What it does:** Base mini-app with an AI agent that hunts the best DeFi yield for idle USDC; continuously scans lending vaults and automatically moves the position to the highest yield according to the user's risk tolerance.
- **Tech stack:** Base; Coinbase AgentKit (Docker + Autonome), AWS Bedrock LLMs, Morpho + Spark.fi, The Graph, proprietary risk scoring
- **Sources:** [showcase/yieldseeker-crg12](https://ethglobal.com/showcase/yieldseeker-crg12) · [yieldseeker.xyz](https://www.yieldseeker.xyz/)
- **Confidence (finalist status):** `[3-0]`

---

## 1.3 ETHGlobal Cannes 2026 — Agentic Finalists (3–5 April 2026)

> Cannes 2026 announced **10 finalists**: ENShell, DIVE, maki, Défi, ALMA, npmguard, VEIL VPN, PaintGlobal, EVM PORST, Corpus. `[3-0]`
> Source: [crypto.news Cannes 2026](https://crypto.news/ai-agents-privacy-and-prediction-markets-define-ethglobal-cannes-2026-finalists/) · [ETHGlobal tweet](https://x.com/ETHGlobal/status/2040805013937877297)
> **Important note:** Only **6 of the 10 finalists are actually agentic AI** (below). The remaining 4 (Défi, VEIL VPN, PaintGlobal, EVM PORST) are not agentic — they are listed briefly at the end of the section. Finalist details were verified from ethglobal.com/showcase.

### 14. DIVE
- **What it does:** "Decentralized Intelligence Verification Engine" — an **AI swarm oracle** that verifies real-world truth for prediction markets; each outcome is resolved with 70% consensus through commit-reveal voting by a random committee of AI agents, each bound to a unique human through World ID (Sybil-resistant).
- **Team:** @derek2403, @avoisavo, @cedricctf11a, @ilovetofupeach
- **Prizes:** 🏆 World "Best use of Minikit 2.0" (1st) + Hedera "AI & Agentic Payments" + 0G "Best OpenClaw Agent" (2nd)
- **Tech stack:** "No-Solidity"; 0G Network (OpenClaw, iNFT/ERC-7857, 0G Compute TEE), Hedera (HTS, HCS), World ID 4.0 + World Agent Kit
- **Sources:** [showcase/dive-5hxbp](https://ethglobal.com/showcase/dive-5hxbp) · [GitHub](https://github.com/derek2403/cannes2026)
- **Confidence (finalist):** `[3-0]` (function description `[2-1]` in deep-research, later confirmed from the primary source)

### 15. ENShell — 🏆 Chainlink "Best workflow with Chainlink CRE"
- **What it does:** An **on-chain "firewall"** that stops AI agents from executing malicious transactions as a result of prompt injection attacks; it sits between agent intent and blockchain execution, and every transaction passes through 4 layers (Encrypt → Queue → Analyze → Human-in-the-Loop). The trust score and "strike" count are kept in ENS TXT records.
- **Team:** @CodeQuillClaim (in the press); GitHub org: 0xenshell
- **Tech stack:** Sepolia, Solidity, Chainlink CRE (WebAssembly), ENS (NameWrapper/ERC1155), ECIES, Claude, ERC-7730 clear-signing
- **Sources:** [showcase/enshell-6t95y](https://ethglobal.com/showcase/enshell-6t95y) · [enshell.xyz](https://enshell.xyz)
- **Verification note:** In deep-research, a secondary-source description was rejected `[0-3]` (it contained a wrong "ENS prize track" detail); the primary showcase fetch confirmed the correct description (Chainlink CRE prize).

### 16. maki
- **What it does:** AI agent for on-chain DeFi; private keys are locked in hardware and isolated so that the model cannot reach them. The LLM interprets intent, and deterministic local code executes sensitive operations; every transaction is simulated before signing and goes through policy + human approval.
- **Team:** Not listed on the showcase
- **Tech stack:** TypeScript, viem, ERC-4337, World AgentKit, **Apple Secure Enclave**, Ledger, Uniswap Trading API; Sepolia
- **Source:** [showcase/maki-564eg](https://ethglobal.com/showcase/maki-564eg)

### 17. ALMA — 🏆 Uniswap Foundation "Best Uniswap API Integration" (3rd)
- **What it does:** "Autonomous Liquidity Management Agent" — a fully autonomous rebalancing agent for Uniswap V4 concentrated liquidity positions; when a position goes out of range, it runs the burn → swap → mint cycle in a single atomic batch (the user signs EIP-712 only once).
- **Team:** @berkani4_yanis, @0xcs361
- **Tech stack:** Base; Uniswap Trading API, Calibur (EIP-7702), V4 SDK, Permit2, The Graph, Express+TS, Next.js
- **Sources:** [showcase/alma-07pzd](https://ethglobal.com/showcase/alma-07pzd) · [GitHub](https://github.com/yanisepfl/alma)

### 18. npmguard — 🏆 ENS "Most Creative Use of ENS" (3rd)
- **What it does:** Autonomous security platform against malicious npm packages; pulls a new package version and runs it through a multi-step AI audit pipeline (structural analysis, LLM risk score, agentic research, Docker-sandbox exploit test), then publishes the result on-chain in ENS subnames + IPFS.
- **Team:** GitHub: kryczkal
- **Tech stack:** Sepolia (ENS) + 0G Galileo testnet; Gemini 2.5 Flash, TypeScript/Hono, Docker sandbox, IPFS/Pinata, Chainlink CRE (5 min cron)
- **Source:** [showcase/npmguard-aeihd](https://ethglobal.com/showcase/npmguard-aeihd)

### 19. Corpus
- **What it does:** Turns any product into a **fully autonomous "AI agent company"** that runs GTM (go-to-market), trades and earns for you; a "Prime Agent" is deployed and runs market research + GTM + sales. Each Corpus is a tokenized asset; agents buy services from each other with x402 USDC micropayments.
- **Team:** GitHub: spock-mark1
- **Tech stack:** Hedera (HTS, CorpusRegistry), Circle Developer-Controlled Wallets + Arc + Nanopayments (x402), World ID, Next.js, Stagehand+Chrome, OpenAI function-calling (31 tools)
- **Sources:** [showcase/corpus-j7an5](https://ethglobal.com/showcase/corpus-j7an5) · [demo](https://corpus-protocol-web.vercel.app/)
- **Verification note:** In adversarial verification, deep-research rejected this description from a secondary source `[0-3]`; the primary showcase fetch confirmed the description. The contradiction is noted for transparency.

> **Cannes 2026's 4 NON-agentic finalists** (for completeness): **Défi** (gamified 1v1 DeFi trading dApp), **VEIL VPN** (TEE-based privacy/VPN protocol — 🏆 World ID + Arc + ENS prizes), **PaintGlobal** (NFC + NFT art/auction platform), **EVM PORST** (post-quantum cryptography primitive). These are outside the main count because they do not put an AI agent at the center.

---

## 1.4 ETHDenver 2026 (17–21 February 2026)

> At ETHDenver 2026, **AI × crypto was the dominant theme**; the event looked more like an AI expo than a DeFi meetup (Futurllama tracks, Sentient's Open AGI Summit, robotics projects). The judges rewarded projects that turned AI+crypto into mass use. `[3-0]`
> Sources: [crypto.news ETHDenver 2026](https://crypto.news/ethdenver-2026-fewer-side-events-more-ai-agents-and-builder-focus/) · [WuBlockchain observations](https://wublock.substack.com/p/ethdenver-2026-observations-side)

### 20. Agent Colony — 🏆 Kite AI bounty track 3rd place
- **What it does:** Agentic project that placed 3rd in Kite AI's "agent-native payments & identity, x402-powered" bounty track (built on payments/identity between autonomous agents).
- **Context:** Kite AI ETHDenver 2026 bounty ($10K partner track)
- **Tech stack:** Kite L1, x402
- **Sources:** [Devfolio (Kite AI)](https://ethdenver2026.devfolio.co/prizes?partner=Kite+AI) · [Kite AI YouTube](https://www.youtube.com/watch?v=pPMa0JN4d64)
- **Confidence:** `[2-1]` (solid but not unanimous; judging/prize record from YouTube + Devfolio)

> **Other notable ETHDenver 2026 projects** (judge-awarded, names unclear): a tip-incentivized "AI girlfriend" agent and **an AI-agent advertising protocol that proves task completion with on-chain validators** (Base sponsor 3rd place, developer "Justin"). `[3-0 theme]`

---

# PART 2 — Flagship / Commercial Agentic Crypto Projects

> These are not hackathon outputs; they are commercial agentic crypto projects that are live on mainnet (or institutionally funded).

### 21. Giza — ARMA
- **What it does:** Infrastructure that lets autonomous AI agents analyze markets, execute strategies and manage liquidity in DeFi. Its flagship **ARMA** is a **stablecoin yield agent** described as "Base's smart savings account"; it monitors lending protocols, detects interest-rate shifts and autonomously moves capital to the highest yield (Aave, Morpho, Compound, Moonwell).
- **Context:** Commercial (Base mainnet); ARMA launched in January 2025. Institutional use cases such as Re7 Capital were reported.
- **Chain/Tech stack:** Base; periodic APR scanning ("Smart Strategy Scheduling")
- **Traction:** According to Finbold, **~$3.96B agentic volume** (March 2026), 7,000+ agents, $300K+ in user assets, 10,000+ transactions; other measurements give 60,000+ ARMA agents, $40M+ AUA, 800k+ transactions.
- **Sources:** [gizatech.xyz](https://www.gizatech.xyz/) · [Chainwire (ARMA launch)](https://chainwire.org/2025/01/29/gizas-arma-breaks-new-ground-on-base-with-advanced-defi-automation/) · [Chainwire (Re7 Capital institutional)](https://chainwire.org/2025/05/29/giza-agents-go-institutional-re7-capital-embraces-self-driving-capital-for-defi-treasury-management/)
- **Confidence:** Category `[3-0]`; the "every lending protocol"/"real-time" absolutes `[2-1]`; traction figures **`[medium]`** (inconsistent across sources, partly self-reported).

### 22. Olas (Autonolas)
- **What it does:** Platform that lets users own their own AI agents (prediction, portfolio management, etc.) and earn income from them. The flagship consumer app **Pearl** is an "AI Agent App-Store"; there is also **Mech Marketplace**, a decentralized **agent-to-agent marketplace** where agents offer skills and hire other agents' services.
- **Context:** Commercial, multi-chain (8 chains). Raised **$13.8M** to launch Pearl (led by 1kx; Tioga, Sigil, Zee Prime, Spaceship DAO).
- **Traction (on-chain, verifiable):** **3,643 agents deployed**, 530 daily active agents, **17,492,536 total transactions**, 12,823,809 agent-to-agent transactions (methodology verifiable through The Graph subgraphs + public GraphQL).
- **Sources:** [olas.network](https://olas.network/) · [Mech Marketplace](https://olas.network/mech-marketplace) · [olas.network/data (methodology)](https://olas.network/data) · [SiliconANGLE](https://siliconangle.com)
- **Confidence:** `[3-0]` (both the platform description and the on-chain traction).

### 23. Wayfinder
- **What it does:** An **omnichain AI agent protocol** ("self-driving wallet") that lets autonomous agents navigate blockchains, execute transactions and read on-chain state through the **Paths** and **Shells** primitives.
- **Context:** Commercial; founded by **Parallel Studios** (Parallel TCG + Echelon Prime ecosystem).
- **Token (PROMPT):** three functions — (1) premium agent access, (2) staking that secures Path verification (slashing for bad Paths), (3) coordination with Echelon Prime through the PRIME token (a share of the supply was airdropped to PRIME holders/Parallel players).
- **Sources:** [DEXTools guide](https://www.dextools.io/tutorials/what-is-wayfinder-prompt-ai-agent-omnichain-protocol-guide-2026) · [Bankless](https://bankless.com/read/wayfinder-prompt-token) · [Tiger Research](https://reports.tiger-research.com/p/wayfinder-eng)
- **Confidence:** Protocol/token description `[3-0]`. ⚠️ The claim of a specific **chain/roadmap list** (Ethereum/Base/Arbitrum/Optimism + Solana/Cosmos) was **rejected** `[0-3]` — the "omnichain" description is correct, but that specific list could not be verified.

### 24. Almanak
- **What it does:** DeFi smart-agent platform (AI-powered DeFi strategies).
- **Context:** Commercial; raised **$8.45M** (the round closed ~17 August 2025).
- **Investors:** Delphi Labs, HashKey Capital, NEAR Foundation (+ BanklessVC, RockawayX, Matrix Partners, AppWorks, Sparkle VC, Shima Capital).
- **Sources:** [ainvest.com](https://www.ainvest.com/news/almanak-secures-8-45m-accelerate-ai-driven-defi-strategies-2508/) · [PANews](https://www.panewslab.com/en/articles/0a96aec3-8f50-4de0-bd4b-9dacb7237d1a)
- **Confidence:** Funding `[3-0]`. *(Note: product/agent functional details were not independently verified — only the funding is confirmed.)*

### 25. Fetch.ai (ASI Alliance)
- **What it does:** Platform where autonomous software agents make decisions independently and carry out tasks; agents negotiate and transact without human intervention. **uAgents** (development framework), **Agentverse** (agent marketplace/discovery), **ASI:One** (Web3-native LLM).
- **Context:** Commercial; in 2024 Fetch.ai + SingularityNET + Cudos → **Artificial Superintelligence Alliance (ASI)** and the merged $ASI (formerly FET) token. (Ocean Protocol left the alliance in October 2025.)
- **Team:** Fetch.ai (CEO Humayun Sheikh)
- **Traction:** Market cap ~**$617M** (~#79, CMC). Agentverse at the end of 2025: ~2.7M registered agents, ~160M agent messages (independent source — the official docs do not give an agent count).
- **Sources:** [docs.agentverse.ai](https://docs.agentverse.ai/documentation/getting-started/agentverse-marketplace) · [CoinMarketCap](https://coinmarketcap.com/currencies/artificial-superintelligence-alliance/)

### 26. Virtuals Protocol
- **What it does:** The largest decentralized **launchpad** for tokenizing autonomous AI agents ("Shopify for AI agents"). Agents plan autonomously with the **GAME** framework; through **ACP** (Agent Commerce Protocol), agents discover and hire each other and pay on-chain.
- **Context:** Commercial (pivoted from PathDAO in January 2024).
- **Team:** Jansen Teng (CEO), Weekee Tiew
- **Chain/Tech stack:** Base (main), Ethereum, Solana, Ronin, Arbitrum; GAME (Goal-Action-Mind-Engine); Llama 3.3 / DeepSeek / Qwen models; ACP marketplace
- **Traction:** Market cap ~**$488M** (~#110). **18,000+** tokenized agents deployed. Historical peak: >$4.5–5B (January 2025).
- **Sources:** [virtuals.io](https://www.virtuals.io/) · [whitepaper](https://whitepaper.virtuals.io/about-virtuals/agent-tokenization-platform) · [CoinGecko](https://www.coingecko.com/en/coins/virtual-protocol)

### 27. AIXBT
- **What it does:** Real-time **crypto-market intelligence agent** running on Virtuals; analyzes Crypto Twitter discussions + social signals, market indicators, news and on-chain analytics to detect high-momentum opportunities early; produces content on X as an autonomous "influencer" agent.
- **Context:** Commercial; launched in the Virtuals ecosystem in November 2024.
- **Chain:** Ethereum (contract); Virtuals infrastructure
- **Traction:** Market cap ~**$28.7M** (~#635). Historical ATH ~$800M (16 Jan 2025); ~$115.7M (9 Sep 2025, top-5 Virtuals agent token).
- **Sources:** [CoinMarketCap](https://coinmarketcap.com/currencies/aixbt/) · [Messari profile](https://messari.io/project/aixbt-by-virtuals)
- **Note:** The founder/team name and follower count **could not be verified** independently.

### 28. Bankr
- **What it does:** AI agent that does on-chain trading through natural-language chat commands; with a Farcaster/X message such as "@bankrbot buy $100 ETH", it handles all on-chain transactions, wallet authorizations and routing.
- **Context:** Commercial; the $BNKR token was issued by the agent on Farcaster through a fair launch.
- **Chain:** Base (primary); some sources also report Solana/Polygon (**partly unverified**). x402 payment protocol.
- **Traction:** **217,000+** holders in 2026; BNKR 24h volume ~$21M+.
- **Sources:** [bankr.bot](https://bankr.bot/) · [KuCoin analysis](https://www.kucoin.com/news/articles/a-deep-dive-into-the-ai-agent-bankr-and-its-ecosystem-token-bankrcoin-bnkr)
- **Note:** The founder/company name and raise **could not be verified** (fair launch).

### 29. Griffain
- **What it does:** Autonomous AI agent network / "Agent Engine" on Solana; turns natural-language commands into on-chain transactions and carries out wallet management, token trading, NFT minting and DeFi strategies. Users can deploy their own Personal Agents (ready-made agents such as Agent Baxus, GM, Sniper).
- **Context:** Commercial (November 2024 launch); originated at a Solana hackathon, then became a mainnet product; backed by Anatoly Yakovenko.
- **Team:** Founder Tony Plasencia (the rest of the team is partly anonymous)
- **Traction:** Market cap **$280M+**, daily volume **$40M+**; in December 2024, the 2nd largest AI agent launchpad at ~$274M; 1M+ automated transactions.
- **Sources:** [griffain.com](https://griffain.com/) · [Solana Compass](https://solanacompass.com/projects/griffain)
- **Note:** VC raise **could not be verified**.

### 30. Theoriq (ChainML)
- **What it does:** Decentralized protocol that coordinates AI agent **swarms**; agents/swarms collaborate to autonomously carry out financial tasks such as on-chain liquidity provision and yield optimization ("Agentic Economy"/DeFAI).
- **Context:** Commercial infrastructure; ChainML (2022), and Theoriq is its "agentic base layer".
- **Team/Investors:** ChainML, CEO Ron Bodkin; Hack VC (lead), Chainlink, IOSG, HashKey, Foresight, HTX Ventures, etc.
- **Traction/Funding:** ~**$13.2M** total — $4M Seed (2022), $6.2M Seed+ (May 2024), ~$3M public sale (August 2025) @ ~$75M valuation.
- **Sources:** [theoriq.ai](https://www.theoriq.ai/) · [crypto-fundraising.info](https://crypto-fundraising.info/projects/chainml/)
- **Note:** The public-sale amount is inconsistent across sources ($2M↔$3M) — **partly unverified**.

---

# PART 3 — Hackathon Ecosystem & Corporate Sponsorship

Corporate sponsorship of agentic builders is the structural story of this period:

- **Hedera** — at ETHDenver 2025, "AI & Agents" was one of three tracks with $50,000 in total prizes; it was **the largest single track at $25,000**, and Hedera introduced an Agent Kit SDK. `[3-0]` ([Hedera blog](https://hedera.com/blog/announcing-the-winners-of-eth-denver-2025-hedera-bounties/))
- **ASI Alliance (Fetch.ai + SingularityNET)** — tracks at ETHGlobal **New York 2025** ($10K) and **New Delhi 2025** ($10K, 26–28 Sep); they required uAgents, Agentverse, ASI:One, MeTTa. `[3-0]` ([New Delhi winners](https://community.superintelligence.io/t/meet-the-winners-ethglobal-new-delhi-with-fetch-ai-and-singularitynet/123) · [Fetch.ai event](https://fetch.ai/events/eth-global-new-delhi))
- **Kite AI** — **Kite AI Global Hackathon 2026** (with Encode Club, ~27 March–26 April 2026); three tracks: Agentic Commerce, Agentic Trading & Portfolio Management, Novel. Kite positions itself as an L1 "that provides identity, payments, governance and verification for autonomous agents on-chain"; funded by Coinbase Ventures. Also the ETHDenver 2026 bounty track (Agent Colony 3rd place). `[3-0]` ([Encode Club](https://www.encodeclub.com/programmes/kites-hackathon-ai-agentic-economy))

---

## Verification Methodology & Caveats

**Statistics (deep-research):** 5 angles · 21 source fetches · 98 claims extracted · 25 claims verified · **22 confirmed, 3 rejected** · 103 agent calls · ~2M tokens · ~23 min.

**Rejected claims (for transparency):**
1. ❌ ENShell's "ENS prize track ($4,000 / Best ENS Integration for AI Agents)" detail `[0-3]` — wrong; ENShell actually won the **Chainlink CRE** prize (corrected from the primary source).
2. ❌ Corpus's "autonomous AI agent company" description from a secondary source was rejected `[0-3]` — but the primary **ethglobal.com/showcase** page confirmed this description (the contradiction is noted above).
3. ❌ Wayfinder's specific chain/roadmap list (Ethereum/Base/Arbitrum/Optimism + Solana/Cosmos) `[0-3]` — the "omnichain" description is correct, but that list could not be verified.

**`[2-1]` (solid but not unanimous) claims:** Giza ARMA's "every lending protocol"/"real-time" absolutes; Agent Colony's ETHDenver 2026 3rd place; DIVE's function description (later confirmed from the primary source).

**Source quality:** Some company descriptions (Giza, Olas, Wayfinder home pages) are marketing copy; the core facts were confirmed through independent journalism (CoinDesk, SiliconANGLE, The Block, crypto.news) or a verifiable on-chain methodology (Olas/data). Some primary URLs returned only a title because of JS rendering; verification relied on organizer X/LinkedIn posts and search-engine extracts.

**Date nuances:** ETHGlobal NYC is given as 15–18 in one source and as 15–17 August 2025 in the official calendar (insignificant). **The 2025 (July) and 2026 (April) events in Cannes are separate** — the finalist lists should not be mixed up; the list in this report is for 2026.

---

## Open Questions (For Deeper Research)

1. **Hackathon → productization:** Did any of the winners, such as Etherius, MintCondition, Waterfall, DIVE, Agent Colony, receive funding or gain mainnet traction after the hackathon? (Only the hackathon results were verified.)
2. **Almanak's product:** Only Almanak's funding was verified; its agent product/functional architecture should be researched separately.
3. **Named ETHDenver 2026 winners:** Full name/team/stack details of the projects mentioned only at theme level, such as the "AI girlfriend" and the "AI-agent advertising protocol".
4. **Other 2025–2026 ETHGlobal events:** Agentic finalists at events such as Taipei, Bangkok, Brussels did not come up in this round — they need a separate deep dive.

---

## References (Primary & Secondary)

**Hackathon — primary:**
- ETHGlobal official tweet (Agentic ETH 2025 finalists): https://x.com/ETHGlobal/status/1890448806975795550
- ASI Alliance NYC winners: https://superintelligence.io/ethglobal-nyc-winners/
- ASI Alliance New Delhi winners: https://community.superintelligence.io/t/meet-the-winners-ethglobal-new-delhi-with-fetch-ai-and-singularitynet/123
- ETHGlobal Cannes 2026 announcement tweet: https://x.com/ETHGlobal/status/2040805013937877297
- ethglobal.com/showcase (each finalist project page — linked above)
- Hedera ETHDenver 2025 bounty winners: https://hedera.com/blog/announcing-the-winners-of-eth-denver-2025-hedera-bounties/
- Encode Club / Kite AI Hackathon 2026: https://www.encodeclub.com/programmes/kites-hackathon-ai-agentic-economy

**Hackathon — secondary/journalism:**
- crypto.news (Cannes 2026 finalists): https://crypto.news/ai-agents-privacy-and-prediction-markets-define-ethglobal-cannes-2026-finalists/
- crypto.news (ETHDenver 2026): https://crypto.news/ethdenver-2026-fewer-side-events-more-ai-agents-and-builder-focus/
- WuBlockchain (ETHDenver 2026 observations): https://wublock.substack.com/p/ethdenver-2026-observations-side

**Flagship projects:**
- Giza: https://www.gizatech.xyz/ · https://chainwire.org/2025/01/29/gizas-arma-breaks-new-ground-on-base-with-advanced-defi-automation/
- Olas: https://olas.network/ · https://olas.network/data
- Wayfinder: https://reports.tiger-research.com/p/wayfinder-eng · https://bankless.com/read/wayfinder-prompt-token
- Almanak: https://www.ainvest.com/news/almanak-secures-8-45m-accelerate-ai-driven-defi-strategies-2508/
- Fetch.ai: https://docs.agentverse.ai/ · https://coinmarketcap.com/currencies/artificial-superintelligence-alliance/
- Virtuals: https://www.virtuals.io/ · https://www.coingecko.com/en/coins/virtual-protocol
- AIXBT: https://coinmarketcap.com/currencies/aixbt/
- Bankr: https://bankr.bot/
- Griffain: https://griffain.com/ · https://solanacompass.com/projects/griffain
- Theoriq: https://www.theoriq.ai/ · https://crypto-fundraising.info/projects/chainml/
- Sector overview: https://www.theblock.co/post/344635/research-ai-agent-sector-overview · https://www.dwf-labs.com/research/462-the-rise-of-virtual-consciousness-15-top-ai-agent-projects-to-watch

---

*The report was produced with a multi-agent deep-research harness (103 agents, adversarial verification) + 3 parallel primary-source enrichment agents. Confidence labels and "could not be verified" markers have been kept — for critical decisions, confirm the marked sources directly.*
