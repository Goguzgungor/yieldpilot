/**
 * MIGRATE legacy (pre-Vigil) smart accounts on testnet:
 *   1. add_policy(poolRuleId, VIGIL_GUARD, pool params)   — closes the drain hole
 *   2. add_policy(usdcRuleId, VIGIL_GUARD, usdc params)   — transfers may only pay the pool
 *   3. add_signer(0, Delegated(user G))                   — the user becomes co-owner
 *   4. remove_signer(0, demo-owner)                       — the backend stops being owner
 *
 * After step 3 the Default rule holds two signers and no policy, so EVERY
 * signer must sign: from then on the backend can no longer change the wallet
 * alone. Step 4 therefore needs the user's signature too — in the app that is
 * the "finalize ownership" step (/api/onboard/prepare step=finalize-ownership,
 * co-signed by the backend, signed by the user in Freighter). Here it only runs
 * when the user's key is supplied (--user-secret, throwaway test accounts).
 *
 * Wallets onboarded before user-owned onboarding have the backend DEMO OWNER
 * (agentKeys.ts, derived from AGENT_SIGNER_SECRET) as their only Default-rule
 * signer, so only the backend holding the PRODUCTION AGENT_SIGNER_SECRET can
 * run this. After step 4 that key can no longer change these wallets.
 *
 * Dry run (default) simulates every pending step and submits nothing:
 *   npx tsx scripts/migrate-legacy-accounts.ts
 * Apply:
 *   npx tsx scripts/migrate-legacy-accounts.ts --apply
 * Options:
 *   --users-url=https://yieldpilot.org/api/users   where to read registrations
 *   --wallet=C…:G…:poolRuleId:usdcRuleId          migrate just this wallet (repeatable)
 *   --make-test-account                            first create a throwaway legacy-style
 *                                                  wallet owned by this env's demo owner
 *   --user-secret=S…                               the user's key (test accounts only), so
 *                                                  step 4 can be co-signed here
 *   --no-finalize                                  stop after step 3 (leave it to the app)
 *
 * Reads the usual env (.env): AGENT_SIGNER_SECRET, EXEC_*, ED25519_VERIFIER_ID,
 * SPENDING_POLICY_ID, VIGIL_GUARD_ID, optional VIGIL_REGISTRY_ID / VIGIL_MIN_SCORE
 * / VIGIL_MAX_AGE_SEC. Steps already done (policy present, signer present /
 * absent) are skipped, so the script is safe to re-run.
 */
import "dotenv/config";
import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import { parseConfig } from "../src/lib/config";
import { getDemoOwnerKeypair } from "../src/lib/agentKeys";
import {
  addAgentRuleOps,
  addPolicyOp,
  buildAgentAuth,
  buildDelegatedOwnerTx,
  delegatedSignerScVal,
  deploySmartWalletOp,
  externalSignerScVal,
  riskGateParams,
} from "../src/lib/smartAccount";
import { DEFAULT_CAP_STROOPS, PERIOD_LEDGERS } from "../src/lib/onboarding";

interface Target {
  smartWallet: string;
  owner: string;
  poolRuleId: number;
  usdcRuleId: number;
}

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const flag = (name: string) => args.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));

const cfg = parseConfig({ ANTHROPIC_API_KEY: "unused", ...process.env });
const server = new rpc.Server(cfg.execRpcUrl);
const PASS = cfg.execNetworkPassphrase;
const agent = Keypair.fromSecret(cfg.agentSignerSecret);
const demoOwner = getDemoOwnerKeypair();
const demoSigner = externalSignerScVal({
  verifier: cfg.ed25519VerifierId,
  publicKeyHex: demoOwner.rawPublicKey().toString("hex"),
});

async function send(tx: Transaction): Promise<string> {
  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") throw new Error(`send ERROR ${sent.errorResult?.toXDR("base64")}`);
  let g = await server.getTransaction(sent.hash);
  for (let i = 0; i < 30 && g.status === "NOT_FOUND"; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    g = await server.getTransaction(sent.hash);
  }
  if (g.status !== "SUCCESS") throw new Error(`tx ${sent.hash} ${g.status}`);
  return sent.hash;
}

async function read(contract: string, fn: string, ...callArgs: xdr.ScVal[]): Promise<unknown> {
  const tx = new TransactionBuilder(await server.getAccount(agent.publicKey()), { fee: BASE_FEE, networkPassphrase: PASS })
    .addOperation(new Contract(contract).call(fn, ...callArgs))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`${fn}: ${sim.error.split("\n")[0]}`);
  return scValToNative(sim.result!.retval);
}

type Rule = { policies: string[]; signers: unknown[] };
const rule = (sa: string, id: number) => read(sa, "get_context_rule", xdr.ScVal.scvU32(id)) as Promise<Rule>;
// Compare a decoded signer (scValToNative form) with an encoded one.
const norm = (x: unknown): unknown =>
  Buffer.isBuffer(x) ? x.toString("hex") : Array.isArray(x) ? x.map(norm) : x;
const sameSigner = (s: unknown, v: xdr.ScVal) => JSON.stringify(norm(s)) === JSON.stringify(norm(scValToNative(v)));

/** Owner-sign `op` with the demo owner (Default rule 0); simulate, and submit when applying. */
async function ownerStep(sa: string, label: string, op: xdr.Operation, submit: boolean): Promise<string> {
  const { tx } = await buildAgentAuth({
    server,
    smartWallet: sa,
    networkPassphrase: PASS,
    contextRuleIds: [0],
    agentKeypair: demoOwner,
    verifier: cfg.ed25519VerifierId,
    op,
    feeSource: agent.publicKey(),
  });
  if (!submit) return `${label}: simulation OK`;
  tx.sign(agent);
  return `${label}: ${await send(tx)}`;
}

async function makeTestAccount(): Promise<Target> {
  // A throwaway user G + a wallet built the OLD way: demo owner, unguarded rules.
  const user = Keypair.random();
  for (const kp of [user, agent]) {
    try {
      await server.getAccount(kp.publicKey());
    } catch {
      await fetch(`https://friendbot.stellar.org/?addr=${kp.publicKey()}`);
    }
  }
  const { op, contractId } = deploySmartWalletOp({
    deployer: user.publicKey(),
    networkPassphrase: PASS,
    verifier: cfg.ed25519VerifierId,
    ownerPublicKeyHex: demoOwner.rawPublicKey().toString("hex"),
  });
  const tx = new TransactionBuilder(await server.getAccount(user.publicKey()), { fee: "10000000", networkPassphrase: PASS })
    .addOperation(op)
    .setTimeout(120)
    .build();
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(user);
  await send(prepared);
  const { poolRuleOp, usdcRuleOp } = addAgentRuleOps({
    smartWallet: contractId,
    poolId: cfg.execPoolId,
    usdcSac: cfg.execUsdcContractId,
    verifier: cfg.ed25519VerifierId,
    agentPublicKeyHex: agent.rawPublicKey().toString("hex"),
    spendingPolicy: cfg.spendingPolicyId,
    capStroops: DEFAULT_CAP_STROOPS,
    periodLedgers: PERIOD_LEDGERS,
  });
  await ownerStep(contractId, "legacy pool rule", poolRuleOp, true);
  await ownerStep(contractId, "legacy usdc rule", usdcRuleOp, true);
  // Throwaway testnet key, printed so step 4 can be re-run with --user-secret.
  console.log(`test account ${contractId} (user ${user.publicKey()} secret ${user.secret()}), legacy rules 1 + 2`);
  userSecrets.set(user.publicKey(), user.secret());
  return { smartWallet: contractId, owner: user.publicKey(), poolRuleId: 1, usdcRuleId: 2 };
}

const userSecrets = new Map<string, string>(
  flag("user-secret").map((s) => [Keypair.fromSecret(s).publicKey(), s] as [string, string]),
);

async function targets(): Promise<Target[]> {
  const explicit = flag("wallet").map((w) => {
    const [smartWallet, owner, p, u] = w.split(":");
    return { smartWallet, owner, poolRuleId: Number(p), usdcRuleId: Number(u) };
  });
  if (args.includes("--make-test-account")) explicit.push(await makeTestAccount());
  if (explicit.length) return explicit;
  const url = flag("users-url")[0] ?? "https://yieldpilot.org/api/users";
  const body = (await (await fetch(url)).json()) as { users: Target[] };
  return body.users;
}

async function migrate(t: Target): Promise<void> {
  console.log(`\n${t.smartWallet}  owner ${t.owner}  rules pool #${t.poolRuleId} usdc #${t.usdcRuleId}`);
  const guard = cfg.vigilGuard;
  const r0 = await rule(t.smartWallet, 0);
  const demoIsOwner = r0.signers.some((s) => sameSigner(s, demoSigner));
  const userIsOwner = r0.signers.some((s) => sameSigner(s, delegatedSignerScVal(t.owner)));
  if (!demoIsOwner) {
    console.log(`  skip: this env's demo owner is not an owner here (${userIsOwner ? "already user-owned" : "unknown owner"})`);
    return;
  }

  const steps: Array<[string, xdr.Operation]> = [];
  if (!(await rule(t.smartWallet, t.poolRuleId)).policies.includes(guard.id)) {
    steps.push([
      "add guard to pool rule",
      addPolicyOp({
        smartWallet: t.smartWallet,
        contextRuleId: t.poolRuleId,
        policy: guard.id,
        installParam: riskGateParams({
          registry: guard.registry ?? null,
          minScore: guard.registry ? guard.minScore : 0,
          maxAgeSecs: guard.registry ? guard.maxAgeSecs : 0n,
          allowedRecipients: [],
        }),
      }),
    ]);
  }
  if (!(await rule(t.smartWallet, t.usdcRuleId)).policies.includes(guard.id)) {
    steps.push([
      "add guard to usdc rule",
      addPolicyOp({
        smartWallet: t.smartWallet,
        contextRuleId: t.usdcRuleId,
        policy: guard.id,
        installParam: riskGateParams({ registry: null, minScore: 0, maxAgeSecs: 0n, allowedRecipients: [cfg.execPoolId] }),
      }),
    ]);
  }
  if (!userIsOwner) {
    steps.push([
      "add user as owner (Delegated)",
      new Contract(t.smartWallet).call("add_signer", xdr.ScVal.scvU32(0), delegatedSignerScVal(t.owner)),
    ]);
  }

  for (const [label, op] of steps) console.log("  " + (await ownerStep(t.smartWallet, label, op, APPLY)));

  // Step 4 needs the user's signature as well (see header).
  const userSecret = args.includes("--no-finalize") ? undefined : userSecrets.get(t.owner);
  if (!(APPLY || userIsOwner)) {
    console.log("  remove demo owner: pending (after the user is co-owner; not simulated in a dry run)");
  } else if (!userSecret) {
    console.log("  remove demo owner: needs the user's signature → user runs \"finalize ownership\" in the app");
  } else {
    const user = Keypair.fromSecret(userSecret);
    const signerId = Number(await read(t.smartWallet, "get_signer_id", demoSigner));
    const tx = await buildDelegatedOwnerTx({
      server,
      smartWallet: t.smartWallet,
      owner: t.owner,
      networkPassphrase: PASS,
      op: new Contract(t.smartWallet).call("remove_signer", xdr.ScVal.scvU32(0), xdr.ScVal.scvU32(signerId)),
      coSigners: [{ key: { verifier: cfg.ed25519VerifierId, publicKeyHex: demoOwner.rawPublicKey().toString("hex") }, keypair: demoOwner }],
    });
    tx.sign(user);
    console.log(`  remove demo owner (signer #${signerId}, co-signed by the user): ${await send(tx)}`);
  }

  if (APPLY) {
    const after = await rule(t.smartWallet, 0);
    const ok = after.signers.length === 1 && sameSigner(after.signers[0], delegatedSignerScVal(t.owner));
    console.log(`  Default-rule owner now: ${ok ? "user only ✓" : JSON.stringify(after.signers)}`);
  }
}

async function main() {
  console.log(`${APPLY ? "APPLY" : "DRY RUN"} · guard ${cfg.vigilGuard.id}${cfg.vigilGuard.registry ? ` · registry ${cfg.vigilGuard.registry} (min ${cfg.vigilGuard.minScore})` : " · no rating gate"}`);
  console.log(`demo owner (this env): ${demoOwner.publicKey()}`);
  for (const t of await targets()) {
    try {
      await migrate(t);
    } catch (e) {
      console.log(`  FAILED: ${(e as Error).message.split("\n")[0]}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
