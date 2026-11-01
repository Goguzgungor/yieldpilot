import { NextResponse } from "next/server";
import { BASE_FEE, TransactionBuilder } from "@stellar/stellar-sdk";
import { z } from "zod";
import { getRuntime } from "../../../../lib/runtime";
import { getDemoOwnerKeypair } from "../../../../lib/agentKeys";
import { addAgentRuleOps, buildDelegatedOwnerTx } from "../../../../lib/smartAccount";
import { buildFinalizeOwnershipTx, readOwnershipMode } from "../../../../lib/ownership";
import {
  DEFAULT_CAP_STROOPS,
  PERIOD_LEDGERS,
  buildDeployOp,
  buildFundUsdcOp,
  opFromXdr,
} from "../../../../lib/onboarding";

export const dynamic = "force-dynamic";

const PrepareInput = z.object({
  owner: z.string().min(1),
  step: z.enum(["deploy", "authorize-pool", "authorize-usdc", "fund", "finalize-ownership"]),
  /** Smart wallet C-address (required for `authorize-*` and `fund`). */
  smartWallet: z.string().min(1).optional(),
  /** Amount in stroops (decimal string) — required for `fund`. */
  amountStroops: z.string().regex(/^\d+$/).optional(),
});

/**
 * POST /api/onboard/prepare — server-side build + simulate/assemble of an
 * onboarding transaction the USER signs in Freighter. Returns an UNSIGNED,
 * fully-prepared (footprint/resources merged) tx XDR.
 *
 * We keep the heavy `@stellar/stellar-sdk` work server-side so the browser
 * bundle stays SDK-free; the client only runs Freighter `signTransaction` on
 * the returned XDR, then POSTs it to `/api/onboard/submit`.
 *
 *   step="deploy"         → createCustomContract (new per-user smart account)
 *                           whose Default-rule owner is `Delegated(owner)` —
 *                           the user's own G-account. Response also includes
 *                           the deterministic `contractId`.
 *   step="authorize-pool" → add_context_rule(CallContract(POOL)) for the agent,
 *                           guarded by the Vigil RiskGate policy.
 *   step="authorize-usdc" → add_context_rule(CallContract(USDC)), spending-capped
 *                           and guarded (transfers may only pay the pool).
 *                           Both are owner-authorized via the Delegated signer
 *                           (smartAccount.ts buildDelegatedOwnerTx): the nested
 *                           __check_auth authorization is a source-account
 *                           entry, so the user's envelope signature covers it.
 *   step="fund"           → USDC SAC transfer(owner → smartWallet, amountStroops).
 *   step="finalize-ownership" → legacy wallets only, after
 *                           scripts/migrate-legacy-accounts.ts made the user
 *                           co-owner: remove the backend demo owner, co-signed
 *                           by the backend for exactly this call.
 *
 * In every step the user signs the whole envelope in Freighter; the backend
 * never holds an owner key for new wallets.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = PrepareInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body", details: parsed.error.flatten() }, { status: 400 });
  }
  const { owner, step } = parsed.data;

  let rt;
  try {
    rt = getRuntime();
  } catch (e) {
    return NextResponse.json({ error: `runtime unavailable: ${(e as Error).message}` }, { status: 500 });
  }
  const server = rt.execServer;
  const networkPassphrase = rt.cfg.execNetworkPassphrase;

  try {
    let opXdr: string;
    let contractId: string | undefined;

    if (step === "finalize-ownership") {
      const smartWallet = parsed.data.smartWallet;
      if (!smartWallet) {
        return NextResponse.json({ error: "finalize-ownership requires smartWallet" }, { status: 400 });
      }
      const demoOwner = getDemoOwnerKeypair();
      const mode = await readOwnershipMode({
        server,
        networkPassphrase,
        readerSource: rt.agentKeypair.publicKey(),
        smartWallet,
        owner,
        demoOwner: { verifier: rt.cfg.ed25519VerifierId, publicKeyHex: demoOwner.rawPublicKey().toString("hex") },
      });
      if (mode !== "co-owned") {
        return NextResponse.json({ error: `nothing to finalize: ownership is "${mode}"` }, { status: 409 });
      }
      const tx = await buildFinalizeOwnershipTx({
        server,
        networkPassphrase,
        smartWallet,
        owner,
        demoOwner,
        verifier: rt.cfg.ed25519VerifierId,
      });
      return NextResponse.json({ xdr: tx.toXDR() });
    }

    if (step === "authorize-pool" || step === "authorize-usdc") {
      const smartWallet = parsed.data.smartWallet;
      if (!smartWallet) {
        return NextResponse.json({ error: `${step} requires smartWallet` }, { status: 400 });
      }
      const { poolRuleOp, usdcRuleOp } = addAgentRuleOps({
        smartWallet,
        poolId: rt.cfg.execPoolId,
        usdcSac: rt.cfg.execUsdcContractId,
        verifier: rt.cfg.ed25519VerifierId,
        agentPublicKeyHex: rt.agentKeypair.rawPublicKey().toString("hex"),
        spendingPolicy: rt.cfg.spendingPolicyId,
        capStroops: DEFAULT_CAP_STROOPS,
        periodLedgers: PERIOD_LEDGERS,
        guard: rt.cfg.vigilGuard,
      });
      const tx = await buildDelegatedOwnerTx({
        server,
        smartWallet,
        owner,
        networkPassphrase,
        op: step === "authorize-pool" ? poolRuleOp : usdcRuleOp,
      });
      return NextResponse.json({ xdr: tx.toXDR() });
    }

    if (step === "deploy") {
      const deploy = buildDeployOp({ deployer: owner, ownerAddress: owner });
      opXdr = deploy.opXdr;
      contractId = deploy.contractId;
    } else {
      if (!parsed.data.smartWallet || !parsed.data.amountStroops) {
        return NextResponse.json({ error: "fund requires smartWallet + amountStroops" }, { status: 400 });
      }
      opXdr = buildFundUsdcOp({
        from: owner,
        smartWallet: parsed.data.smartWallet,
        amountStroops: BigInt(parsed.data.amountStroops),
      });
    }

    const source = await server.getAccount(owner);
    const tx = new TransactionBuilder(source, {
      fee: (Number(BASE_FEE) * 1000).toString(),
      networkPassphrase,
    })
      .addOperation(opFromXdr(opXdr))
      .setTimeout(180)
      .build();

    // Simulate + assemble so the Soroban footprint/resources/fee are correct
    // BEFORE the user signs (a signed envelope can't be re-assembled).
    const prepared = await server.prepareTransaction(tx);

    return NextResponse.json({ xdr: prepared.toXDR(), contractId });
  } catch (e) {
    return NextResponse.json({ error: `prepare ${step} failed: ${(e as Error).message}` }, { status: 500 });
  }
}
