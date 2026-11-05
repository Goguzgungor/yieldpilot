import { after, NextResponse } from "next/server";
import { requestHasKey } from "../../../../lib/routeKey";
import { getLastPublish, publishVigilRatings, runQuietScanRefresh } from "../../../../lib/runtime";

export const dynamic = "force-dynamic";
// The run after the response: a fresh mainnet read (~90 s), publish_batch, then the pool scan.
export const maxDuration = 300;

/**
 * GET /api/cron/publish — the Vigil publisher: sign the live ratings into the
 * testnet RiskRegistry, so get_rating and the RiskGate stay fresh (the registry
 * keeps a rating 2 h). Called every 30 minutes by an external scheduler, since
 * Vercel Hobby crons run at most daily.
 *
 * Then it refreshes the homepage's scan snapshot against the new ratings,
 * silently (runQuietScanRefresh: no funds move, no log line), so which pools
 * are open follows the ratings instead of waiting for the daily agent tick.
 *
 * Answers 202 at once and runs after the response, so a caller with a short
 * timeout still starts a full run; a run started in the last 4 minutes is not
 * repeated. The response carries the previous run's outcome.
 *
 * Auth: `Authorization: Bearer <VIGIL_PUBLISH_KEY>` or `?key=`. Needs
 * VIGIL_PUBLISHER_SECRET, the publisher's testnet key (it can only publish
 * ratings, not move funds).
 */
export async function GET(req: Request) {
  const key = process.env.VIGIL_PUBLISH_KEY?.trim();
  const secret = process.env.VIGIL_PUBLISHER_SECRET?.trim();
  if (!key || !secret) return NextResponse.json({ error: "publisher not configured" }, { status: 503 });
  if (!requestHasKey(req, key)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  after(async () => {
    try {
      await publishVigilRatings(secret);
    } catch (e) {
      console.error(`vigil publish failed: ${(e as Error).message}`);
    }
    try {
      await runQuietScanRefresh();
    } catch (e) {
      console.error(`scan refresh failed: ${(e as Error).message}`);
    }
  });
  return NextResponse.json({ accepted: true, previous: await getLastPublish() }, { status: 202 });
}
