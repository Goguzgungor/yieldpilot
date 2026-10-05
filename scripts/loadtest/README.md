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
mkdir -p loadtest-runs
```
Later lines win when sourced. If `vercel env pull` returns empty sensitive values, fill
`STELLAR_WALLET_MNEMONIC`, `MONGODB_URI` and `ANTHROPIC_API_KEY` by hand.

## Server (tmux window 1)

```bash
npm run build
set -a; source .env.loadtest; set +a
# smoke run: prefix with MONGODB_DB=yieldseeker_loadtest_smoke
npx next start -p 3100 2>&1 | tee -a loadtest-runs/server.log
```

## Preflight → smoke → full run → export (tmux window 2)

```bash
set -a; source .env.loadtest; set +a
npx tsx scripts/loadtest/preflight.ts                                   # all ✅

# smoke: 5 wallets (one per cohort), 24 h squeezed into ~15 min, own db
MONGODB_DB=yieldseeker_loadtest_smoke npx tsx scripts/loadtest/run.ts --run loadtest-runs/smoke-$(date +%Y%m%d-%H%M) --wallets 5 --scale 1/96
MONGODB_DB=yieldseeker_loadtest_smoke npx tsx scripts/loadtest/export.ts --run loadtest-runs/smoke-YYYYMMDD-HHMM
# then restart the server without the MONGODB_DB prefix and re-run preflight

RUN=loadtest-runs/full-$(date +%Y%m%d)
caffeinate -dimsu npx tsx scripts/loadtest/run.ts --run $RUN --wallets 97 2>&1 | tee -a $RUN.log
npx tsx scripts/loadtest/export.ts --run $RUN --local-only              # progress, no network
npx tsx scripts/loadtest/export.ts --run $RUN                           # after T+24h, within 7 days
```
Resume after any crash: rerun the exact `run.ts` command (same `--run`).
