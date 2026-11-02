import { NextResponse } from "next/server";
import { requestHasKey } from "../../../lib/routeKey";
import { resetRegistry, listUsers, registryStoreId } from "../../../lib/runtime";

export const dynamic = "force-dynamic";

/**
 * Operator-only. Both methods need `RESET_KEY` (`Authorization: Bearer <key>`
 * or `?key=`); without it set, the route answers 404, so a deployment that does
 * not define it (production) has no reset at all. A user forgets their own
 * registration with a signed `DELETE /api/register`.
 */
function gate(req: Request): NextResponse | null {
  const key = process.env.RESET_KEY?.trim();
  if (!key) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!requestHasKey(req, key)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return null;
}

/**
 * POST /api/reset — clear the ENTIRE per-user registry (all users + positions)
 * so the whole demo can be re-run. Returns `{ ok, removed }` (count of users
 * that were registered).
 */
export async function POST(req: Request) {
  const denied = gate(req);
  if (denied) return denied;
  const removed = await resetRegistry();
  return NextResponse.json({ ok: true, removed });
}

/**
 * GET /api/reset — diagnostic snapshot of the registry as seen by a route
 * handler instance: the store id + the registered owners. Never mutates.
 */
export async function GET(req: Request) {
  const denied = gate(req);
  if (denied) return denied;
  const users = await listUsers();
  return NextResponse.json({
    storeId: registryStoreId(),
    pid: process.pid,
    users: users.map((u) => ({ owner: u.owner, smartWallet: u.smartWallet })),
    count: users.length,
  });
}
