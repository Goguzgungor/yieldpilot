/**
 * SPIKE (testnet, throwaway keys): can a plain G-account — i.e. a Freighter
 * wallet — OWN a per-user smart account on the deployed OZ SmartAccount wasm,
 * via `Signer::Delegated(G)` instead of the backend demo-owner External key?
 *
 * If yes, onboarding step 2 (`add_context_rule`) no longer needs the backend:
 * the SA's own auth entry carries `AuthPayload{context_rule_ids:[0],
 * signers:{Delegated(G): b""}}`, and the G-account authorizes the nested
 * `__check_auth` call that `require_auth_for_args` makes inside the SA.
 *
 * The deployed wasm is an OZ 0.7.x build (soroban-sdk 26), so which argument it
 * passes to `require_auth_for_args` is not documented. We try, in order:
 *   A. (signature_payload: BytesN<32>,)
 *   B. (auth_digest: BytesN<32>,)  where auth_digest = sha256(payload || ruleIds)
 *   C. (AuthDigestPreimage{account, context_rule_ids, signature_payload},)  [0.8.0]
 * and for each, two ways for the G-account to authorize the nested call:
 *   1. source-account credentials (covered by the tx envelope signature —
 *      Freighter `signTransaction`)
 *   2. address credentials signed over the standard Soroban preimage —
 *      exactly what Freighter `signAuthEntry` produces.
 *
 *   npx tsx scripts/spike-delegated-owner.ts
 */
import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Operation,
  StrKey,
  TransactionBuilder,
  authorizeEntry,
  hash,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import { SMART_ACCOUNT_WASM_HASH, buildAuthDigest, buildSignaturePayload } from "../src/lib/smartAccount";

const RPC = "https://soroban-testnet.stellar.org";
const PASS = "Test SDF Network ; September 2015";
const POOL = "CBI7WAUQ4NPQFZW4C3MDSVFAZJWV3RCLZSTTMA5OZ6BTPEQMOZZNSZ3Z";
const server = new rpc.Server(RPC);

const addr = (a: string) => nativeToScVal(Address.fromString(a), { type: "address" });
const delegated = (g: string) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Delegated"), addr(g)]);

async function fund(kp: Keypair) {
  const r = await fetch(`https://friendbot.stellar.org/?addr=${kp.publicKey()}`);
  if (!r.ok) throw new Error(`friendbot ${r.status}`);
}

async function submit(tx: Transaction, label: string): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") throw new Error(`${label}: send ERROR ${sent.errorResult?.toXDR("base64")}`);
  let g = await server.getTransaction(sent.hash);
  for (let i = 0; i < 30 && g.status === "NOT_FOUND"; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    g = await server.getTransaction(sent.hash);
  }
  if (g.status !== "SUCCESS") throw new Error(`${label}: ${g.status}`);
  console.log(`  ${label}: ${sent.hash}`);
  return g as rpc.Api.GetSuccessfulTransactionResponse;
}

async function deploySa(user: Keypair): Promise<string> {
  const salt = Buffer.from(Keypair.random().rawPublicKey());
  const op = Operation.createCustomContract({
    address: Address.fromString(user.publicKey()),
    wasmHash: Buffer.from(SMART_ACCOUNT_WASM_HASH, "hex"),
    salt,
    constructorArgs: [xdr.ScVal.scvVec([delegated(user.publicKey())]), xdr.ScVal.scvMap([])],
  });
  const tx = new TransactionBuilder(await server.getAccount(user.publicKey()), { fee: "10000000", networkPassphrase: PASS })
    .addOperation(op).setTimeout(120).build();
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(user);
  const res = await submit(prepared, "deploy SA (owner = Delegated(G))");
  return Address.fromScAddress(res.returnValue!.address()).toString();
}

function poolRuleOp(sa: string, agentHex: string, verifier: string): xdr.Operation {
  return new Contract(sa).call(
    "add_context_rule",
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("CallContract"), addr(POOL)]),
    nativeToScVal("agent-pool", { type: "string" }),
    xdr.ScVal.scvVoid(),
    xdr.ScVal.scvVec([
      xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("External"), addr(verifier), xdr.ScVal.scvBytes(Buffer.from(agentHex, "hex"))]),
    ]),
    xdr.ScVal.scvMap([]),
  );
}

type ArgKind = "A-payload" | "B-digest" | "C-preimage";
type CredKind = "source" | "address";

function checkAuthArg(kind: ArgKind, sa: string, payload: Buffer, ruleIds: number[]): xdr.ScVal {
  if (kind === "A-payload") return xdr.ScVal.scvBytes(payload);
  if (kind === "B-digest") return xdr.ScVal.scvBytes(buildAuthDigest(payload, ruleIds));
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("account"), val: addr(sa) }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("context_rule_ids"),
      val: xdr.ScVal.scvVec(ruleIds.map((i) => xdr.ScVal.scvU32(i))),
    }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("signature_payload"), val: xdr.ScVal.scvBytes(payload) }),
  ]);
}

/** Owner-authorize `op` on the SA with the Delegated G owner; returns the assembled tx or throws. */
async function ownerAuthorize(user: Keypair, sa: string, op: xdr.Operation, argKind: ArgKind, credKind: CredKind) {
  const ruleIds = [0];
  const src = await server.getAccount(user.publicKey());
  const built = new TransactionBuilder(src, { fee: "10000000", networkPassphrase: PASS }).addOperation(op).setTimeout(120).build();
  const sim1 = await server.simulateTransaction(built);
  if (rpc.Api.isSimulationError(sim1)) throw new Error(`sim1: ${sim1.error}`);
  const entries = (sim1.result?.auth ?? []).map((e) => xdr.SorobanAuthorizationEntry.fromXDR(e.toXDR()));
  const latest = (await server.getLatestLedger()).sequence;
  const exp = latest + 100;

  const saHex = Address.fromString(sa).toScAddress().toXDR("hex");
  const saEntry = entries.find(
    (e) => e.credentials().switch().name === "sorobanCredentialsAddress" && e.credentials().address().address().toXDR("hex") === saHex,
  );
  if (!saEntry) throw new Error("no SA auth entry in simulation");
  saEntry.credentials().address().signatureExpirationLedger(exp);
  const payload = buildSignaturePayload(PASS, saEntry, exp);
  saEntry.credentials().address().signature(
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("context_rule_ids"),
        val: xdr.ScVal.scvVec(ruleIds.map((i) => xdr.ScVal.scvU32(i))),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("signers"),
        val: xdr.ScVal.scvMap([new xdr.ScMapEntry({ key: delegated(user.publicKey()), val: xdr.ScVal.scvBytes(Buffer.alloc(0)) })]),
      }),
    ]),
  );

  const invocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(sa).toScAddress(),
        functionName: "__check_auth",
        args: [checkAuthArg(argKind, sa, payload, ruleIds)],
      }),
    ),
    subInvocations: [],
  });
  let nested: xdr.SorobanAuthorizationEntry;
  if (credKind === "source") {
    nested = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
      rootInvocation: invocation,
    });
  } else {
    const unsigned = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: Address.fromString(user.publicKey()).toScAddress(),
          nonce: xdr.Int64.fromString(BigInt.asIntN(64, BigInt(`0x${Keypair.random().rawPublicKey().subarray(0, 8).toString("hex")}`)).toString()),
          signatureExpirationLedger: 0,
          signature: xdr.ScVal.scvVoid(),
        }),
      ),
      rootInvocation: invocation,
    });
    // authorizeEntry signs sha256(HashIdPreimage.sorobanAuthorization) — the
    // same preimage Freighter's signAuthEntry signs.
    nested = await authorizeEntry(unsigned, user, exp, PASS);
  }

  const invokeOp = built.operations[0] as Operation.InvokeHostFunction;
  const signedOp = Operation.invokeHostFunction({ func: invokeOp.func, auth: [...entries, nested] });
  const preTx = new TransactionBuilder(await server.getAccount(user.publicKey()), { fee: "10000000", networkPassphrase: PASS })
    .addOperation(signedOp).setTimeout(120).build();
  const sim2 = await server.simulateTransaction(preTx);
  if (rpc.Api.isSimulationError(sim2)) throw new Error(`sim2: ${sim2.error.split("\n")[0]}`);
  return rpc.assembleTransaction(preTx, sim2).build();
}

async function main() {
  const user = Keypair.random();
  await fund(user);
  console.log("user (stands in for a Freighter G-account):", user.publicKey());
  const sa = await deploySa(user);
  console.log("smart account:", sa);

  const agentHex = Keypair.random().rawPublicKey().toString("hex");
  const verifier = "CBHJOANTAHF2ZKU5HZRZTWP4GX7YCSNR3V3AIMAH5P5R7S465SK24RSO";
  const results: string[] = [];
  let winner: { argKind: ArgKind; credKind: CredKind } | null = null;
  for (const argKind of ["A-payload", "B-digest", "C-preimage"] as ArgKind[]) {
    for (const credKind of ["source", "address"] as CredKind[]) {
      try {
        const tx = await ownerAuthorize(user, sa, poolRuleOp(sa, agentHex, verifier), argKind, credKind);
        results.push(`${argKind} + ${credKind}: simulate OK`);
        if (!winner) {
          tx.sign(user);
          await submit(tx, `add_context_rule via ${argKind} + ${credKind}`);
          winner = { argKind, credKind };
        }
      } catch (e) {
        results.push(`${argKind} + ${credKind}: ${(e as Error).message.slice(0, 160)}`);
      }
    }
  }
  console.log("\nresults:");
  for (const r of results) console.log("  " + r);

  const readTx = new TransactionBuilder(await server.getAccount(user.publicKey()), { fee: BASE_FEE, networkPassphrase: PASS })
    .addOperation(new Contract(sa).call("get_context_rules_count")).setTimeout(30).build();
  const sim = await server.simulateTransaction(readTx);
  if (!rpc.Api.isSimulationError(sim)) console.log("\nget_context_rules_count =", scValToNative(sim.result!.retval));
  console.log("winner:", winner ?? "none");
  console.log("G raw key (hex):", Buffer.from(StrKey.decodeEd25519PublicKey(user.publicKey())).toString("hex"), "network id:", hash(Buffer.from(PASS)).toString("hex").slice(0, 8));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
