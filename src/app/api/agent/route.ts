import { NextResponse } from "next/server";
import { getAgentKeypair } from "../../../lib/agentKeys";

export const dynamic = "force-dynamic";

/**
 * GET /api/agent — the backend agent's public key, so the UI installs the
 * correct External agent signer when authorizing the agent rules.
 *
 * Response:
 *   {
 *     agentPublicKey:     "G…",                 // the agent's classic address
 *     agentPublicKeyHex:  "<32-byte raw hex>",  // External signer key bytes
 *     // New wallets are owned by the user's own G-account
 *     // (`Signer::Delegated(G)`); the owner signs rule changes in Freighter.
 *     freighterCanSignOwnerAuth: true,
 *     ownerMode: "user-delegated"
 *   }
 *
 * Never returns any secret — only public G…/hex values derived from
 * AGENT_SIGNER_SECRET.
 */
export async function GET() {
  try {
    const agent = getAgentKeypair();
    return NextResponse.json({
      agentPublicKey: agent.publicKey(),
      agentPublicKeyHex: agent.rawPublicKey().toString("hex"),
      freighterCanSignOwnerAuth: true,
      ownerMode: "user-delegated",
    });
  } catch (e) {
    return NextResponse.json(
      { error: `agent key unavailable: ${(e as Error).message}` },
      { status: 500 },
    );
  }
}
