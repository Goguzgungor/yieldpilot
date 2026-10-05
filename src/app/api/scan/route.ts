import { NextResponse } from "next/server";
import { getLastScan, ensureScanPopulated } from "../../../lib/runtime";

export const dynamic = "force-dynamic";
// First-ever load runs one lazy scan (mainnet reads) — allow headroom.
export const maxDuration = 60;

// { pools: SerializedScoredPool[], updatedAt: number | null }
// `pools` contains BigInts rendered as strings; `updatedAt` is epoch-ms.
// On a cold cache (never scanned) this lazily runs ONE side-effect-free scan to
// populate it ("run on app start"); thereafter it returns the cached snapshot
// and the daily Cron keeps it fresh.
export async function GET() {
  await ensureScanPopulated();
  return NextResponse.json(await getLastScan());
}
