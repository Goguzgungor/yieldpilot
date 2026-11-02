/**
 * The messages a wallet owner signs to change their registration: `POST
 * /api/register` (register or replace the smart account the agent serves) and
 * `DELETE /api/register` (forget it). Freighter signs them with `signMessage`
 * (SEP-53); `ownerAuth.ts` checks them on the server.
 *
 * Client-safe: plain strings, no node deps. The server rebuilds the message
 * from the request fields, so what the wallet shows is exactly what is checked.
 */
export type OwnerRequest =
  | { action: "register"; owner: string; smartWallet: string; poolRuleId: number; usdcRuleId: number }
  | { action: "unregister"; owner: string };

/** How old, or how far ahead of the server clock, a signature may be. */
export const OWNER_SIGNATURE_WINDOW_MS = 5 * 60_000;

/** The text the owner signs; `signedAt` is an ISO-8601 UTC timestamp. */
export function ownerMessage(req: OwnerRequest, signedAt: string): string {
  if (req.action === "register") {
    return [
      "YieldPilot: register this smart account for the agent",
      `Owner: ${req.owner}`,
      `Smart account: ${req.smartWallet}`,
      `Agent rules: pool #${req.poolRuleId}, USDC #${req.usdcRuleId}`,
      `Signed at: ${signedAt}`,
    ].join("\n");
  }
  return ["YieldPilot: forget this wallet's registration", `Owner: ${req.owner}`, `Signed at: ${signedAt}`].join("\n");
}

/**
 * Freighter's `signMessage` answers with a base64 string (API v4) or, from
 * older extensions, a Buffer, which may arrive JSON-serialized. Returns the
 * base64 signature, or null.
 */
export function signatureToBase64(sig: unknown): string | null {
  if (typeof sig === "string") return sig || null;
  let bytes: Uint8Array | null = null;
  if (sig instanceof Uint8Array) bytes = sig;
  else if (sig && typeof sig === "object" && Array.isArray((sig as { data?: unknown }).data)) {
    bytes = Uint8Array.from((sig as { data: number[] }).data);
  }
  if (!bytes || bytes.length === 0) return null;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
