/**
 * Vigil risk engine — live mainnet run (READ-ONLY: simulations + public APIs, no signing).
 *
 *   npx tsx scripts/vigil-ratings.ts                 # table on stderr, ratings JSON on stdout
 *   npx tsx scripts/vigil-ratings.ts ratings.json    # table on stdout, JSON written to the path
 *   VIGIL_DEPTH_HISTORY=depth.json npx tsx scripts/vigil-ratings.ts …
 *       keep the SDEX books between runs in that file, so manipulation is rated
 *       on the thinnest book of the last 24 h (as the server does) instead of one read
 *
 * Reads SCAN_* settings from .env (never prints secrets).
 */
import { config as loadEnv } from "dotenv";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { toRatingsJson, type DefindexStrategyRef } from "../src/lib/vigil/engine";
import { runLiveVigil } from "../src/lib/vigil/service";
import type { PoolRating } from "../src/lib/vigil/types";

loadEnv({ quiet: true } as never);

const outPath = process.argv[2];
const print = outPath ? (s: string) => console.log(s) : (s: string) => console.error(s);

const rpcUrl = process.env.SCAN_RPC_URL ?? "https://mainnet.sorobanrpc.com";
const passphrase = process.env.SCAN_NETWORK_PASSPHRASE ?? "Public Global Stellar Network ; September 2015";
const deployments = [
  {
    name: "v2",
    factoryId: process.env.SCAN_POOL_FACTORY_ID ?? "CDSYOAVXFY7SM5S64IZPPPYB4GVGGLMQVFREPSQQEZVIWXX5R23G4QSU",
    backstopId: process.env.SCAN_BACKSTOP_ID ?? "CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7",
  },
  {
    name: "v2.1",
    factoryId: process.env.SCAN_POOL_FACTORY_V2_1_ID ?? "CACUXRNBUFV7BFPKUDLVJFQI6H7EHHNSJPOFJSCWJCYUUYMORM6C63AL",
    backstopId: process.env.SCAN_BACKSTOP_V2_1_ID ?? "CCS4AZ5ORM6VLLPJTJUFRNXWBMHOO3L5WHHRPL2ZMILE35ZDMQFHOQMJ",
  },
];
const curated = (process.env.SCAN_BLEND_POOL_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
let strategies: DefindexStrategyRef[] = [];
try {
  strategies = (JSON.parse(process.env.SCAN_DEFINDEX_STRATEGIES ?? "[]") as Record<string, string>[]).map((s) => ({
    strategyId: s.strategyId,
    name: s.name,
    asset: s.asset,
    assetContractId: s.assetContractId ?? process.env.SCAN_USDC_CONTRACT_ID ?? "",
    blendPoolId: s.blendPoolId,
  }));
} catch {
  print("warning: SCAN_DEFINDEX_STRATEGIES is not valid JSON — skipping DeFindex");
}

const historyPath = process.env.VIGIL_DEPTH_HISTORY;
const started = Date.now();
const result = await runLiveVigil({
  rpcUrl,
  passphrase,
  deployments,
  curatedPoolIds: curated,
  defindexStrategies: strategies,
  ...(historyPath
    ? {
        depthHistory: {
          load: async () => (existsSync(historyPath) ? JSON.parse(readFileSync(historyPath, "utf8")) : {}),
          save: async (h) => writeFileSync(historyPath, JSON.stringify(h)),
        },
      }
    : {}),
  log: (m) => console.error(`[vigil] ${m}`),
});

const json = toRatingsJson(result);
const fmt = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`);
const row = (r: PoolRating) => {
  const worst = [...r.factors].sort((a, b) => a.value - b.value)[0];
  return [
    r.protocol.padEnd(8),
    r.name.slice(0, 22).padEnd(22),
    `${r.poolId.slice(0, 6)}…`,
    `${r.status} ${r.statusLabel}`.padEnd(14),
    (r.deployment ?? "").padEnd(4),
    String(r.score ?? "NR").padStart(3),
    String(r.uncappedScore ?? "-").padStart(3),
    r.grade.padEnd(2),
    (r.eligibleForDeposit ? "yes" : "no").padEnd(3),
    fmt(r.tvlUsd).padStart(9),
    `${worst.key}=${worst.value}`,
  ].join(" | ");
};

print(`\nVigil ${result.engineVersion} — Stellar mainnet — computedAt ${new Date(result.computedAt * 1000).toISOString()} (${((Date.now() - started) / 1000).toFixed(0)}s)`);
print(`coverage: ${json.coverage.poolsFound} pools found [${json.coverage.sources.map((s) => `${s.name}=${s.count}${s.error ? ` ERR(${s.error.slice(0, 40)})` : ""}`).join(", ")}], ` +
  `rated ${json.coverage.rated}, failed ${json.coverage.failed.length}, unverified ${json.coverage.unverified.length}, rejected ${json.coverage.rejected.length}`);
print("protocol | name                   | id      | status         | dep  | scr | unc | G  | elg |       TVL | weakest factor");
print("-".repeat(112));
for (const r of [...result.pools].sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.tvlUsd - a.tvlUsd)) print(row(r));
for (const r of result.defindex) print(row(r));
for (const f of result.failures) print(`FAILED ${f.id}: ${f.error}`);
print("\nhard rules / top reasons:");
for (const r of [...result.pools, ...result.defindex]) print(`  ${r.name} (${r.poolId.slice(0, 6)}…): ${r.reasons.slice(0, 3).join(" || ")}`);

const text = JSON.stringify(json, null, 2);
if (outPath) {
  writeFileSync(outPath, text);
  print(`\nwrote ${outPath}`);
} else {
  process.stdout.write(text + "\n");
}
