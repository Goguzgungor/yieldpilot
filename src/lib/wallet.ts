import {
  Keypair,
  TransactionBuilder,
  Transaction,
  FeeBumpTransaction,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { buildAgentAuth } from "./smartAccount";
import type { TxResult } from "./types";
import { createRpcServer } from "./rpcServer";

export interface Wallet {
  /**
   * The address funds move FROM in a Blend submit. For the keypair wallet this
   * is the agent's own G-address; for the smart-account wallet this is the
   * smart wallet's C-address (the agent only signs on its behalf).
   */
  address(): string;
  /** Sign a base64 tx envelope XDR; return signed base64 XDR. */
  signXdr(xdr: string): string;
  /**
   * OPTIONAL smart-account fast-path. When present, the executor hands the bare
   * Blend operation (base64 op XDR) to the wallet, which performs the full
   * two-pass simulate + AuthPayload build + envelope-sign + submit + poll, and
   * returns the result. The keypair wallet does NOT implement this (it uses the
   * executor's own simulate → signXdr → submit path), so the legacy flow is
   * untouched.
   *
   * This is the minimal `Wallet`/executor contract change required: the
   * smart-account flow cannot be expressed as a single-pass `signXdr` of a
   * pre-built tx — the footprint must be re-discovered AFTER the SA auth entry
   * is signed (see {@link buildAgentAuth}). So we let the wallet own the whole
   * round-trip when it is a policy signer.
   */
  submitOp?(opXdrBase64: string): Promise<TxResult>;
}

// MVP signer: agent holds a funded ed25519 key. Caps are enforced in executor/orchestrator.
export function createKeypairWallet(kp: Keypair, networkPassphrase: string): Wallet {
  return {
    address: () => kp.publicKey(),
    signXdr(xdr: string) {
      const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase) as Transaction | FeeBumpTransaction;
      tx.sign(kp);
      return tx.toXDR();
    },
  };
}

/**
 * ARMA-style policy-signer wallet (PROVEN on testnet — spike-prove-flow.ts).
 *
 * The agent (`agentKeypair`) is a RESTRICTED External ed25519 policy signer on a
 * Soroban smart account (`smartWalletId`). It can only authorize the contexts
 * its context rules allow — for our loop: `CallContract(POOL)` (the pool rule)
 * and the nested `CallContract(USDC)` transfer (the USDC rule, spending-capped).
 *
 * `submitOp` builds + signs the smart account's OWN auth entry for the supplied
 * Blend operation via {@link buildAgentAuth} (two-pass simulate so the
 * __check_auth footprint is correct), then envelope-signs with the agent
 * (fee source) and submits, polling to a final status. `address()` returns the
 * SMART WALLET id (funds move from it), and `signXdr` envelope-signs with the
 * agent key (used for the final assembled tx).
 *
 * `contextRuleIds` is ordered to match the invocation tree the agent signs over.
 * A Blend `pool.submit` that supplies USDC produces a root `CallContract(POOL)`
 * with a nested `CallContract(USDC).transfer`, so both the pool rule id and the
 * USDC rule id are presented.
 */
export function createPolicySignerWallet(opts: {
  /** The user's smart account (C...) contract id. */
  smartWalletId: string;
  /** Backend agent keypair (the External ed25519 policy signer). */
  agentKeypair: Keypair;
  rpcUrl: string;
  networkPassphrase: string;
  /** ed25519-verifier contract id the smart account is configured with. */
  verifier: string;
  /**
   * Context rule id(s) the agent signs under. For a pool supply pass both the
   * pool rule id and the USDC rule id (order-insensitive for the policy check;
   * see spike-prove-flow.ts).
   */
  contextRuleIds: number[];
  /** Optional injected server (tests). Defaults to a real rpc.Server. */
  server?: rpc.Server;
}): Wallet {
  const server =
    opts.server ?? createRpcServer(opts.rpcUrl, { allowHttp: opts.rpcUrl.startsWith("http://") });
  const agent = opts.agentKeypair;

  return {
    address: () => opts.smartWalletId,
    signXdr(envXdr: string) {
      const tx = TransactionBuilder.fromXDR(envXdr, opts.networkPassphrase) as
        | Transaction
        | FeeBumpTransaction;
      tx.sign(agent);
      return tx.toXDR();
    },
    async submitOp(opXdrBase64: string): Promise<TxResult> {
      try {
        const op = xdr.Operation.fromXDR(opXdrBase64, "base64");
        // Two-pass simulate + SA AuthPayload build → assembled, not-yet-signed tx.
        const { tx } = await buildAgentAuth({
          server,
          smartWallet: opts.smartWalletId,
          networkPassphrase: opts.networkPassphrase,
          contextRuleIds: opts.contextRuleIds,
          agentKeypair: agent,
          verifier: opts.verifier,
          op,
          // The agent funds the fee / is the tx source (matches the proven spike).
          feeSource: agent.publicKey(),
        });
        tx.sign(agent);

        const sent = await server.sendTransaction(tx);
        if (sent.status === "ERROR") {
          const err = JSON.stringify(
            (sent as rpc.Api.SendTransactionResponse & { errorResult?: unknown }).errorResult ??
              sent.status,
          );
          return { hashes: [sent.hash], success: false, error: `(send ERROR) ${err}` };
        }
        let g = await server.getTransaction(sent.hash);
        for (let i = 0; i < 15 && g.status === "NOT_FOUND"; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          g = await server.getTransaction(sent.hash);
        }
        return {
          hashes: [sent.hash],
          success: g.status === "SUCCESS",
          error: g.status === "SUCCESS" ? undefined : g.status,
        };
      } catch (e) {
        return { hashes: [], success: false, error: (e as Error).message };
      }
    },
  };
}
