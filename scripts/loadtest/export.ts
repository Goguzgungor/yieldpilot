/**
 * Archive a load-test run for later on-chain analysis.
 *
 *   set -a; source .env.loadtest; set +a
 *   npx tsx scripts/loadtest/export.ts --run loadtest-runs/<id> [--local-only]
 *
 * --local-only prints the summary from events.jsonl alone (no network) — use it
 * to watch a run in progress. The full export must run inside the RPC history
 * window (~7 days on SDF testnet) and before the next testnet reset
 * (2026-12-16), or the raw XDR is gone for good.
 */
import { parseArgs } from "node:util";
import { PoolV2 } from "@blend-capital/blend-sdk";
import { Address, nativeToScVal, rpc } from "@stellar/stellar-sdk";
import { createDb } from "../../src/lib/db";
import { EXEC_POOL_ID, SPENDING_POLICY_ID } from "../../src/lib/onboarding";
import * as registry from "../../src/lib/registry";
import { readSpendingLimitData } from "../../src/lib/smartAccount";
import { simulateCall, TESTNET_PASSPHRASE } from "./chain";
import { openRunDir, walletStates } from "./manifest";
import { activityHashes, collectHashes, horizonAccountTxs, parseActivity, rpcGetTransaction, runWindow, summarize } from "./report";
import type { RunMeta } from "./run";
import type { Plan } from "./schedule";

/** JSON can't carry BigInt (same rule as src/lib/serialize.ts): stringify at the edge. */
const plain = <T>(v: T): unknown => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));

async function main() {
  const { values } = parseArgs({ options: { run: { type: "string" }, "local-only": { type: "boolean", default: false } } });
  if (!values.run) throw new Error("--run <dir> is required");
  const files = openRunDir(values.run);
  const meta = files.readJson<RunMeta>("run.json");
  const plan = files.readJson<Plan>("plan.json");
  if (!meta || !plan) throw new Error(`${values.run} is not an initialised run dir`);
  const recs = files.read();

  if (values["local-only"]) return print(summarize(plan, recs, null));

  const rpcUrl = process.env.EXEC_RPC_URL ?? "https://soroban-testnet.stellar.org";
  const server = new rpc.Server(rpcUrl);
  const window = runWindow(meta, recs);
  const owners = files.readJson<Array<{ index: number; owner: string }>>("wallets.json")!;
  console.log(`window: ${window.sinceIso} → ${window.untilIso}`);

  // 1. Off-chain first: the server's activity log (supply hashes, skip reasons,
  //    tick failures, every faucet mint) and registry — same MONGODB_DB the server used.
  const rows = (await createDb().recentLog(1_000_000))
    .filter((r) => r.ts * 1000 >= window.sinceMs && r.ts * 1000 <= window.untilMs)
    .reverse();
  files.writeJsonl("offchain/activity.jsonl", rows);
  const activity = parseActivity(rows);
  const users = await registry.listUsers();
  files.writeJson(
    "offchain/users.json",
    plain(await Promise.all(users.map(async (u) => ({ ...u, position: await registry.getUserPosition(u.smartWallet) })))),
  );

  // 2. Horizon: all txs (incl. failed) of the dedicated agent (authorize + every
  //    supply) and of every wallet G, inside the run window.
  const horizon = new Map<string, Record<string, unknown>>();
  const add = (source: string, txs: Array<{ hash: string }>) => {
    for (const t of txs) if (!horizon.has(t.hash)) horizon.set(t.hash, { _source: source, ...t });
  };
  add("agent", await horizonAccountTxs(meta.agentPublicKey, window));
  for (const w of owners) add(`wallet:${w.index}`, await horizonAccountTxs(w.owner, window));
  files.writeJsonl("chain/horizon-transactions.jsonl", [...horizon.values()]);
  console.log(`horizon: ${horizon.size} txs`);

  // 3. RPC: raw XDR for every hash we know — driver-recorded ∪ Horizon ∪ server
  //    activity (the faucet admin's mints are only reachable this way), 4 at a time.
  const hashes = [...new Set([...collectHashes(recs), ...horizon.keys(), ...activityHashes(activity)])];
  const raw: Array<Record<string, unknown>> = [];
  for (let i = 0; i < hashes.length; i += 4) {
    raw.push(...(await Promise.all(hashes.slice(i, i + 4).map((h) => rpcGetTransaction(rpcUrl, h)))));
  }
  files.writeJsonl("chain/rpc-transactions.jsonl", raw);
  const rpcNotFound = raw.filter((r) => r.status === "NOT_FOUND").length;
  console.log(`rpc: ${raw.length} txs (${rpcNotFound} NOT_FOUND)`);

  // 4. Final per-wallet state.
  const pool = await PoolV2.load({ rpc: rpcUrl, passphrase: TESTNET_PASSPHRASE }, process.env.EXEC_POOL_ID ?? EXEC_POOL_ID);
  const reserve = pool.reserves.get(meta.usdcSac);
  const finalState: unknown[] = [];
  for (const [index, s] of walletStates(recs)) {
    const err = (e: Error) => `error: ${e.message}`;
    const usdcBalance = await simulateCall(
      server, meta.usdcSac, "balance", [nativeToScVal(Address.fromString(s.smartWallet), { type: "address" })], meta.agentPublicKey,
    ).catch(err);
    const blendCollateral = await pool
      .loadUser(s.smartWallet)
      .then((u) => (reserve ? u.getCollateral(reserve) : null))
      .catch(err);
    const spending = await readSpendingLimitData({
      server,
      spendingPolicy: process.env.SPENDING_POLICY_ID ?? SPENDING_POLICY_ID,
      smartWallet: s.smartWallet,
      ruleId: s.usdcRuleId,
      networkPassphrase: TESTNET_PASSPHRASE,
      readerSource: meta.agentPublicKey,
    }).catch(err);
    finalState.push({ index, ...s, usdcBalance, blendCollateral, spending });
  }
  files.writeJson("state/final-wallets.json", plain(finalState));

  const summary = { ...summarize(plan, recs, activity), chain: { horizonTxs: horizon.size, rpcTxs: raw.length, rpcNotFound } };
  files.writeJson("summary.json", summary);
  print(summary);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("FATAL:", (e as Error).message);
    process.exit(1);
  },
);
