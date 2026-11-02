# Vigil SCF application: builders packet

The public packet for the SCF Build Award application for **Vigil** (by the YieldPilot team), current as of **2026-11-02, engine v2.5**.

**Start with [`submission.md`](submission.md).** It is the application text as it will be submitted, in English. Every claim in it links to its evidence.

## Files

| File | What it is |
|---|---|
| [`submission.md`](submission.md) | The application as submitted |
| [`vigil-interest-form.md`](vigil-interest-form.md) | SCF interest form draft, kept in line with the application |
| [`vigil-competitors.md`](vigil-competitors.md) | Competitor research of 2026-11-01 (Alterscope, Riskon, Hypernative and others). The current comparison, with Stenion, Tsuna and Credora + Newton, is in `submission.md` |
| [`team/`](team/) | One profile per team member, with the InstAward evidence |

The working draft, review rounds, outreach plan and old drafts stay with the team and are not in the repo.

## Links

### InstAwards

| Project | Award | Public evidence |
|---|---|---|
| YieldPilot (Göktuğ) | Stellar InstAward, $5,000 | [The team's announcement on X, 2026-11-01](https://x.com/AsteriaStellar/status/2116984521077727404) |
| Vestellar (Melike) | Rise In × Stellar InstAward, $5,000 | [Stellar Türkiye's post on X, 2026-07-22](https://x.com/Stellar_Turkey/status/2079809008613863608) · [Lumen Loop / Rise In article, 2026-07-23](https://lumenloop.com/news/melike-kecelioglu-built-vestellar-stellar) |

Melike is a Stellar Türkiye ambassador, and the application says so.

### Team

| | Role | Links |
|---|---|---|
| Göktuğ Oğuz Güngör | Lead engineer: all Soroban and full-stack work | [GitHub](https://github.com/Goguzgungor) · [Hourglass](https://github.com/Goguzgungor/hourglass) · [Sonata](https://github.com/Goguzgungor/sonata) |
| Melike Keçelioğlu | Product manager: methodology review, publisher and integration outreach; not paid from this award | [GitHub](https://github.com/melkecelioglu) · [Site](https://melkecelioglu.github.io/) · [X](https://x.com/melkecelioglu) |

### Product

| | |
|---|---|
| Live app | [yieldpilot.org](https://yieldpilot.org) |
| Ratings page | [yieldpilot.org/ratings](https://yieldpilot.org/ratings) |
| Ratings API | [yieldpilot.org/api/ratings](https://yieldpilot.org/api/ratings) (add `?inputs=1` for the full inputs) |
| Run archive (90 days) | [yieldpilot.org/api/ratings/runs](https://yieldpilot.org/api/ratings/runs); one run with everything it was computed from: `?at=<computedAt>` |
| Source (Apache-2.0) | [github.com/Goguzgungor/yieldpilot](https://github.com/Goguzgungor/yieldpilot), branch `feat/yieldseeker-mvp`: contracts in `contracts/`, engine in `src/lib/vigil/`, SDK in `packages/vigil-sdk/` |
| Methodology | [`docs/vigil/methodology.md`](https://github.com/Goguzgungor/yieldpilot/blob/feat/yieldseeker-mvp/docs/vigil/methodology.md): factors, hard rules, live results (§7), backtest (§8), limitations (§9), version history (§10) |
| Legacy wallet migration | [`docs/legacy-migration-2026-11-02.md`](https://github.com/Goguzgungor/yieldpilot/blob/feat/yieldseeker-mvp/docs/legacy-migration-2026-11-02.md) (21 testnet transactions) |

### On-chain (testnet)

| | |
|---|---|
| RiskRegistry | [`CB4LXLCCD7YDND5FBVXPKPHUQMF7JFSDRVXHG7ZZTWWNPJ6WDCXDNDF6`](https://stellar.expert/explorer/testnet/contract/CB4LXLCCD7YDND5FBVXPKPHUQMF7JFSDRVXHG7ZZTWWNPJ6WDCXDNDF6) (1-of-1, `max_age` 7200 s) |
| RiskGate (`vigil-guard`) | [`CD6BDS7R5K3IUCQSJUZUWAGLTR47EZOYEVCO5MPT7YGNBNQRHSNY5VMS`](https://stellar.expert/explorer/testnet/contract/CD6BDS7R5K3IUCQSJUZUWAGLTR47EZOYEVCO5MPT7YGNBNQRHSNY5VMS) |
| Publisher key (can only publish) | [`GAIY6WF2F24DCGDWGWOJCBQHDMMGU6JUKT7LIGYBZ4C5VFCKTFCLJJFD`](https://stellar.expert/explorer/testnet/account/GAIY6WF2F24DCGDWGWOJCBQHDMMGU6JUKT7LIGYBZ4C5VFCKTFCLJJFD) |
| Execution pool (stands in for the mainnet pool YieldPilot holds) | `CBI7WAUQ4NPQFZW4C3MDSVFAZJWV3RCLZSTTMA5OZ6BTPEQMOZZNSZ3Z` |
| First run that signs 0 for not-eligible pools | 2026-11-02 18:32:29 UTC, [`/api/ratings/runs?at=1793644349`](https://yieldpilot.org/api/ratings/runs?at=1793644349); txs [`4576e090…`](https://stellar.expert/explorer/testnet/tx/4576e0906c625e2e45110d4e6e20a204bbf12d08418f12cc47ab3cf154974b68), [`e8f8c772…`](https://stellar.expert/explorer/testnet/tx/e8f8c77239bf037c2f481cfaf9421565e83eeefa12d3f13a7be967c5c07472de) |
| Run the application's figures come from | 2026-11-02 16:02:24 UTC, engine v2.5.0, [`/api/ratings/runs?at=1793635344`](https://yieldpilot.org/api/ratings/runs?at=1793635344); txs [`1190d0f3…`](https://stellar.expert/explorer/testnet/tx/1190d0f3066866e73a14a2d8cf7306d5cb477c260e454f2e54643f5784400ec8), [`446fea45…`](https://stellar.expert/explorer/testnet/tx/446fea45771a9082ce1d5610433542b94e1b0b3e9cef60c7dce71c02d78b397b) |

Check any run yourself, no keys needed, from a clone of the repo:

```bash
npx tsx scripts/vigil-verify.ts              # the latest run, against the registry
npx tsx scripts/vigil-verify.ts 1793635344   # one run by its computedAt
```

## Budget

**$65,400 over 24 weeks, 19.5 effort-weeks.** The audit is not in it; it goes through the Audit Bank. Göktuğ does all the paid work. Melike's time is not paid from this award. YieldPilot's InstAward funds the YieldPilot app, and nothing here pays for that.

| Tranche | Payout | When (award on 2027-01-11) | Work in it | Cost of that work |
|---|---|---|---|---|
| T0 | 10%, $6,540 | at award | Covers T1's head start | |
| T1 · MVP | 20%, $13,080 | weeks 1–6, by 2027-02-22 | 1.1 ratings service v1, 1.2 methodology v1.0 + backtests, 1.3 RiskRegistry v1.1 | $15,500 |
| T2 · Testnet | 30%, $19,620 | weeks 7–14, by 2027-04-19 | 2.1 RiskGate v1, 2.2 audit readiness, 2.3 a real M-of-N publisher set | $21,000 |
| T3 · Mainnet | 40%, $26,160 | weeks 15–24, by 2027-06-28 | 3.1 mainnet contracts, 3.2 mainnet publishing, 3.3 SDK v1, 3.4 integration support, 3.5 YieldPilot mainnet beta, infra | $28,900 |

Rates: Soroban $3,500 a week, full-stack $3,000 a week, infrastructure $400 a month. There are no marketing, legal or contingency lines. Publishing costs 0.0037 XLM per run, about 0.18 XLM a day per publisher. The line-by-line table is in `submission.md` under "Budget (bottom-up)".

## State on 2026-11-02 (16:02 UTC run)

- 13 Blend pools (V2 + v2.1) and 4 DeFindex strategies rated: 5 pools graded, 8 not rated.
- 4 of the 17 ratings accept deposits, all C 57: Fixed and DeFindex's three Fixed strategies. None of them reaches RiskGate's default minimum of 60, so YieldPilot holds. Since the 18:32 UTC run the registry signs 0 for every pool the engine marks not eligible (Fixed v2.1, YieldBlox, Orbit, Etherfuse and the Etherfuse strategy), so no RiskGate minimum accepts one; deliverable 1.3 replaces the 0 with an eligibility flag.
- Fixed v2.1 is C 64 and not eligible. At 13:59 UTC its USDC was 96.1% borrowed against a 90% `max_util`, and HR10 holds for 6 h after that read, so until about 19:59 UTC if no later read reaches it.
- Publisher: cron-job.org calls `/api/cron/publish` at :00 and :30, which has worked since 14:00 UTC.

## Still open

These need the team or outside people.
- An outside commitment: an LOI, a second publisher organization, or an outside methodology reviewer. It is the largest gap the application has left.
- After a few days of publishing, measure the cadence on-chain ("N runs, longest gap X min") and add it to the publisher row.
- The seven migrated wallets' users signing "Finalize ownership".
