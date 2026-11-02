import { after, NextResponse } from "next/server";
import { getRatings, refreshExpiredRatings } from "../../../lib/runtime";

export const dynamic = "force-dynamic";
// An empty cache, a refresh or the background recompute runs the full mainnet read (~90 s).
export const maxDuration = 300;

/**
 * GET /api/ratings — Vigil risk ratings for every Blend pool (V2 and v2.1) and configured
 * DeFindex strategy (mainnet, read-only), served from the cache. A copy older than
 * an hour is still served at once and recomputed after the response.
 *
 *   ?refresh=1  recompute now (only if the cache is older than 5 minutes)
 *   ?inputs=1   include everything the ratings were computed from (each pool's
 *               snapshot, the DeFindex strategy inputs, the order books by
 *               hash; see lib/vigil/audit.ts); omitted by default to keep the
 *               payload small
 *
 * Response: { engineVersion, computedAt, cachedAt, stale, network, coverage,
 *             ratings: PoolRating[], methodology, inputs?, strategies?, books? }
 * Scores are 0..100, higher = safer; `reasonsHash` is what publishers sign
 * into the RiskRegistry.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  try {
    let result = await getRatings();
    if (url.searchParams.get("refresh") === "1" && Date.now() - result.cachedAt > 5 * 60 * 1000) {
      result = await getRatings({ refresh: true });
    } else if (result.expired) {
      after(refreshExpiredRatings);
    }
    const { inputs, strategies, books, ...rest } = result.data;
    return NextResponse.json({
      ...rest,
      cachedAt: result.cachedAt,
      stale: result.stale,
      methodology: "https://github.com/Goguzgungor/yieldpilot/blob/feat/yieldseeker-mvp/docs/vigil/methodology.md",
      ...(url.searchParams.get("inputs") === "1" ? { inputs, strategies, books } : {}),
    });
  } catch (e) {
    return NextResponse.json({ error: `ratings unavailable: ${(e as Error).message}` }, { status: 502 });
  }
}
