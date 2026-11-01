/**
 * Vigil backtest — YieldBlox pool just before the 22 Feb 2026 exploit.
 * OFFLINE: runs the engine on the documented RECONSTRUCTION in src/lib/vigil/backtest.ts.
 *
 *   npx tsx scripts/vigil-backtest.ts
 */
import { runYieldBloxBacktest } from "../src/lib/vigil/backtest";

const bt = runYieldBloxBacktest();
const r = bt.rating;
const usd = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(2)}`);

console.log("YieldBlox CCCCIQ… — RECONSTRUCTION as of 2026-02-22T00:00Z (exploit ≈00:24Z)");
console.log(`score ${r.score} (uncapped ${r.uncappedScore}) grade ${r.grade} eligible=${r.eligibleForDeposit} status=${r.status} ${r.statusLabel} TVL ${usd(r.tvlUsd)}`);
console.log(`reasonsHash ${r.reasonsHash}`);
console.log("\nfactor                    value  weight  contrib  note");
for (const f of r.factors) console.log(`${f.key.padEnd(25)} ${String(f.value).padStart(5)}  ${f.weight.toFixed(2).padStart(6)}  ${f.contribution.toFixed(2).padStart(7)}  ${f.note}`);
console.log("\nhard rules:", r.hardRules.join(" | ") || "none");
console.log(
  `\nUSTRY attack model: pump ×${bt.ustry.multiplier}, SDEX cost ${usd(bt.ustry.manipulationCostUsd)}, collateral ${usd(bt.ustry.collateralCostUsd)}, ` +
    `extractable ${usd(bt.ustry.extractableUsd)}, rho ${bt.ustry.rho?.toPrecision(3)}, hold ${bt.ustry.roundsToHold} rounds (${bt.ustry.minHoldSeconds}s)`,
);
console.log(`actually extracted (BlockSec/rekt: 1,000,196 USDC + 61,249,278 XLM @ $0.16115): ${usd(bt.actualExtractedUsd)}`);
console.log("\nsensitivity — USTRY ask depth below the attack price vs outcome:");
for (const s of bt.sensitivity) console.log(`  asks ${usd(s.askDepthUsd).padStart(9)}  rho ${s.rho?.toPrecision(3).padStart(7)}  profitable=${s.profitable}  grade ${s.grade}  eligible=${s.eligible}`);
