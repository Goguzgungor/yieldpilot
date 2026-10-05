import { NextResponse } from "next/server";
import { runAgentTick } from "../../../lib/runtime";

export const dynamic = "force-dynamic";
// The autonomous tick scans mainnet, picks the best eligible pool, and supplies each user's idle
// USDC on testnet — give it room beyond the 10s default.
export const maxDuration = 60;

/**
 * GET /api/tick — the autonomous agent tick, invoked DAILY by Vercel Cron (see
 * vercel.json). Replaces the old in-process 30s `setInterval` loop, which cannot
 * run on serverless. Runs scan → score → decide → per-user supply.
 *
 * Auth: when CRON_SECRET is set, Vercel Cron sends `Authorization: Bearer
 * <CRON_SECRET>` automatically; we also accept `?key=<CRON_SECRET>` for a manual
 * trigger (handy during a live demo). When CRON_SECRET is unset, the endpoint is
 * open — fine for the testnet demo (all spending is on-chain capped), but set
 * CRON_SECRET in production to lock it down.
 */
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  if (req.headers.get("authorization") === `Bearer ${secret}`) return true;
  return new URL(req.url).searchParams.get("key") === secret;
}

async function handle(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    await runAgentTick();
    return NextResponse.json({ ok: true, ranAt: new Date().toISOString() });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export const GET = handle; // Vercel Cron invokes via GET
export const POST = handle; // manual trigger
