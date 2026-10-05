/**
 * On-chain load test driver — N wallets × 24 h against a running YieldSeeker.
 *
 *   set -a; source .env.loadtest; set +a
 *   caffeinate -dimsu npx tsx scripts/loadtest/run.ts --run loadtest-runs/<id> --new \
 *     [--wallets 97] [--scale 1] [--base-url http://localhost:3100] [--seed <int>]
 *
 * --new initialises <id>/ (plan.json, wallets.json, run.json); the same command
 * WITHOUT --new resumes it — the stored startedAt/scale/plan win over flags.
 * One driver per run dir (driver.lock). NEVER prints secrets: only public
 * G…/C… ids and tx hashes.
 */
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { rpc } from "@stellar/stellar-sdk";
import { createDb } from "../../src/lib/db";
import { mongoDbName } from "../../src/lib/mongo";
import { EXEC_USDC_CONTRACT_ID } from "../../src/lib/onboarding";
import { createApi } from "./api";
import { assetFromSacName, createChainOps, readContractString } from "./chain";
import { probeServerDb, registryEmptyProblem } from "./dbprobe";
import { initMode, parseScale, runPlan } from "./driver";
import { acquireLock, finishedEventIds, openRunDir } from "./manifest";
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
  /** MONGODB_DB the server was verified to use — export.ts reads the activity log from it. */
  mongoDb: string;
  gitSha: string;
}

const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by someone else
  }
};
/** A tick can run for many silent minutes; say so, or an operator may think the driver hung. */
const HEARTBEAT_MS = 5 * 60_000;

async function main() {
  const { values } = parseArgs({
    options: {
      run: { type: "string" },
      wallets: { type: "string", default: "97" },
      scale: { type: "string", default: "1" },
      "base-url": { type: "string", default: "http://localhost:3100" },
      seed: { type: "string" },
      new: { type: "boolean", default: false },
    },
  });
  if (!values.run) throw new Error("--run <dir> is required (e.g. loadtest-runs/full-20261006)");
  const seedHex = process.env.LOADTEST_SEED;
  if (!seedHex) throw new Error("LOADTEST_SEED is not set — source .env.loadtest first");

  const files = openRunDir(values.run);
  const release = acquireLock(files.dir, process.pid, isAlive);
  process.on("exit", release);
  let meta = files.readJson<RunMeta>("run.json");
  const mode = initMode(meta !== null, values.new!);
  const api = createApi(meta?.baseUrl ?? values["base-url"]!, { cronSecret: process.env.CRON_SECRET || undefined });
  const { agentPublicKey } = await api.agent();
  // The server must write to the db this shell names, or the run's registry and
  // activity log end up somewhere preflight never looked (see dbprobe.ts).
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not set — source .env.loadtest first");
  const dbOk = await probeServerDb(api, (m) => createDb().log("driver", m), randomUUID());
  if (dbOk !== true) throw new Error(dbOk);

  if (mode === "init" || !meta) {
    const registryProblem = registryEmptyProblem(await api.get("/api/users"));
    if (registryProblem) throw new Error(registryProblem);
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
      mongoDb: mongoDbName(),
      gitSha: execSync("git rev-parse HEAD").toString().trim(),
    };
    files.writeJson("run.json", meta); // written last: its presence marks the run as initialised
    log(`initialised ${meta.runId}: ${walletCount} wallets, ${plan.events.length} events, scale ${meta.timeScale}, agent ${agentPublicKey}`);
  } else if (agentPublicKey !== meta.agentPublicKey) {
    throw new Error(`server agent ${agentPublicKey} ≠ this run's agent ${meta.agentPublicKey} — wrong server or env`);
  } else if (meta.mongoDb !== mongoDbName()) {
    throw new Error(`this shell uses db '${mongoDbName()}' but the run writes to '${meta.mongoDb}' — set MONGODB_DB=${meta.mongoDb}`);
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
    // A down server is waited out indefinitely: the lag is recorded, and the request never arrived.
    retry: { attempts: 3, baseDelayMs: 5_000, outageWaitMs: 30_000, maxOutageWaits: Number.POSITIVE_INFINITY },
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
      const t0 = Date.now();
      const hb = setInterval(() => log(`  … ${ev.id} still running (${Math.round((Date.now() - t0) / 60_000)} min)`), HEARTBEAT_MS);
      try {
        const r = await runEvent(ctx, ev, plannedAt);
        log(`  ${r.status} ${ev.id}${r.error ? ` — ${r.error}` : ""}`);
      } finally {
        clearInterval(hb);
      }
    },
  });
  log(`plan complete (${ran} event(s) this session). Next: npx tsx scripts/loadtest/export.ts --run ${values.run}`);
}

// Explicit exit: the Mongo client used by the db probe would keep the process alive.
main().then(
  () => process.exit(0),
  (e) => {
    console.error("FATAL:", (e as Error).message);
    process.exit(1);
  },
);
