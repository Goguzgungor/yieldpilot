import { NextResponse } from "next/server";
import { getRuntime } from "../../../../lib/runtime";
import { getDemoOwnerKeypair } from "../../../../lib/agentKeys";
import { readOwnershipMode } from "../../../../lib/ownership";

export const dynamic = "force-dynamic";

/**
 * GET /api/onboard/ownership?smartWallet=C…&owner=G… → `{ mode }`, one of
 * "user" | "co-owned" | "backend" | "unknown" (see lib/ownership.ts). The UI
 * offers "finalize ownership" when the mode is "co-owned".
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const smartWallet = url.searchParams.get("smartWallet");
  const owner = url.searchParams.get("owner");
  if (!smartWallet || !owner) {
    return NextResponse.json({ error: "smartWallet and owner query params required" }, { status: 400 });
  }
  try {
    const rt = getRuntime();
    const mode = await readOwnershipMode({
      server: rt.execServer,
      networkPassphrase: rt.cfg.execNetworkPassphrase,
      readerSource: rt.agentKeypair.publicKey(),
      smartWallet,
      owner,
      demoOwner: { verifier: rt.cfg.ed25519VerifierId, publicKeyHex: getDemoOwnerKeypair().rawPublicKey().toString("hex") },
    });
    return NextResponse.json({ mode });
  } catch (e) {
    return NextResponse.json({ mode: "unknown", error: (e as Error).message }, { status: 502 });
  }
}
