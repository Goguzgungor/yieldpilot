import { NextResponse } from "next/server";
import { getRatings } from "../../../lib/runtime";

export const dynamic = "force-dynamic";
// A cache miss runs the full mainnet read (~90 s).
export const maxDuration = 300;

/**
 * GET /api/ratings — Vigil risk ratings for every Blend pool (V2 and v2.1) and configured
 * DeFindex strategy (mainnet, read-only), cached for an hour.
 *
 *   ?refresh=1  recompute now (only if the cache is older than 5 minutes)
 *   ?inputs=1   include the per-pool inputs behind each rating (for audit /
 *               re-hashing); omitted by default to keep the payload small
 *
 * Response: { engineVersion, computedAt, cachedAt, stale, network, coverage,
 *             ratings: PoolRating[], methodology, inputs? }
 * Scores are 0..100, higher = safer; `reasonsHash` is what publishers sign
 * into the RiskRegistry.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  try {
    let result = await getRatings();
    if (url.searchParams.get("refresh") === "1" && Date.now() - result.cachedAt > 5 * 60 * 1000) {
      result = await getRatings({ refresh: true });
    }
    const { inputs, ...rest } = result.data;
    return NextResponse.json({
      ...rest,
      cachedAt: result.cachedAt,
      stale: result.stale,
      methodology: "https://github.com/Goguzgungor/yieldpilot/blob/feat/yieldseeker-mvp/docs/vigil/methodology.md",
      ...(url.searchParams.get("inputs") === "1" ? { inputs } : {}),
    });
  } catch (e) {
    return NextResponse.json({ error: `ratings unavailable: ${(e as Error).message}` }, { status: 502 });
  }
}
