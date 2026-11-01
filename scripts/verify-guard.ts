/**
 * VERIFY (testnet, throwaway keys only): the agent-rule drain hole exists, and
 * the Vigil RiskGate policy closes it — on a REAL smart account against the
 * REAL exec Blend pool.
 *
 * Input: a user-owned wallet from scripts/verify-onboarding-owner.ts (its rules
 * were created WITHOUT the guard), funded with test USDC:
 *   SA=C… OWNER_SECRET=S… POOL_RULE=1 USDC_RULE=2 \
 *   AGENT_SECRET=S… PUBLISHER_SECRET=S… npx tsx scripts/verify-guard.ts
 * (AGENT_SECRET must be the agent key the rules were created for;
 * PUBLISHER_SECRET a publisher on the registry.)
 *
 * BEFORE (no guard):  agent supplies → OK; agent withdraws the position to an
 *                     attacker → OK  (the hole).
 * Owner attaches the guard to both rules with add_policy (Freighter-style
 * envelope signature, Delegated owner).
 * AFTER:   supply with a fresh rating ≥ 60 → OK
 *          withdraw to attacker → rejected (#4109 AccountMismatch)
 *          direct USDC transfer to attacker → rejected (#4113 RecipientNotAllowed)
 *          borrow → rejected (#4111 RequestTypeNotAllowed)
 *          rating drops to 30 → supply rejected (#4115 ScoreTooLow)
 *          …but withdraw back to the wallet still works (exit never blocked).
 */
import {
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Keypair,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import { PoolContractV2, RequestType } from "@blend-capital/blend-sdk";
import {
  addPolicyOp,
  buildAgentAuth,
  buildDelegatedOwnerTx,
  riskGateParams,
  signSmartAccountEntries,
} from "../src/lib/smartAccount";

const PASS = "Test SDF Network ; September 2015";
const POOL = "CBI7WAUQ4NPQFZW4C3MDSVFAZJWV3RCLZSTTMA5OZ6BTPEQMOZZNSZ3Z";
const USDC = "CD2R7WREEPGIAXZL4ASB76Y6PWTY6ZZXZ6C64AIKFDIG36YKQPNY6B2I";
const VERIFIER = "CBHJOANTAHF2ZKU5HZRZTWP4GX7YCSNR3V3AIMAH5P5R7S465SK24RSO";
const GUARD = process.env.VIGIL_GUARD_ID ?? "CD6BDS7R5K3IUCQSJUZUWAGLTR47EZOYEVCO5MPT7YGNBNQRHSNY5VMS";
const REGISTRY = process.env.VIGIL_REGISTRY_ID ?? "CB4LXLCCD7YDND5FBVXPKPHUQMF7JFSDRVXHG7ZZTWWNPJ6WDCXDNDF6";
const server = new rpc.Server("https://soroban-testnet.stellar.org");

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};
const SA = need("SA");
const owner = Keypair.fromSecret(need("OWNER_SECRET"));
const agent = Keypair.fromSecret(need("AGENT_SECRET"));
const publisher = Keypair.fromSecret(need("PUBLISHER_SECRET"));
const POOL_RULE = Number(need("POOL_RULE"));
const USDC_RULE = Number(need("USDC_RULE"));
const U = 10_000_000n; // 1 USDC in stroops

const results: Array<{ step: string; expected: string; got: string; pass: boolean }> = [];

async function friendbot(kp: Keypair) {
  try {
    await server.getAccount(kp.publicKey());
  } catch {
    const r = await fetch(`https://friendbot.stellar.org/?addr=${kp.publicKey()}`);
    if (!r.ok) throw new Error(`friendbot ${r.status}`);
  }
}

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

async function readUsdc(who: string): Promise<bigint> {
  const tx = new TransactionBuilder(await server.getAccount(agent.publicKey()), { fee: BASE_FEE, networkPassphrase: PASS })
    .addOperation(new Contract(USDC).call("balance", nativeToScVal(Address.fromString(who), { type: "address" })))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) return -1n;
  return BigInt(scValToNative(sim.result!.retval));
}

function submitOp(to: string, requestType: RequestType, amount: bigint): xdr.Operation {
  const opXdr = new PoolContractV2(POOL).submit({
    from: SA,
    spender: SA,
    to,
    requests: [{ request_type: requestType, address: USDC, amount }],
  });
  return xdr.Operation.fromXDR(opXdr, "base64");
}

/** Agent-signed call through the smart account; returns the tx hash or the error text. */
async function agentCall(op: xdr.Operation, contextRuleIds: number[]): Promise<{ ok: boolean; detail: string }> {
  try {
    const { tx } = await buildAgentAuth({
      server,
      smartWallet: SA,
      networkPassphrase: PASS,
      contextRuleIds,
      agentKeypair: agent,
      verifier: VERIFIER,
      op,
    });
    tx.sign(agent);
    return { ok: true, detail: await send(tx) };
  } catch (e) {
    const m = (e as Error).message;
    const code = m.match(/Error\(Contract, #\d+\)/)?.[0];
    return { ok: false, detail: code ?? m.split("\n")[0].slice(0, 140) };
  }
}

/**
 * Like agentCall, but builds the SA auth entry by hand and simulates in
 * enforcing mode straight away. Needed when the pool itself would reject the
 * call in the recording-mode first pass (e.g. a borrow) — that pass mocks
 * __check_auth, so the guard never runs. Blend's submit calls
 * `from.require_auth()` first, so here the guard is the first thing to decide.
 */
async function agentCallEnforced(op: xdr.Operation, contextRuleIds: number[]): Promise<{ ok: boolean; detail: string }> {
  const call = (op.body().value() as xdr.InvokeHostFunctionOp).hostFunction().invokeContract();
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(SA).toScAddress(),
        nonce: xdr.Int64.fromString(String(Math.floor(Math.random() * 2 ** 48))),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call),
      subInvocations: [],
    }),
  });
  signSmartAccountEntries({
    entries: [entry],
    smartAccount: SA,
    networkPassphrase: PASS,
    expirationLedger: (await server.getLatestLedger()).sequence + 100,
    contextRuleIds,
    signers: [{ key: { verifier: VERIFIER, publicKeyHex: agent.rawPublicKey().toString("hex") }, keypair: agent }],
  });
  const tx = new TransactionBuilder(await server.getAccount(agent.publicKey()), { fee: "1000000", networkPassphrase: PASS })
    .addOperation(Operation.invokeHostFunction({ func: (op.body().value() as xdr.InvokeHostFunctionOp).hostFunction(), auth: [entry] }))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationError(sim)) return { ok: true, detail: "simulation passed (not submitted)" };
  const code = sim.error.match(/Error\(Contract, #\d+\)/)?.[0];
  return { ok: false, detail: code ?? sim.error.split("\n")[0].slice(0, 140) };
}

function record(step: string, expected: "OK" | string, r: { ok: boolean; detail: string }) {
  const pass = expected === "OK" ? r.ok : !r.ok && r.detail.includes(expected);
  results.push({ step, expected, got: r.ok ? `OK ${r.detail.slice(0, 12)}…` : r.detail, pass });
  console.log(`${pass ? "✓" : "✗"} ${step.padEnd(54)} expected ${expected.padEnd(22)} got ${r.ok ? `OK (${r.detail})` : r.detail}`);
}

async function ownerCall(op: xdr.Operation): Promise<string> {
  const tx = await buildDelegatedOwnerTx({ server, smartWallet: SA, owner: owner.publicKey(), networkPassphrase: PASS, op });
  tx.sign(owner); // == Freighter signTransaction
  return send(tx);
}

async function publish(score: number): Promise<string> {
  const ledger = await server.getLatestLedger();
  const ts = BigInt(Math.floor(Date.now() / 1000) - 60);
  const op = new Contract(REGISTRY).call(
    "publish",
    nativeToScVal(Address.fromString(publisher.publicKey()), { type: "address" }),
    nativeToScVal(Address.fromString(POOL), { type: "address" }),
    xdr.ScVal.scvU32(score),
    xdr.ScVal.scvU64(xdr.Uint64.fromString(ts.toString())),
    xdr.ScVal.scvBytes(Buffer.alloc(32, ledger.sequence % 256)),
  );
  const tx = new TransactionBuilder(await server.getAccount(publisher.publicKey()), { fee: "1000000", networkPassphrase: PASS })
    .addOperation(op)
    .setTimeout(120)
    .build();
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(publisher);
  return send(prepared);
}

async function makeAttacker(): Promise<Keypair> {
  // A plain G-account with a trustline to the exec USDC, so a withdrawal "to"
  // it can actually land (that is the attack).
  const attacker = Keypair.random();
  await friendbot(attacker);
  const name = await (async () => {
    const tx = new TransactionBuilder(await server.getAccount(agent.publicKey()), { fee: BASE_FEE, networkPassphrase: PASS })
      .addOperation(new Contract(USDC).call("name"))
      .setTimeout(30)
      .build();
    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw new Error("USDC name()");
    return String(scValToNative(sim.result!.retval));
  })();
  const [code, issuer] = name.split(":");
  const horizon = await fetch(`https://horizon-testnet.stellar.org/accounts/${attacker.publicKey()}`).then((r) => r.json());
  const { Account } = await import("@stellar/stellar-sdk");
  const tx = new TransactionBuilder(new Account(attacker.publicKey(), horizon.sequence), { fee: BASE_FEE, networkPassphrase: PASS })
    .addOperation(Operation.changeTrust({ asset: new Asset(code, issuer) }))
    .setTimeout(60)
    .build();
  tx.sign(attacker);
  const res = await fetch("https://horizon-testnet.stellar.org/transactions", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `tx=${encodeURIComponent(tx.toXDR())}`,
  });
  if (!res.ok) throw new Error(`changeTrust ${res.status} ${await res.text()}`);
  return attacker;
}

async function main() {
  if (process.env.ONLY === "borrow") {
    // Re-check just the borrow case on a wallet that already has the guard.
    record("agent borrows 1 USDC (to the SA)", "#4111", await agentCallEnforced(submitOp(SA, RequestType.Borrow, 1n * U), [POOL_RULE]));
    return;
  }
  await friendbot(agent);
  await friendbot(publisher);
  const attacker = await makeAttacker();
  console.log(`SA ${SA}\nagent ${agent.publicKey()}\nattacker ${attacker.publicKey()}\n`);
  console.log(`SA USDC: ${(await readUsdc(SA)) / U}`);

  console.log("\n── BEFORE: agent rules without the guard ──");
  record("agent supplies 20 USDC (legit)", "OK", await agentCall(submitOp(SA, RequestType.SupplyCollateral, 20n * U), [POOL_RULE, USDC_RULE]));
  const before = await readUsdc(attacker.publicKey());
  record("agent withdraws 10 USDC to ATTACKER (the hole)", "OK", await agentCall(submitOp(attacker.publicKey(), RequestType.WithdrawCollateral, 10n * U), [POOL_RULE]));
  console.log(`  attacker USDC: ${before / U} → ${(await readUsdc(attacker.publicKey())) / U}`);

  console.log("\n── owner attaches the Vigil guard (add_policy ×2, Freighter-style signature) ──");
  console.log("  pool rule:", await ownerCall(addPolicyOp({
    smartWallet: SA, contextRuleId: POOL_RULE, policy: GUARD,
    installParam: riskGateParams({ registry: REGISTRY, minScore: 60, maxAgeSecs: 3600n, allowedRecipients: [] }),
  })));
  console.log("  usdc rule:", await ownerCall(addPolicyOp({
    smartWallet: SA, contextRuleId: USDC_RULE, policy: GUARD,
    installParam: riskGateParams({ registry: null, minScore: 0, maxAgeSecs: 0n, allowedRecipients: [POOL] }),
  })));
  console.log("  rating 80 published:", await publish(80));

  console.log("\n── AFTER: guarded ──");
  record("agent supplies 5 USDC, rating 80 ≥ 60", "OK", await agentCall(submitOp(SA, RequestType.SupplyCollateral, 5n * U), [POOL_RULE, USDC_RULE]));
  record("agent withdraws 5 USDC to ATTACKER", "#4109", await agentCall(submitOp(attacker.publicKey(), RequestType.WithdrawCollateral, 5n * U), [POOL_RULE]));
  record("agent transfers 1 USDC from SA to ATTACKER directly", "#4113", await agentCall(
    new Contract(USDC).call(
      "transfer",
      nativeToScVal(Address.fromString(SA), { type: "address" }),
      nativeToScVal(Address.fromString(attacker.publicKey()), { type: "address" }),
      nativeToScVal(1n * U, { type: "i128" }),
    ),
    [USDC_RULE],
  ));
  record("agent borrows 1 USDC (to the SA)", "#4111", await agentCallEnforced(submitOp(SA, RequestType.Borrow, 1n * U), [POOL_RULE]));
  console.log("  rating 30 published:", await publish(30));
  record("agent supplies 1 USDC, rating 30 < 60", "#4115", await agentCall(submitOp(SA, RequestType.SupplyCollateral, 1n * U), [POOL_RULE, USDC_RULE]));
  record("agent withdraws 5 USDC back to the SA, rating 30", "OK", await agentCall(submitOp(SA, RequestType.WithdrawCollateral, 5n * U), [POOL_RULE]));
  console.log(`\nattacker USDC final: ${(await readUsdc(attacker.publicKey())) / U}  ·  SA USDC: ${(await readUsdc(SA)) / U}`);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
