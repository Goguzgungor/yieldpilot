import { NextResponse } from "next/server";
import { getArchivedRun, getLastPublish, listArchivedRuns } from "../../../../lib/runtime";

export const dynamic = "force-dynamic";

/**
 * GET /api/ratings/runs — the input of every published Vigil run for the last
 * 90 days, so anyone can re-hash a published rating.
 *
 *   (no params)      { runs: computedAt[], lastPublish }  — ascending
 *   ?at=<computedAt> that run's ratings JSON with everything it was computed
 *                    from (inputs, strategies, books), so each reasonsHash can be
 *                    recomputed and each pool re-rated: scripts/vigil-verify.ts.
 *                    computedAt is the timestamp the registry returns for the
 *                    rating. A run archived before the books were kept comes back without them.
 *
 * Open to browsers on any origin (CORS), like /api/ratings.
 */
const CORS = { "access-control-allow-origin": "*" };
export async function GET(req: Request) {
  const at = new URL(req.url).searchParams.get("at");
  if (at === null) return NextResponse.json({ runs: await listArchivedRuns(), lastPublish: await getLastPublish() }, { headers: CORS });
  const run = /^\d+$/.test(at) ? await getArchivedRun(Number(at)) : null;
  if (!run) return NextResponse.json({ error: `no archived run at ${at}` }, { status: 404, headers: CORS });
  return new NextResponse(run, { headers: { "content-type": "application/json", ...CORS } });
}
