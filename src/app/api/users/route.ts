import { NextResponse } from "next/server";
import { listUsers, getUserWithPosition, getIdleUsdc } from "../../../lib/runtime";

export const dynamic = "force-dynamic";

/**
 * GET /api/users           → all registered users + each one's per-user position.
 * GET /api/users?owner=G... → that single user + position, or 404 if unknown.
 *
 * Each user row is { owner, smartWallet, poolRuleId, usdcRuleId, createdAt,
 * position: { poolId, amountUsdc } } with amountUsdc as a decimal stroop string.
 * The single-owner form also carries `idleUsdc`: the smart account's unsupplied
 * USDC (decimal stroops, or null if unreadable) — what the agent supplies next.
 */
export async function GET(req: Request) {
  const owner = new URL(req.url).searchParams.get("owner");
  if (owner) {
    const user = await getUserWithPosition(owner);
    if (!user) return NextResponse.json({ error: "not registered" }, { status: 404 });
    return NextResponse.json({ ...user, idleUsdc: await getIdleUsdc(user.smartWallet) });
  }
  return NextResponse.json({ users: await listUsers() });
}
