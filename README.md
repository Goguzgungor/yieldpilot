# YieldPilot + Vigil

**YieldPilot** ([yieldpilot.org](https://yieldpilot.org)) is an autonomous yield agent on Stellar. It scans Blend pools and DeFindex strategies on mainnet, picks the best pool that passes its own risk checks and Vigil's rating gate, and supplies each user's idle USDC through that user's own OpenZeppelin smart account. In those accounts the agent is only a restricted, spending-capped signer.

**Vigil** is the risk layer underneath it, built so other wallets, vault managers and agents can use it too:

- **Risk engine.** `src/lib/vigil`, with the methodology in `docs/vigil/methodology.md`. It rates every pool from Blend's V2 and v2.1 factories, and the DeFindex strategies built on them, from on-chain configuration: oracle source per collateral, SDEX depth over 24 h, backstop, status and reserves. Engine `vigil-risk-v2.3.0`, frozen for the SCF review round.
- **`vigil-registry`.** A Soroban contract (`contracts/`) where publishers sign ratings and readers get a conservative M-of-N aggregate. Designed for several publishers; today there is one, ours, publishing hourly (`.github/workflows/vigil-publish.yml`).
- **`vigil-guard` (RiskGate).** An OpenZeppelin smart-account policy (`contracts/`):
  - Blend calls must keep funds in the user's account.
  - Token transfers may only pay the pool.
  - Deposits need a fresh rating.
  - Withdrawals are never blocked.
- **SDK.** `packages/vigil-sdk` holds the guard install params, the registry client and the error decoder.

> Status: **testnet** for execution and contracts, **mainnet read-only** for scanning and ratings. No real funds are moved.

## How a deposit is authorized

```
user's Freighter G-account ── owns ──► OZ smart account (Default rule: Delegated(G))
                                         │
           agent key (External ed25519) ─┤ rule "agent-pool": CallContract(Blend pool)
                                         │     policy: vigil-guard  → from = spender = to = account,
                                         │                            supply/withdraw only,
                                         │                            deposit needs rating ≥ min (registry)
                                         └ rule "agent-usdc": CallContract(USDC)
                                               policies: spending limit (cap / day)
                                                         vigil-guard → transfer only to the pool
```

The user signs every owner action in Freighter: deploying the wallet and adding or removing the agent's rules. For wallets created since 2026-11-01 the backend holds no owner key. The seven wallets created before that were backend-owned and unguarded; `scripts/migrate-legacy-accounts.ts` adds the guard and makes the user co-owner, and the backend key leaves only when the user finalizes ownership in the app.

The agent applies the same rating check before it chooses (`src/lib/vigilGate.ts`): a pool without a fresh Vigil rating that is eligible and at or above the wallets' minimum (60) is not a candidate. When no pool passes, the agent holds and idle USDC stays idle.

## What is proven on testnet

| Claim | Evidence |
|---|---|
| A G-account (Freighter) can own the deployed OZ smart account | `scripts/spike-delegated-owner.ts` |
| User-owned onboarding works end-to-end through the API routes | `scripts/verify-onboarding-owner.ts` |
| Without the guard, the agent key can withdraw a user's Blend position to another address; with the guard, that call and every other escape route are rejected | `scripts/verify-guard.ts`, results in `contracts/README.md` |
| Legacy (backend-owned) wallets can be guarded and handed to their users | `scripts/migrate-legacy-accounts.ts`, `/api/onboard/prepare` step `finalize-ownership` |
| Mainnet ratings can be published to the registry and read back on-chain | `scripts/vigil-publish.ts`, run every 30 minutes by `.github/workflows/vigil-publish.yml` (each run's input is kept as an artifact) |

Live ratings for every Blend pool (the V2 and v2.1 deployments) are served at `/ratings` (page) and `/api/ratings` (JSON, served from a cache recomputed hourly). The engine also reconstructs the YieldBlox pool as configured before the 22 Feb 2026 exploit and grades it E (`npx tsx scripts/vigil-backtest.ts`).

## Testnet contracts

| Contract | Id |
|---|---|
| Exec Blend V2 pool | `CBI7WAUQ4NPQFZW4C3MDSVFAZJWV3RCLZSTTMA5OZ6BTPEQMOZZNSZ3Z` |
| Exec USDC (SAC) | `CD2R7WREEPGIAXZL4ASB76Y6PWTY6ZZXZ6C64AIKFDIG36YKQPNY6B2I` |
| vigil-guard (RiskGate) | `CD6BDS7R5K3IUCQSJUZUWAGLTR47EZOYEVCO5MPT7YGNBNQRHSNY5VMS` |
| vigil-registry | `CB4LXLCCD7YDND5FBVXPKPHUQMF7JFSDRVXHG7ZZTWWNPJ6WDCXDNDF6` (1 publisher, `GAIY6WF2…JJFD`, every 30 min; admin `GANUB45L…QH3C`) |
| OZ ed25519 verifier | `CBHJOANTAHF2ZKU5HZRZTWP4GX7YCSNR3V3AIMAH5P5R7S465SK24RSO` |
| OZ spending-limit policy | `CBLNG63CIFKLFY6ZTL32NWMGPN7NBDSXZUSCQNTLMYRTLIZYA7MG3KAP` |
| OZ smart-account wasm | `e2f4ed54b009c6b1c5bd848e4c73ff706c74d9436757859423f8959fa4aca28d` |

## Develop

```bash
npm ci
npm run dev                      # Next.js + agent loop (AGENT_LOOP_ENABLED=0 to disable)
npm test                         # vitest: app, engine and SDK unit tests (offline)
npx tsc --noEmit                 # typecheck
cd contracts && cargo test       # Soroban contracts (+ `cargo test -- --ignored` after `stellar contract build`)
npx tsx scripts/vigil-ratings.ts # live mainnet ratings (read-only, ~90 s)
npx tsx scripts/vigil-backtest.ts # YieldBlox reconstruction (offline)
```

Copy `.env.example` to `.env`. `CLAUDE.md` describes the architecture: the scan/exec split, per-user execution and the smart-account auth details.

## Layout

| Path | What |
|---|---|
| `src/lib/` | agent loop: scanner, DeFindex, risk, deterministic pool choice, per-user executor, smart-account auth |
| `src/lib/vigil/` | Vigil risk engine (v2.2; history in `docs/vigil/methodology.md` §10) |
| `src/app/` | Next.js UI + API routes (`/api/onboard/*`, `/api/scan`, `/api/ratings`, …) |
| `contracts/` | `vigil-guard`, `vigil-registry`, shared `vigil-interface` (Rust, soroban-sdk 28, OZ stellar-accounts 0.8) |
| `packages/vigil-sdk/` | TypeScript client |
| `scripts/` | testnet/mainnet proofs, deploy and migration scripts |
| `builders/` | SCF application work (drafts, research) |

## License

[Apache-2.0](LICENSE): the app, the risk engine, the Soroban contracts and the SDK.

Follow the project on X: [@AsteriaStellar](https://x.com/AsteriaStellar).
