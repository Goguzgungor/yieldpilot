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
`STELLAR_WALLET_MNEMONIC` and `MONGODB_URI` by hand.

## Server (tmux window 1)

```bash
npm run build
set -a; source .env.loadtest; set +a
# smoke run: prefix with MONGODB_DB=yieldseeker_loadtest_smoke
npx next start -p 3100 2>&1 | tee -a loadtest-runs/server.log
```

## Smoke run (tmux window 2) — own db, own seed

```bash
set -a; source .env.loadtest; set +a
export MONGODB_DB=yieldseeker_loadtest_smoke                       # same as the server's smoke prefix
export LOADTEST_SEED=$(openssl rand -hex 32)                        # smoke wallets ≠ full-run wallets
npx tsx scripts/loadtest/preflight.ts                               # all ✅ (incl. "server writes to this db")
SMOKE=loadtest-runs/smoke-$(date +%Y%m%d-%H%M)
npx tsx scripts/loadtest/run.ts --run $SMOKE --new --wallets 5 --scale 1/96   # 24 h squeezed into ~15 min
npx tsx scripts/loadtest/export.ts --run $SMOKE
```
Then restart the server **without** the `MONGODB_DB` prefix and open a fresh shell.

## Full run (tmux window 2, fresh shell)

```bash
set -a; source .env.loadtest; set +a
npx tsx scripts/loadtest/preflight.ts                               # all ✅, MONGODB_DB=yieldseeker_loadtest_<date>
echo loadtest-runs/full-$(date +%Y%m%d) > loadtest-runs/CURRENT     # record the path once — $(date) changes at midnight
RUN=$(cat loadtest-runs/CURRENT)
caffeinate -dimsu npx tsx scripts/loadtest/run.ts --run $RUN --new --wallets 97 2>&1 | tee -a $RUN.log
```

- Progress (no network): `npx tsx scripts/loadtest/export.ts --run $(cat loadtest-runs/CURRENT) --local-only`
- Resume after any crash or restart — **without** `--new`:
  `RUN=$(cat loadtest-runs/CURRENT); caffeinate -dimsu npx tsx scripts/loadtest/run.ts --run $RUN 2>&1 | tee -a $RUN.log`
- After T+24 h, within 7 days: `npx tsx scripts/loadtest/export.ts --run $(cat loadtest-runs/CURRENT)`

The driver refuses to start a second copy on the same run dir (`driver.lock`), to
initialise without `--new`, or to run against a server that uses a different Mongo db.
