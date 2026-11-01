/**
 * End-to-end probe of the serverless scan path: exactly what `/api/scan` runs
 * lazily on first load — ensurePoolIds (mainnet discovery) → scan (Blend +
 * DeFindex) → score → cache to Mongo → decide → cache. NO fund movement.
 * Then reads the cached snapshot back the way the route handler does. Run:
 *   npx tsx scripts/probe-scan-refresh.ts
 */
import "dotenv/config";
import { runScanRefresh, getLastScan, getDecision } from "../src/lib/runtime";

async function main() {
  const t0 = Date.now();
  await runScanRefresh();
  const scan = await getLastScan();
  const decision = await getDecision();
  console.log(`OK scan refresh in ${Date.now() - t0}ms`);
  console.log(`  pools cached: ${scan.pools.length} (updatedAt=${scan.updatedAt})`);
  console.log(`  eligible: ${scan.pools.filter((p) => p.eligible).length}`);
  console.log(`  decision: ${decision.action} chosen=${decision.chosenPoolId ?? "—"}`);
  console.log(`  rationale: ${decision.rationale.slice(0, 120)}…`);
  process.exit(0);
}

main().catch((e) => {
  console.error("SCAN REFRESH PROBE FAILED:", e?.message ?? e);
  process.exit(1);
});
