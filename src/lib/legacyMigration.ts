/**
 * SERVER-ONLY. Hands a legacy (pre-Vigil) smart account over to its user —
 * steps 1–3 of scripts/migrate-legacy-accounts.ts, shared by that script and
 * the one-off /api/admin/migrate-legacy route (which runs where the production
 * AGENT_SIGNER_SECRET lives):
 *   1. add_policy(poolRuleId, VIGIL_GUARD, pool params)   — closes the drain hole
 *   2. add_policy(usdcRuleId, VIGIL_GUARD, usdc params)   — transfers may only pay the pool
 *   3. add_signer(0, Delegated(user G))                   — the user becomes co-owner
 * Each step is owner-signed by the backend demo owner, the only owner such a
 * wallet has. Steps already done are skipped, so a re-run is safe. Step 4
 * (removing the demo owner) needs the user's signature; see the script.
 */
import {
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import { addPolicyOp, buildAgentAuth, delegatedSignerScVal, externalSignerScVal, riskGateParams } from "./smartAccount";

export interface LegacyWallet {
  smartWallet: string;
  owner: string;
  poolRuleId: number;
  usdcRuleId: number;
}

export interface LegacyMigrationDeps {
  server: rpc.Server;
  networkPassphrase: string;
  /** Pays the fees (the agent key). */
  feeSource: Keypair;
  /** The backend demo owner (agentKeys.ts). */
  demoOwner: Keypair;
  verifier: string;
  guard: { id: string; registry?: string; minScore: number; maxAgeSecs: bigint };
  execPoolId: string;
}

export interface LegacyMigrationResult {
  smartWallet: string;
  demoIsOwner: boolean;
  userIsOwner: boolean;
  /** One line per step ("<step>: simulation OK" / "<step>: <tx hash>"), or why the wallet was skipped. */
  lines: string[];
}

export async function sendTx(server: rpc.Server, tx: Transaction): Promise<string> {
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

export async function readContract(d: LegacyMigrationDeps, contract: string, fn: string, ...args: xdr.ScVal[]): Promise<unknown> {
  const tx = new TransactionBuilder(await d.server.getAccount(d.feeSource.publicKey()), {
    fee: BASE_FEE,
    networkPassphrase: d.networkPassphrase,
  })
    .addOperation(new Contract(contract).call(fn, ...args))
    .setTimeout(30)
    .build();
  const sim = await d.server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`${fn}: ${sim.error.split("\n")[0]}`);
  return scValToNative(sim.result!.retval);
}

type Rule = { policies: string[]; signers: unknown[] };
const contextRule = (d: LegacyMigrationDeps, sa: string, id: number) =>
  readContract(d, sa, "get_context_rule", xdr.ScVal.scvU32(id)) as Promise<Rule>;

// Compare a decoded signer (scValToNative form) with an encoded one.
const norm = (x: unknown): unknown => (Buffer.isBuffer(x) ? x.toString("hex") : Array.isArray(x) ? x.map(norm) : x);
export const sameSigner = (s: unknown, v: xdr.ScVal) => JSON.stringify(norm(s)) === JSON.stringify(norm(scValToNative(v)));

export const demoSignerScVal = (d: LegacyMigrationDeps) =>
  externalSignerScVal({ verifier: d.verifier, publicKeyHex: d.demoOwner.rawPublicKey().toString("hex") });

/** Owner-sign `op` with the demo owner (Default rule 0); simulate, and submit when `submit`. */
export async function ownerStep(d: LegacyMigrationDeps, sa: string, label: string, op: xdr.Operation, submit: boolean): Promise<string> {
  const { tx } = await buildAgentAuth({
    server: d.server,
    smartWallet: sa,
    networkPassphrase: d.networkPassphrase,
    contextRuleIds: [0],
    agentKeypair: d.demoOwner,
    verifier: d.verifier,
    op,
    feeSource: d.feeSource.publicKey(),
  });
  if (!submit) return `${label}: simulation OK`;
  tx.sign(d.feeSource);
  return `${label}: ${await sendTx(d.server, tx)}`;
}

/** Steps 1–3 for one wallet: simulated, or submitted when `apply`. */
export async function migrateLegacyWallet(d: LegacyMigrationDeps, t: LegacyWallet, apply: boolean): Promise<LegacyMigrationResult> {
  const r0 = await contextRule(d, t.smartWallet, 0);
  const demoIsOwner = r0.signers.some((s) => sameSigner(s, demoSignerScVal(d)));
  const userIsOwner = r0.signers.some((s) => sameSigner(s, delegatedSignerScVal(t.owner)));
  const result = { smartWallet: t.smartWallet, demoIsOwner, userIsOwner, lines: [] as string[] };
  if (!demoIsOwner) {
    result.lines.push(`skip: this env's demo owner is not an owner here (${userIsOwner ? "already user-owned" : "unknown owner"})`);
    return result;
  }

  const steps: Array<[string, xdr.Operation]> = [];
  if (!(await contextRule(d, t.smartWallet, t.poolRuleId)).policies.includes(d.guard.id)) {
    steps.push([
      "add guard to pool rule",
      addPolicyOp({
        smartWallet: t.smartWallet,
        contextRuleId: t.poolRuleId,
        policy: d.guard.id,
        installParam: riskGateParams({
          registry: d.guard.registry ?? null,
          minScore: d.guard.registry ? d.guard.minScore : 0,
          maxAgeSecs: d.guard.registry ? d.guard.maxAgeSecs : 0n,
          allowedRecipients: [],
        }),
      }),
    ]);
  }
  if (!(await contextRule(d, t.smartWallet, t.usdcRuleId)).policies.includes(d.guard.id)) {
    steps.push([
      "add guard to usdc rule",
      addPolicyOp({
        smartWallet: t.smartWallet,
        contextRuleId: t.usdcRuleId,
        policy: d.guard.id,
        installParam: riskGateParams({ registry: null, minScore: 0, maxAgeSecs: 0n, allowedRecipients: [d.execPoolId] }),
      }),
    ]);
  }
  // Last: once the user is a co-owner, the Default rule needs both signatures.
  if (!userIsOwner) {
    steps.push([
      "add user as owner (Delegated)",
      new Contract(t.smartWallet).call("add_signer", xdr.ScVal.scvU32(0), delegatedSignerScVal(t.owner)),
    ]);
  }
  for (const [label, op] of steps) result.lines.push(await ownerStep(d, t.smartWallet, label, op, apply));
  if (!steps.length) result.lines.push("nothing to do: guards present, user is co-owner");
  return result;
}
