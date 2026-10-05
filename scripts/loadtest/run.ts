/**
 * On-chain load test driver — N wallets × 24 h against a running YieldSeeker.
 *
 *   set -a; source .env.loadtest; set +a
 *   caffeinate -dimsu npx tsx scripts/loadtest/run.ts --run loadtest-runs/<id> \
 *     [--wallets 97] [--scale 1] [--base-url http://localhost:3100] [--seed <int>]
 *
 * The first call initialises <id>/ (plan.json, wallets.json, run.json); calling
 * again with the same --run resumes it — the stored startedAt/scale/plan win
 * over flags. NEVER prints secrets: only public G…/C… ids and tx hashes.
 */
import { execSync } from "node:child_process";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { rpc } from "@stellar/stellar-sdk";
import { EXEC_USDC_CONTRACT_ID } from "../../src/lib/onboarding";
import { createApi } from "./api";
import { assetFromSacName, createChainOps, readContractString } from "./chain";
import { parseScale, runPlan } from "./driver";
import { finishedEventIds, openRunDir } from "./manifest";
import { buildPlan, type Plan } from "./schedule";
import { runEvent, type StepCtx } from "./steps";
import { assertSameWallets, deriveWallet } from "./wallets";

export interface RunMeta {
  runId: string;
  startedAt: number;
  timeScale: number;
  baseUrl: string;
  walletCount: number;
  planSeed: number;
  agentPublicKey: string;
  usdcSac: string;
  gitSha: string;
}

const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main() {
  const { values } = parseArgs({
    options: {
      run: { type: "string" },
      wallets: { type: "string", default: "97" },
      scale: { type: "string", default: "1" },
      "base-url": { type: "string", default: "http://localhost:3100" },
      seed: { type: "string" },
    },
  });
  if (!values.run) throw new Error("--run <dir> is required (e.g. loadtest-runs/full-20261006)");
  const seedHex = process.env.LOADTEST_SEED;
  if (!seedHex) throw new Error("LOADTEST_SEED is not set — source .env.loadtest first");

  const files = openRunDir(values.run);
  let meta = files.readJson<RunMeta>("run.json");
  const api = createApi(meta?.baseUrl ?? values["base-url"]!, { cronSecret: process.env.CRON_SECRET || undefined });
  const { agentPublicKey } = await api.agent();

  if (!meta) {
    const walletCount = Number(values.wallets);
    const planSeed = values.seed ? Number(values.seed) : parseInt(seedHex.slice(0, 8), 16);
    const plan = buildPlan({ walletCount, seed: planSeed });
    files.writeJson("plan.json", plan);
    files.writeJson("wallets.json", plan.wallets.map((w) => ({ ...w, owner: deriveWallet(seedHex, w.index).publicKey() })));
    meta = {
      runId: basename(values.run),
      startedAt: Date.now(),
      timeScale: parseScale(values.scale!),
      baseUrl: values["base-url"]!,
      walletCount,
      planSeed,
      agentPublicKey,
      usdcSac: process.env.EXEC_USDC_CONTRACT_ID ?? EXEC_USDC_CONTRACT_ID,
      gitSha: execSync("git rev-parse HEAD").toString().trim(),
    };
    files.writeJson("run.json", meta); // written last: its presence marks the run as initialised
    log(`initialised ${meta.runId}: ${walletCount} wallets, ${plan.events.length} events, scale ${meta.timeScale}, agent ${agentPublicKey}`);
  } else if (agentPublicKey !== meta.agentPublicKey) {
    throw new Error(`server agent ${agentPublicKey} ≠ this run's agent ${meta.agentPublicKey} — wrong server or env`);
  }

  const plan = files.readJson<Plan>("plan.json")!;
  assertSameWallets(files.readJson<Array<{ index: number; owner: string }>>("wallets.json")!, (i) => deriveWallet(seedHex, i).publicKey());

  const server = new rpc.Server(process.env.EXEC_RPC_URL ?? "https://soroban-testnet.stellar.org");
  const asset = assetFromSacName(await readContractString(server, meta.usdcSac, "name", meta.agentPublicKey));
  const ctx: StepCtx = {
    api,
    chain: createChainOps({ server, asset }),
    files,
    wallet: (i) => deriveWallet(seedHex, i),
    now: Date.now,
    sleep,
    log,
    retry: { attempts: 3, baseDelayMs: 5_000, outageWaitMs: 30_000, maxOutageWaits: 40 },
  };

  const ran = await runPlan({
    events: plan.events,
    startedAt: meta.startedAt,
    timeScale: meta.timeScale,
    finished: finishedEventIds(files.read()),
    now: Date.now,
    sleep,
    log,
    exec: async (ev, plannedAt) => {
      const r = await runEvent(ctx, ev, plannedAt);
      log(`  ${r.status} ${ev.id}${r.error ? ` — ${r.error}` : ""}`);
    },
  });
  log(`plan complete (${ran} event(s) this session). Next: npx tsx scripts/loadtest/export.ts --run ${values.run}`);
}

main().catch((e) => {
  console.error("FATAL:", (e as Error).message);
  process.exit(1);
});
