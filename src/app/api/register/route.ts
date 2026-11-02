import { NextResponse } from "next/server";
import { checkOwnerSignature } from "../../../lib/ownerAuth";
import { registerUser, unregisterUser, RegisterInput } from "../../../lib/runtime";

export const dynamic = "force-dynamic";

/**
 * POST /api/register — onboard a per-user smart account (ARMA model).
 *
 * Body: { owner, smartWallet, poolRuleId, usdcRuleId, signedAt, signature }
 *   - owner:       the user's classic G-address (Default-rule owner signer)
 *   - smartWallet: the user's deployed OZ SmartAccount C-address
 *   - poolRuleId:  context-rule id authorizing the agent for CallContract(POOL)
 *   - usdcRuleId:  context-rule id authorizing the agent for CallContract(USDC) (capped)
 *   - signedAt, signature: the owner's SEP-53 signature (Freighter signMessage)
 *     of `ownerMessage({ action: "register", … }, signedAt)`; see ownerAuth.ts
 *
 * The OWNER must have already deployed their smart account + added the two
 * agent context rules client-side (Freighter). This endpoint just records the
 * mapping so the agent loop can supply that user's idle USDC. Registering
 * replaces an existing row, so only the owner may do it: 401 otherwise.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = RegisterInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { signedAt, signature } = body as { signedAt?: unknown; signature?: unknown };
  const denied = checkOwnerSignature({ action: "register", ...parsed.data }, signedAt, signature);
  if (denied) return NextResponse.json({ error: denied }, { status: 401 });
  const reg = await registerUser(parsed.data);
  return NextResponse.json({ ok: true, user: reg }, { status: 201 });
}

/**
 * DELETE /api/register — un-register a SINGLE user so the onboarding re-appears
 * for that owner (the UI "Reset demo" affordance calls this).
 *
 * Body: { owner, signedAt, signature }, the owner's SEP-53 signature of
 * `ownerMessage({ action: "unregister", owner }, signedAt)`: 401 otherwise.
 * Idempotent: returns `{ ok, removed }` where `removed` is false if the owner
 * wasn't registered. The on-chain smart account is left untouched; this only
 * forgets the mapping.
 */
export async function DELETE(req: Request) {
  let body: { owner?: unknown; signedAt?: unknown; signature?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const owner = body.owner;
  if (typeof owner !== "string" || !owner) {
    return NextResponse.json({ error: "owner required" }, { status: 400 });
  }
  const denied = checkOwnerSignature({ action: "unregister", owner }, body.signedAt, body.signature);
  if (denied) return NextResponse.json({ error: denied }, { status: 401 });
  const removed = await unregisterUser(owner);
  return NextResponse.json({ ok: true, removed });
}
