/**
 * SERVER-ONLY. Checks that a registration change was signed by the wallet that
 * owns it: an ed25519 signature by `owner` over the SEP-53 digest of
 * {@link ownerMessage}, made within {@link OWNER_SIGNATURE_WINDOW_MS}.
 *
 * SEP-53 (what Freighter's `signMessage` signs):
 *   sha256("Stellar Signed Message:\n" || utf8(message))
 */
import { createHash } from "node:crypto";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { OWNER_SIGNATURE_WINDOW_MS, ownerMessage, type OwnerRequest } from "./ownerMessage";

const SEP53_PREFIX = "Stellar Signed Message:\n";
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function sep53Digest(message: string): Buffer {
  return createHash("sha256").update(Buffer.concat([Buffer.from(SEP53_PREFIX, "utf8"), Buffer.from(message, "utf8")])).digest();
}

/** Sign `message` as a SEP-53 wallet would; base64. For scripts and tests. */
export function signOwnerMessage(kp: Keypair, message: string): string {
  return kp.sign(sep53Digest(message)).toString("base64");
}

/** null when `signature` is the owner's signature of `req` at `signedAt`, else why not. */
export function checkOwnerSignature(req: OwnerRequest, signedAt: unknown, signature: unknown, nowMs = Date.now()): string | null {
  if (typeof signedAt !== "string" || typeof signature !== "string") return "signedAt and signature are required";
  if (!StrKey.isValidEd25519PublicKey(req.owner)) return "owner is not a G-address";
  if (!ISO_UTC.test(signedAt)) return "signedAt must be an ISO-8601 UTC timestamp";
  if (Math.abs(nowMs - Date.parse(signedAt)) > OWNER_SIGNATURE_WINDOW_MS) return "signature expired: sign again";
  const sig = Buffer.from(signature, "base64");
  if (sig.length !== 64) return "signature is not a base64 ed25519 signature";
  const ok = Keypair.fromPublicKey(req.owner).verify(sep53Digest(ownerMessage(req, signedAt)), sig);
  return ok ? null : "signature does not match the owner";
}
