/**
 * Deterministic load-test wallets. Mirrors src/lib/agentKeys.ts
 * getDemoOwnerKeypair: only LOADTEST_SEED is stored (in .env.loadtest), never
 * 97 secrets, and the same seed always yields the same 97 G-addresses.
 */
import { Keypair, hash } from "@stellar/stellar-sdk";

export function deriveWallet(seedHex: string, index: number): Keypair {
  if (!/^[0-9a-f]{64}$/i.test(seedHex)) throw new Error("LOADTEST_SEED must be 32 bytes of hex");
  if (!Number.isInteger(index) || index < 0) throw new Error(`bad wallet index ${index}`);
  return Keypair.fromRawEd25519Seed(hash(Buffer.from(`ys-loadtest:v1|${seedHex.toLowerCase()}|${index}`)));
}

/** A resumed run must drive the same wallets it was initialised with. */
export function assertSameWallets(
  stored: Array<{ index: number; owner: string }>,
  derive: (i: number) => string,
): void {
  for (const w of stored) {
    const now = derive(w.index);
    if (now !== w.owner) {
      throw new Error(`wallet ${w.index}: LOADTEST_SEED changed since init (${w.owner} ≠ ${now}) — refusing to resume`);
    }
  }
}
