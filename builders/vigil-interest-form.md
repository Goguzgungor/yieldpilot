# Vigil: SCF Interest Form taslağı

> `scf-interest-form-drafter` skill'inin formatında. Form İngilizce doldurulur. Referral isteyeceksen önce bu form gönderilmeli; referrer projeyi listeden isimle seçiyor.
> İçerik `vigil-application.md` ile aynı tutulmalı; birinde değişen diğerinde de değişmeli. Son eşitleme: 2026-11-02, engine v2.5, bütçe $65,400.

## Interest Form Draft: Vigil

**One-Line Description:** Open-source risk ratings for every pool of Blend's V2 and v2.1 deployments and for four DeFindex strategies built on them, signed every 30 minutes into a Soroban registry and enforced by an OpenZeppelin smart-account policy, so wallets and agents on Stellar stop depositing into a pool when its rating drops. Withdrawals always stay open.

**Project Description:**

Every Blend V2 pool's risk sits in its configuration: which oracle prices each collateral, how big the backstop is and how much of it is queued to leave, the pool status, and the reserve parameters. In February 2026 about $10.2–11M (gross) was drained from the YieldBlox pool through collateral priced from a thin SDEX market. Blend's docs leave these checks to the user. Apps that move user funds automatically, such as wallets, yield apps and AI agents, have no on-chain way to make them.

Vigil rates each pool from that configuration. Oracle sources are traced per asset, the manipulation cost of SDEX-priced collateral is modelled within the oracle aggregator's per-round limit, and a pool whose lenders could not withdraw in any read of the last 6 hours is not eligible. Every run is archived with everything it was computed from, and a script anyone can run recomputes each published hash. The ratings are signed into a Soroban registry built for an M-of-N set of publishers; today it has one, ours, and the grant makes it at least three with a multisig admin. A RiskGate policy, attached to the rules a smart account grants an app or agent, enforces three things: Blend calls must keep funds in the user's own account, token transfers may only pay the pool, and deposits need a fresh rating above the owner's minimum.

It is timely for two reasons. OpenZeppelin smart accounts are becoming the standard way to give apps and agents scoped, revocable permissions on Stellar. And the existing risk data for Blend (Alterscope, Riskon, Stenion, Hypernative monitors) cannot be enforced inside the user's account.

**Stellar Integration:**
- Two Soroban contracts:
  - `RiskRegistry`: signed ratings from a registered publisher set, with a threshold and a freshness check.
  - `RiskGate`: an OpenZeppelin `stellar-accounts` `Policy` that runs inside the smart account's `__check_auth`.
- OpenZeppelin smart accounts: context rules; Delegated (G-account) and External ed25519 signers; the spending-limit policy.
- Blend V2 and v2.1: pool, backstop and oracle-aggregator reads. On-chain enforcement of `submit`/`claim` arguments.
- DeFindex: strategy positions in Blend pools.
- Reflector and SEP-40 oracles; SDEX order books (Horizon) for SDEX-priced collateral.
- Today both contracts run on testnet and the rating engine runs on mainnet data.

**Team:**
- Göktuğ Oğuz Güngör: lead engineer. Built YieldPilot (yieldpilot.org), an autonomous yield agent on Stellar using per-user OpenZeppelin smart accounts; Stellar InstAward, $5K ([the team's announcement, 2026-11-01](https://x.com/AsteriaStellar/status/2116984521077727404)). Also built Hourglass, Soroban token streaming on testnet (github.com/Goguzgungor/hourglass). github.com/Goguzgungor
- Melike Keçelioğlu: product manager. Technical Product Owner, ex-Borsa İstanbul, and a Stellar Türkiye ambassador. Product lead of Vestellar (Rise In × Stellar InstAward, $5K; [Stellar Türkiye's post, 2026-07-22](https://x.com/Stellar_Turkey/status/2079809008613863608)). Runs Vigil's public methodology review, publisher outreach and integration outreach.

**Current Stage:** Testnet. The engine runs on mainnet data.
- RiskGate and RiskRegistry are deployed on testnet with 79 contract tests plus one wasm-level test, including a suite that runs against the deployed OpenZeppelin smart-account wasm.
- The rating engine (v2.5, 157 tests) rates all 13 pools deployed by Blend's V2 and v2.1 factories and 4 DeFindex strategies. On a reconstruction of the YieldBlox pool as configured before its February 2026 exploit, it gives grade E.
- The live deployment publishes the ratings to the testnet registry every 30 minutes and archives each run's inputs for 90 days; `scripts/vigil-verify.ts` recomputes every hash and re-rates every pool from the archive, without keys.
- On a real testnet smart account and Blend pool, an agent key without RiskGate could withdraw a user's position to another address. With RiskGate, that call, direct transfers out, borrows and low-rating deposits are all rejected, and withdrawals still work.
- YieldPilot wallets are owned by the user's own wallet; the seven older ones were migrated on 2026-11-02.
- Live: yieldpilot.org/ratings, yieldpilot.org/api/ratings. Code: github.com/Goguzgungor/yieldpilot (contracts in `contracts/`, engine in `src/lib/vigil/`)

**Requested Budget Range:** $50K–$100K (bottom-up estimate: $65,400 over 24 weeks; the audit goes through the Audit Bank)

---

### Draft Notes
- **Form gönderildiyse** bu dosya yalnızca kayıt; tam başvuru `submission.md`.
- **InstAward linkleri: ✅** Team satırlarında.
- **Ambassador ilişkisi: ✅** açıkça yazıldı.
- **"İlk/tek" iddiası yok.** Alterscope, Riskon ve Stenion zaten Blend'i puanlıyor; böyle kalsın.
- **M-of-N:** registry bugün 1-of-1; metin bunu söylüyor, değiştirme.
- **Referral:** önce formu gönder, sonra Ambassador Chapter / Rise In kontağına sor.
