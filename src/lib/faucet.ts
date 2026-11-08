/**
 * SERVER-ONLY testnet USDC faucet.
 *
 * We control our own testnet USDC Stellar Asset Contract (SAC) — a wrapped
 * classic asset `USDC:OWNER` whose admin/issuer is the OWNER key derived (SEP-5)
 * from `STELLAR_WALLET_MNEMONIC` (public `GBXDHEVC…`). Only that admin can `mint`.
 * This module lets the backend mint test USDC on demand so a user can fund their
 * smart account during onboarding without sourcing USDC externally (the official
 * Blend-testnet USDC is unmintable; mainnet USDC nobody has → untestable).
 *
 * NEVER prints / returns the mnemonic or any secret — only public `G…/C…` ids
 * and tx hashes.
 *
 * The OWNER key derivation reuses the exact pure-crypto SEP-5 method proven in
 * `scripts/spike-derive-and-status.ts` (BIP39 → SLIP-0010 ed25519, path
 * m/44'/148'/<idx>'), using only Node's `node:crypto` + `@stellar/stellar-sdk`
 * (no extra dependency).
 */
import { createHmac, pbkdf2Sync } from "node:crypto";
import {
  Address,
  Contract,
  Keypair,
  nativeToScVal,
  rpc,
  StrKey,
  TransactionBuilder,
  type xdr,
} from "@stellar/stellar-sdk";
import { createRpcServer } from "./rpcServer";

// ── faucet request policy (pure — unit-testable, no network) ────────────────────

/** stroops per 1 USDC (7 decimals). */
export const STROOPS_PER_USDC = 10_000_000n;
/** Default mint amount (whole USDC) when the request omits `amount`. */
export const FAUCET_DEFAULT_USDC = 1000;
/** Maximum mint amount (whole USDC) the faucet will dispense in one request. */
export const FAUCET_MAX_USDC = 5000;

/**
 * Validate + normalize a faucet request into a recipient + stroops amount.
 *
 * - `to` must be a real Stellar address: a contract `C…` (smart account — the
 *   preferred onboarding target) or a classic `G…` account.
 * - `amount` (whole USDC) defaults to {@link FAUCET_DEFAULT_USDC}, must be a
 *   positive finite number, and is capped at {@link FAUCET_MAX_USDC}.
 * - The amount is converted to i128 stroops (7 decimals).
 *
 * Throws `Error` with a clear, secret-free message on any invalid input.
 */
export function parseFaucetRequest(input: { to: unknown; amount?: unknown }): {
  to: string;
  amountUsdc: number;
  amountStroops: bigint;
} {
  if (typeof input.to !== "string" || !input.to.trim()) {
    throw new Error("`to` is required (a smart account C… or classic G… address)");
  }
  const to = input.to.trim();
  if (!StrKey.isValidContract(to) && !StrKey.isValidEd25519PublicKey(to)) {
    throw new Error("`to` must be a valid Stellar address (contract C… or account G…)");
  }

  let amountUsdc = FAUCET_DEFAULT_USDC;
  if (input.amount !== undefined && input.amount !== null) {
    const n = typeof input.amount === "string" ? Number(input.amount) : input.amount;
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
      throw new Error("`amount` must be a positive number of USDC");
    }
    amountUsdc = n;
  }
  if (amountUsdc > FAUCET_MAX_USDC) {
    throw new Error(`\`amount\` exceeds the faucet cap of ${FAUCET_MAX_USDC} USDC`);
  }

  const amountStroops = BigInt(Math.round(amountUsdc * Number(STROOPS_PER_USDC)));
  if (amountStroops <= 0n) {
    throw new Error("`amount` rounds to zero stroops");
  }
  return { to, amountUsdc, amountStroops };
}

// ── SEP-5 derivation (BIP39 → SLIP-0010 ed25519), ported verbatim from the spike ──

/** BIP39 mnemonic → 64-byte seed (PBKDF2-HMAC-SHA512, 2048 iters). */
function mnemonicToSeed(mnemonic: string, passphrase = ""): Buffer {
  const norm = mnemonic.normalize("NFKD").trim().replace(/\s+/g, " ");
  const salt = ("mnemonic" + passphrase).normalize("NFKD");
  return pbkdf2Sync(norm, salt, 2048, 64, "sha512");
}

/** SLIP-0010 ed25519 master key. */
function slip10MasterKey(seed: Buffer): { key: Buffer; chainCode: Buffer } {
  const I = createHmac("sha512", Buffer.from("ed25519 seed")).update(seed).digest();
  return { key: I.subarray(0, 32), chainCode: I.subarray(32) };
}

/** SLIP-0010 ed25519 hardened child key derivation (only hardened is supported). */
function slip10CKDpriv(parent: { key: Buffer; chainCode: Buffer }, index: number) {
  const hardened = (index | 0x80000000) >>> 0;
  const data = Buffer.alloc(1 + 32 + 4);
  data[0] = 0x00;
  parent.key.copy(data, 1);
  data.writeUInt32BE(hardened, 33);
  const I = createHmac("sha512", parent.chainCode).update(data).digest();
  return { key: I.subarray(0, 32), chainCode: I.subarray(32) };
}

/** SEP-5 account seed for `m/44'/148'/<accountIndex>'`. */
function deriveSep5Seed(mnemonic: string, accountIndex: number): Buffer {
  const seed = mnemonicToSeed(mnemonic);
  let node = slip10MasterKey(seed);
  for (const idx of [44, 148, accountIndex]) node = slip10CKDpriv(node, idx);
  return node.key; // 32-byte ed25519 seed → Stellar Keypair
}

/**
 * Derive the OWNER (= USDC SAC admin/issuer) keypair from `STELLAR_WALLET_MNEMONIC`
 * via SEP-5 `m/44'/148'/0'`. Reads the mnemonic from the environment at call time
 * (never at import) so `next build` / route static-analysis never crashes when env
 * is absent. Throws a clear error if the mnemonic is missing.
 *
 * @param accountIndex SEP-5 account index (defaults to 0 — the OWNER).
 */
export function deriveOwnerKeypair(accountIndex = 0): Keypair {
  const mnemonic = process.env.STELLAR_WALLET_MNEMONIC;
  if (!mnemonic || !mnemonic.trim()) {
    throw new Error("STELLAR_WALLET_MNEMONIC is not set (required for the USDC faucet)");
  }
  const seed = deriveSep5Seed(mnemonic, accountIndex);
  return Keypair.fromRawEd25519Seed(seed);
}

// ── mint ──────────────────────────────────────────────────────────────────────

const FEE = (Number(100) * 10000).toString(); // 1_000_000 stroops (matches deploy-lib)

export interface MintUsdcOpts {
  /**
   * Recipient address. Preferred: a contract account (smart account `C…`) — no
   * classic trustline is needed. A `G…` account works too, but it must already
   * hold a USDC trustline (otherwise the SAC `mint` fails); for onboarding we
   * mint into the smart account `C…`.
   */
  to: string;
  /** Amount to mint, in stroops (i128; 7 decimals — 1 USDC = 10_000_000). */
  amountStroops: bigint;
  /** Soroban RPC url (exec/testnet). */
  rpcUrl: string;
  /** Network passphrase (exec/testnet). */
  networkPassphrase: string;
  /** The USDC SAC contract id whose admin is the owner key. */
  usdcSac: string;
  /**
   * Optional owner keypair override (the SAC admin). Defaults to
   * {@link deriveOwnerKeypair}() (SEP-5 m/44'/148'/0' of STELLAR_WALLET_MNEMONIC).
   */
  ownerKeypair?: Keypair;
  /** Optional pre-built rpc.Server (e.g. the runtime's execServer) to reuse. */
  server?: rpc.Server;
}

export interface MintUsdcResult {
  /** On-chain tx hash of the successful mint. */
  txHash: string;
  /** The amount minted, in stroops. */
  amountStroops: bigint;
  /** The recipient address. */
  to: string;
}

/**
 * Build the SAC `mint(to: Address, amount: i128)` host-function operation (pure —
 * no network, no signing). `to` may be a contract id (`C…`, a smart account — the
 * preferred onboarding target, no classic trustline required) or a classic `G…`
 * account; {@link Address.fromString} accepts either and `nativeToScVal(addr,
 * {type:"address"})` encodes the correct ScAddress variant. Throws on a malformed
 * recipient address.
 */
export function buildMintOp(usdcSac: string, to: string, amountStroops: bigint): xdr.Operation {
  const toAddress = Address.fromString(to);
  return new Contract(usdcSac).call(
    "mint",
    nativeToScVal(toAddress, { type: "address" }),
    nativeToScVal(amountStroops, { type: "i128" }),
  );
}

/**
 * Mint `amountStroops` of our USDC to `to`, signed by the SAC admin (owner).
 *
 * Invokes the SAC `mint(to: Address, amount: i128)` host function:
 *   build → simulate → assemble (merge footprint/resources) → sign(owner) →
 *   submit → poll to SUCCESS.
 *
 * `to` may be a contract id (`C…`, a smart account — the preferred onboarding
 * target, no classic trustline required) or a classic `G…` account. The
 * {@link Address} type handles both: `Address.fromString` accepts either, and
 * `nativeToScVal(addr, {type:"address"})` encodes the correct ScAddress variant.
 *
 * Returns the tx hash. Throws with a readable message on simulate/submit failure.
 */
export async function mintUsdc(opts: MintUsdcOpts): Promise<MintUsdcResult> {
  if (opts.amountStroops <= 0n) {
    throw new Error(`mintUsdc: amountStroops must be positive (got ${opts.amountStroops})`);
  }

  const owner = opts.ownerKeypair ?? deriveOwnerKeypair();
  const server =
    opts.server ?? createRpcServer(opts.rpcUrl, { allowHttp: opts.rpcUrl.startsWith("http://") });

  // SAC `mint(to: Address, amount: i128)` — validates the recipient address and
  // handles both C… (contract) and G… recipients via the Address ScVal encoding.
  const mintOp = buildMintOp(opts.usdcSac, opts.to, opts.amountStroops);

  const account = await server.getAccount(owner.publicKey());
  const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: opts.networkPassphrase })
    .addOperation(mintOp)
    .setTimeout(120)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`faucet mint simulate failed: ${sim.error}`);
  }
  const assembled = rpc.assembleTransaction(tx, sim).build();
  assembled.sign(owner);

  let sent = await server.sendTransaction(assembled);
  const start = Date.now();
  while (sent.status === "TRY_AGAIN_LATER" && Date.now() - start < 30000) {
    await new Promise((r) => setTimeout(r, 3000));
    sent = await server.sendTransaction(assembled);
  }
  if (sent.status === "ERROR") {
    const err = (sent as rpc.Api.SendTransactionResponse & {
      errorResult?: { toXDR?: (f: string) => string };
    }).errorResult;
    throw new Error(`faucet mint send ERROR: ${err?.toXDR?.("base64") ?? sent.status}`);
  }

  let g = await server.getTransaction(sent.hash);
  for (let i = 0; i < 30 && g.status === "NOT_FOUND"; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    g = await server.getTransaction(sent.hash);
  }
  if (g.status !== "SUCCESS") {
    let diag = "";
    if (g.status === "FAILED") {
      try {
        diag =
          (g as rpc.Api.GetFailedTransactionResponse & { resultXdr?: { toXDR?: (f: string) => string } })
            .resultXdr?.toXDR?.("base64") ?? "";
      } catch {
        /* ignore */
      }
    }
    throw new Error(`faucet mint tx ${sent.hash} status=${g.status}${diag ? ` ${diag}` : ""}`);
  }

  return { txHash: sent.hash, amountStroops: opts.amountStroops, to: opts.to };
}
