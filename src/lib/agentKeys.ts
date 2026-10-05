/**
 * SERVER-ONLY agent + demo-owner key derivation.
 *
 * Reads `AGENT_SIGNER_SECRET` from the environment at call time (never at module
 * import — keeps `next build` / route static analysis from crashing when env is
 * absent). Used by `/api/agent` and `/api/authorize`.
 *
 *   - AGENT keypair: the backend's restricted External ed25519 policy signer.
 *     Its raw public key is the External signer the UI installs as the agent
 *     rule, and the same key the agent loop signs supplies with.
 *
 *   - DEMO OWNER keypair: a deterministic key derived from the agent secret
 *     (`ed25519Seed = sha256("yieldseeker-demo-owner:v1|" + AGENT_SIGNER_SECRET)`).
 *     It is the Default-rule OWNER of every demo-onboarded smart account, so the
 *     backend can produce the OZ SmartAccount AuthPayload owner signature for
 *     `add_context_rule` (step 2) that Freighter cannot. This is NEVER a real
 *     user secret — it is a deterministic, server-side demo signer.
 */
import { Keypair, hash } from "@stellar/stellar-sdk";

function requireAgentSecret(): string {
  const s = process.env.AGENT_SIGNER_SECRET;
  if (!s) throw new Error("AGENT_SIGNER_SECRET is not set");
  return s;
}

/** The backend agent (restricted External policy signer) keypair. */
export function getAgentKeypair(): Keypair {
  return Keypair.fromSecret(requireAgentSecret());
}

/**
 * The deterministic demo-owner keypair. Derived from the agent secret so it is
 * stable across requests/restarts and reproducible by the backend, while being
 * unrelated to (and never exposing) any real user's key.
 */
export function getDemoOwnerKeypair(): Keypair {
  // The "yieldseeker" tag is frozen (pre-rename): it fixes the demo-owner key that
  // every deployed smart account already trusts. Changing it orphans them.
  const seed = hash(Buffer.from(`yieldseeker-demo-owner:v1|${requireAgentSecret()}`));
  return Keypair.fromRawEd25519Seed(seed);
}
