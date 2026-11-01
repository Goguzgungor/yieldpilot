/**
 * Per-user Freighter onboarding — CLIENT-SAFE helpers.
 *
 * This module is imported by the browser onboarding UI, so it must stay free of
 * any node-only dependency (no `better-sqlite3`, no `process.env` reads, no
 * `./config` which calls `parseConfig`). It only uses `@stellar/stellar-sdk`
 * (pure, browser-safe) + the pure op builders in {@link ./smartAccount}.
 *
 * The on-chain constants (verifier / pool / USDC / policy ids, network) are the
 * SAME defaults baked into `src/lib/config.ts`'s zod schema. They are duplicated
 * here as plain literals so the client bundle never imports the server config.
 * `/api/agent` also returns the agent + demo-owner public keys at runtime, so a
 * deployment that overrides these via env still drives the UI correctly.
 *
 * Ownership: the wallet is deployed with the user's own G-account as its
 * Default-rule owner (`Signer::Delegated(G)`), so the user — not the backend —
 * controls rule management, upgrades and withdrawals. Every step is a normal
 * Freighter `signTransaction`:
 *   - Step 1 (deploy) and 3 (fund) are account-signed transactions.
 *   - Step 2 (`add_context_rule` ×2) is owner-authorized through the Delegated
 *     signer: the server builds the SA auth entry plus the nested
 *     `__check_auth` authorization as a source-account entry, which the
 *     user's envelope signature covers (see smartAccount.ts
 *     `delegatedOwnerAuthEntries`, proven by scripts/spike-delegated-owner.ts).
 *
 * Accounts onboarded before this change are owned by a backend demo-owner key
 * (agentKeys.ts); scripts/migrate-legacy-accounts.ts hands them over.
 */
import { Address, Contract, StrKey, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { deploySmartWalletOp, addAgentRuleOps } from "./smartAccount";

// ─────────────────────────────────────────────────────────────────────────────
// On-chain constants (mirror of config.ts zod defaults; exec side = testnet).
// ─────────────────────────────────────────────────────────────────────────────

/** Exec (testnet) Blend V2 pool that accepts mintable USDC. */
export const EXEC_POOL_ID = "CBI7WAUQ4NPQFZW4C3MDSVFAZJWV3RCLZSTTMA5OZ6BTPEQMOZZNSZ3Z";
/** Exec (testnet) USDC SAC contract id. */
export const EXEC_USDC_CONTRACT_ID = "CD2R7WREEPGIAXZL4ASB76Y6PWTY6ZZXZ6C64AIKFDIG36YKQPNY6B2I";
/** OZ ed25519-verifier contract id (the External signer verifier). */
export const ED25519_VERIFIER_ID = "CBHJOANTAHF2ZKU5HZRZTWP4GX7YCSNR3V3AIMAH5P5R7S465SK24RSO";
/** Spending-limit policy contract id (caps the agent's USDC rule). */
export const SPENDING_POLICY_ID = "CBLNG63CIFKLFY6ZTL32NWMGPN7NBDSXZUSCQNTLMYRTLIZYA7MG3KAP";
/** Vigil RiskGate policy contract id (contracts/vigil-guard, testnet). */
export const VIGIL_GUARD_ID = "CD6BDS7R5K3IUCQSJUZUWAGLTR47EZOYEVCO5MPT7YGNBNQRHSNY5VMS";
/** Exec network passphrase (testnet). */
export const EXEC_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

/** Rolling spending window length in ledgers (~1 day on testnet). */
export const PERIOD_LEDGERS = 17280;
/** Default USDC spending cap (stroops) for the agent's capped USDC rule = 5000 USDC. */
export const DEFAULT_CAP_STROOPS = 5000_0000000n;
/** stroops per 1 USDC (7 decimals). */
export const STROOPS_PER_USDC = 10_000_000n;

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derive the 32-byte raw ed25519 public key (hex) from a Stellar `G…` address.
 * This is exactly the bytes the OZ External signer / constructor expects (and
 * matches `Keypair.rawPublicKey()`), so it is what we hand to
 * {@link deploySmartWalletOp} as `ownerPublicKeyHex`.
 *
 * Throws on a malformed / non-`G` address so callers fail loudly rather than
 * deploying a wallet with a garbage owner key.
 */
export function gAddressToRawHex(gAddress: string): string {
  const trimmed = gAddress.trim();
  if (!StrKey.isValidEd25519PublicKey(trimmed)) {
    throw new Error(`not a valid Stellar G-address: ${gAddress}`);
  }
  return Buffer.from(StrKey.decodeEd25519PublicKey(trimmed)).toString("hex");
}

/** Convert a whole/decimal USDC amount to i128 stroops (7 decimals). */
export function usdcToStroops(amountUsdc: number): bigint {
  if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) {
    throw new Error(`invalid USDC amount: ${amountUsdc}`);
  }
  return BigInt(Math.round(amountUsdc * Number(STROOPS_PER_USDC)));
}

/** Pretty-print stroops as a USDC string with up to 7 decimals, trimmed. */
export function stroopsToUsdcStr(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_USDC;
  const frac = stroops % STROOPS_PER_USDC;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(7, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step builders (return base64 op XDR the route/client wraps into a tx).
// All are PURE — no network, no signing.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * STEP 1 — the `createCustomContract` op + deterministic contract id for a new
 * per-user smart wallet. `deployer` is the user's `G…` (signs the envelope via
 * Freighter + pays the fee). The Default-rule owner is `Delegated(ownerAddress)`
 * (defaults to the deployer), or — legacy only — an External ed25519 key given
 * as `ownerPublicKeyHex`.
 *
 * Returns base64 op XDR so it can cross the API/client boundary as a string.
 */
export function buildDeployOp(opts: {
  deployer: string;
  ownerAddress?: string;
  ownerPublicKeyHex?: string;
  saltHex?: string;
}): { opXdr: string; contractId: string; saltHex: string } {
  const owner = opts.ownerPublicKeyHex
    ? { verifier: ED25519_VERIFIER_ID, ownerPublicKeyHex: opts.ownerPublicKeyHex }
    : { ownerAddress: opts.ownerAddress ?? opts.deployer };
  const { op, contractId, saltHex } = deploySmartWalletOp({
    deployer: opts.deployer,
    networkPassphrase: EXEC_NETWORK_PASSPHRASE,
    ...owner,
    saltHex: opts.saltHex,
  });
  return { opXdr: op.toXDR("base64"), contractId, saltHex };
}

/**
 * STEP 2 — the two `add_context_rule` ops (pool rule + capped USDC rule) that
 * authorize the agent on `smartWallet`. Returned as base64 op XDR strings;
 * `/api/onboard/prepare` wraps each into an owner-authorized tx the user signs.
 */
export function buildAgentRuleOpsXdr(opts: {
  smartWallet: string;
  agentPublicKeyHex: string;
  capStroops?: bigint;
}): { poolRuleOpXdr: string; usdcRuleOpXdr: string } {
  const { poolRuleOp, usdcRuleOp } = addAgentRuleOps({
    smartWallet: opts.smartWallet,
    poolId: EXEC_POOL_ID,
    usdcSac: EXEC_USDC_CONTRACT_ID,
    verifier: ED25519_VERIFIER_ID,
    agentPublicKeyHex: opts.agentPublicKeyHex,
    spendingPolicy: SPENDING_POLICY_ID,
    capStroops: opts.capStroops ?? DEFAULT_CAP_STROOPS,
    periodLedgers: PERIOD_LEDGERS,
    guard: { id: VIGIL_GUARD_ID, minScore: 0, maxAgeSecs: 0n },
  });
  return {
    poolRuleOpXdr: poolRuleOp.toXDR("base64"),
    usdcRuleOpXdr: usdcRuleOp.toXDR("base64"),
  };
}

/**
 * STEP 3 — the USDC SAC `transfer(from, to, amount)` op that funds the smart
 * wallet from the user's `G…` account. A plain Soroban invocation whose
 * `require_auth` is the user's classic account, so the user signs the whole tx
 * envelope via Freighter `signTransaction` (no smart-account auth needed).
 *
 * Returns base64 op XDR.
 */
export function buildFundUsdcOp(opts: {
  from: string;
  smartWallet: string;
  amountStroops: bigint;
}): string {
  const op = new Contract(EXEC_USDC_CONTRACT_ID).call(
    "transfer",
    nativeToScVal(Address.fromString(opts.from), { type: "address" }),
    nativeToScVal(Address.fromString(opts.smartWallet), { type: "address" }),
    nativeToScVal(opts.amountStroops, { type: "i128" }),
  );
  return op.toXDR("base64");
}

/**
 * Decode a base64 op XDR string back into an `xdr.Operation` (used by the
 * authorize route to re-hydrate the ops it owner-signs).
 */
export function opFromXdr(opXdrBase64: string): xdr.Operation {
  return xdr.Operation.fromXDR(opXdrBase64, "base64");
}
