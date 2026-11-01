/**
 * SERVER-ONLY: who owns a per-user smart account (its Default rule 0 signers),
 * and the co-signed hand-over that removes the backend demo owner from a legacy
 * wallet.
 *
 *   "user"     — the user's G is the only owner (`Delegated(G)`); new wallets.
 *   "co-owned" — `Delegated(G)` + the demo owner: scripts/migrate-legacy-accounts.ts
 *                has run; a rule without policies needs every signer, so the
 *                backend can no longer act alone. The user finalizes.
 *   "backend"  — only the demo owner (legacy, not migrated yet).
 *   "unknown"  — anything else.
 */
import { BASE_FEE, Contract, TransactionBuilder, rpc, scValToNative, xdr, type Keypair, type Transaction } from "@stellar/stellar-sdk";
import {
  buildDelegatedOwnerTx,
  delegatedSignerScVal,
  externalSignerScVal,
  type SimulatingServer,
} from "./smartAccount";

export type OwnershipMode = "user" | "co-owned" | "backend" | "unknown";

const norm = (x: unknown): unknown => (Buffer.isBuffer(x) ? x.toString("hex") : Array.isArray(x) ? x.map(norm) : x);
const same = (decoded: unknown, encoded: xdr.ScVal) =>
  JSON.stringify(norm(decoded)) === JSON.stringify(norm(scValToNative(encoded)));

/** Classify a Default-rule signer list (scValToNative form). PURE. */
export function classifyOwners(signers: unknown[], owner: string, demoOwner: { verifier: string; publicKeyHex: string }): OwnershipMode {
  const hasUser = signers.some((s) => same(s, delegatedSignerScVal(owner)));
  const hasDemo = signers.some((s) => same(s, externalSignerScVal(demoOwner)));
  if (hasUser && signers.length === 1) return "user";
  if (hasUser && hasDemo && signers.length === 2) return "co-owned";
  if (hasDemo && signers.length === 1) return "backend";
  return "unknown";
}

async function simulateRead(opts: {
  server: SimulatingServer;
  networkPassphrase: string;
  readerSource: string;
  contract: string;
  fn: string;
  args: xdr.ScVal[];
}): Promise<unknown> {
  const tx = new TransactionBuilder(await opts.server.getAccount(opts.readerSource), {
    fee: BASE_FEE,
    networkPassphrase: opts.networkPassphrase,
  })
    .addOperation(new Contract(opts.contract).call(opts.fn, ...opts.args))
    .setTimeout(30)
    .build();
  const sim = await opts.server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`${opts.fn}: ${sim.error.split("\n")[0]}`);
  return scValToNative((sim as rpc.Api.SimulateTransactionSuccessResponse).result!.retval);
}

export async function readOwnershipMode(opts: {
  server: SimulatingServer;
  networkPassphrase: string;
  readerSource: string;
  smartWallet: string;
  owner: string;
  demoOwner: { verifier: string; publicKeyHex: string };
}): Promise<OwnershipMode> {
  const rule = (await simulateRead({ ...opts, contract: opts.smartWallet, fn: "get_context_rule", args: [xdr.ScVal.scvU32(0)] })) as {
    signers: unknown[];
  };
  return classifyOwners(rule.signers, opts.owner, opts.demoOwner);
}

/**
 * The finalize-ownership tx for a CO-OWNED legacy wallet: `remove_signer(0,
 * demoOwnerId)`, with the backend's External signature already in the auth
 * payload and the user as tx source. The user signs the envelope (Freighter
 * `signTransaction`), which also covers their Delegated authorization. The
 * backend's signature is bound to this exact invocation, so it cannot be
 * reused for anything else.
 */
export async function buildFinalizeOwnershipTx(opts: {
  server: SimulatingServer;
  networkPassphrase: string;
  smartWallet: string;
  owner: string;
  demoOwner: Keypair;
  verifier: string;
}): Promise<Transaction> {
  const demoKey = { verifier: opts.verifier, publicKeyHex: opts.demoOwner.rawPublicKey().toString("hex") };
  const signerId = Number(
    await simulateRead({
      server: opts.server,
      networkPassphrase: opts.networkPassphrase,
      readerSource: opts.owner,
      contract: opts.smartWallet,
      fn: "get_signer_id",
      args: [externalSignerScVal(demoKey)],
    }),
  );
  return buildDelegatedOwnerTx({
    server: opts.server,
    smartWallet: opts.smartWallet,
    owner: opts.owner,
    networkPassphrase: opts.networkPassphrase,
    op: new Contract(opts.smartWallet).call("remove_signer", xdr.ScVal.scvU32(0), xdr.ScVal.scvU32(signerId)),
    coSigners: [{ key: demoKey, keypair: opts.demoOwner }],
  });
}
