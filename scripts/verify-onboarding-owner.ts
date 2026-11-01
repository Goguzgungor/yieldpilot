/**
 * VERIFY (testnet): the user-owned onboarding flow through the REAL API routes.
 *
 * A fresh friendbot-funded keypair stands in for the user's Freighter account
 * and signs exactly what Freighter's `signTransaction` would sign: the
 * server-prepared envelope. Steps:
 *   1. /api/onboard/prepare deploy           → sign → /api/onboard/submit
 *   2. /api/onboard/prepare authorize-pool   → sign → submit (returns rule id)
 *      /api/onboard/prepare authorize-usdc   → sign → submit (returns rule id)
 *   3. read get_context_rule(0) and assert the Default-rule owner is
 *      Delegated(user) — i.e. the backend holds no owner key.
 *   4. optionally fund via the faucet (FAUCET_URL, e.g. https://yieldpilot.org)
 *      and print the SA's USDC balance.
 *
 *   BASE_URL=http://localhost:3000 npx tsx scripts/verify-onboarding-owner.ts
 *
 * Prints the smart account id and rule ids so follow-up scripts (e.g. the
 * guard proof) can reuse the account: SA=… POOL_RULE=… USDC_RULE=…
 */
import { Address, BASE_FEE, Contract, Keypair, TransactionBuilder, nativeToScVal, rpc, scValToNative } from "@stellar/stellar-sdk";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const FAUCET = process.env.FAUCET_URL;
const PASS = "Test SDF Network ; September 2015";
const server = new rpc.Server("https://soroban-testnet.stellar.org");

async function post<T>(path: string, body: unknown, base = BASE): Promise<T> {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}: ${j.error ?? JSON.stringify(j)}`);
  return j;
}

async function step(user: Keypair, body: Record<string, unknown>, label: string) {
  const prep = await post<{ xdr: string; contractId?: string }>("/api/onboard/prepare", { owner: user.publicKey(), ...body });
  const tx = TransactionBuilder.fromXDR(prep.xdr, PASS);
  tx.sign(user); // == Freighter signTransaction
  const sub = await post<{ hash: string; success: boolean; contextRuleId?: number }>("/api/onboard/submit", {
    signedXdr: tx.toXDR(),
    label,
  });
  console.log(`  ${label}: ${sub.hash}${sub.contextRuleId !== undefined ? ` (rule #${sub.contextRuleId})` : ""}`);
  return { ...sub, contractId: prep.contractId };
}

async function read(user: Keypair, contract: string, fn: string, ...args: Parameters<Contract["call"]>[1][]) {
  const tx = new TransactionBuilder(await server.getAccount(user.publicKey()), { fee: BASE_FEE, networkPassphrase: PASS })
    .addOperation(new Contract(contract).call(fn, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`${fn}: ${sim.error}`);
  return scValToNative(sim.result!.retval);
}

async function main() {
  const user = Keypair.random();
  const fb = await fetch(`https://friendbot.stellar.org/?addr=${user.publicKey()}`);
  if (!fb.ok) throw new Error(`friendbot ${fb.status}`);
  console.log("user (Freighter stand-in):", user.publicKey());

  const deploy = await step(user, { step: "deploy" }, "deploy");
  const sa = deploy.contractId!;
  const pool = await step(user, { step: "authorize-pool", smartWallet: sa }, "authorize pool rule");
  const usdc = await step(user, { step: "authorize-usdc", smartWallet: sa }, "authorize usdc rule");

  const rule0 = await read(user, sa, "get_context_rule", nativeToScVal(0, { type: "u32" }));
  const ownerSigner = rule0.signers[0];
  const ownerOk = ownerSigner[0] === "Delegated" && ownerSigner[1] === user.publicKey();
  console.log(`  Default-rule owner: ${ownerSigner[0]}(${ownerSigner[1]}) → ${ownerOk ? "USER-OWNED ✓" : "NOT user-owned ✗"}`);
  const poolRule = await read(user, sa, "get_context_rule", nativeToScVal(pool.contextRuleId!, { type: "u32" }));
  const usdcRule = await read(user, sa, "get_context_rule", nativeToScVal(usdc.contextRuleId!, { type: "u32" }));
  console.log(`  rule #${pool.contextRuleId} "${poolRule.name}" policies: ${poolRule.policies.length}`);
  console.log(`  rule #${usdc.contextRuleId} "${usdcRule.name}" policies: ${usdcRule.policies.length}`);

  if (FAUCET) {
    const f = await post<{ txHash: string; balanceStroops: string | null }>("/api/faucet", { to: sa, amount: 100 }, FAUCET);
    console.log(`  faucet: ${f.txHash} balance ${f.balanceStroops}`);
  }
  const bal = await read(user, "CD2R7WREEPGIAXZL4ASB76Y6PWTY6ZZXZ6C64AIKFDIG36YKQPNY6B2I", "balance", nativeToScVal(Address.fromString(sa), { type: "address" }));
  console.log(`\nSA=${sa} POOL_RULE=${pool.contextRuleId} USDC_RULE=${usdc.contextRuleId} OWNER_SECRET=${user.secret()} USDC=${bal}`);
  if (!ownerOk) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
