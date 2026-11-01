/**
 * Preflight for the on-chain load test. Run with .env.loadtest sourced and the
 * load-test server up:
 *
 *   set -a; source .env.loadtest; set +a
 *   npx tsx scripts/loadtest/preflight.ts [--base-url http://localhost:3100]
 *
 * Exit 1 if any check fails. Prints only public ids.
 */
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { PoolV2 } from "@blend-capital/blend-sdk";
import { Keypair, rpc } from "@stellar/stellar-sdk";
import { createDb } from "../../src/lib/db";
import { deriveOwnerKeypair } from "../../src/lib/faucet";
import { getCollection, mongoDbName } from "../../src/lib/mongo";
import { EXEC_POOL_ID, EXEC_USDC_CONTRACT_ID } from "../../src/lib/onboarding";
import { SMART_ACCOUNT_WASM_HASH } from "../../src/lib/smartAccount";
import { createApi } from "./api";
import { loadHorizonAccount, readContractString, TESTNET_PASSPHRASE, xlmBalance } from "./chain";
import { probeServerDb } from "./dbprobe";
import { evaluatePreflight, type PreflightFacts } from "./preflight-checks";

async function probeMongo(): Promise<true | string> {
  try {
    const coll = await getCollection("_preflight");
    const { insertedId } = await coll.insertOne({ at: Date.now() });
    await coll.deleteOne({ _id: insertedId });
    return true;
  } catch (e) {
    return (e as Error).message;
  }
}

async function main() {
  const { values } = parseArgs({ options: { "base-url": { type: "string", default: "http://localhost:3100" } } });
  const env = process.env;
  const rpcUrl = env.EXEC_RPC_URL ?? "https://soroban-testnet.stellar.org";
  const server = new rpc.Server(rpcUrl);
  if (!env.AGENT_SIGNER_SECRET) throw new Error("AGENT_SIGNER_SECRET is not set — source .env.loadtest first");
  const envAgent = Keypair.fromSecret(env.AGENT_SIGNER_SECRET).publicKey();
  const faucetAdmin = deriveOwnerKeypair().publicKey();
  const api = createApi(values["base-url"]!, { cronSecret: env.CRON_SECRET || undefined });

  const agentAcc = await loadHorizonAccount(envAgent);
  const adminAcc = await loadHorizonAccount(faucetAdmin);
  const pool = await PoolV2.load({ rpc: rpcUrl, passphrase: TESTNET_PASSPHRASE }, env.EXEC_POOL_ID ?? EXEC_POOL_ID);

  const facts: PreflightFacts = {
    // Read exactly as the server does, so "blank" counts as unset.
    mongoDb: mongoDbName() === "yieldseeker" ? undefined : mongoDbName(),
    mongoWritable: env.MONGODB_URI ? await probeMongo() : "MONGODB_URI is not set",
    serverDb: env.MONGODB_URI
      ? await probeServerDb(api, (m) => createDb().log("preflight", m), randomUUID())
      : "MONGODB_URI is not set",
    envAgent,
    serverAgent: await api.agent().then((a) => a.agentPublicKey, () => null),
    agentXlm: agentAcc ? xlmBalance(agentAcc) : 0,
    faucetAdmin,
    sacAdmin: await readContractString(server, env.EXEC_USDC_CONTRACT_ID ?? EXEC_USDC_CONTRACT_ID, "admin", faucetAdmin).catch(
      (e: Error) => `error: ${e.message}`,
    ),
    faucetAdminXlm: adminAcc ? xlmBalance(adminAcc) : 0,
    poolStatus: pool.metadata.status,
    smartAccountWasm: await server.getContractWasmByHash(Buffer.from(SMART_ACCOUNT_WASM_HASH, "hex")).then(() => true, () => false),
    rpcRetentionLedgers: (await server.getHealth()).ledgerRetentionWindow,
  };

  const checks = evaluatePreflight(facts);
  for (const c of checks) console.log(`${c.ok ? "✅" : "❌"} ${c.name} — ${c.detail}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n${failed} check(s) failed — do not start the run.` : "\nall checks passed");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", (e as Error).message);
  process.exit(1);
});
