/**
 * Check a published Vigil run: recompute every reasonsHash from the archived
 * input, re-rate every pool with this checkout's engine, and compare with what
 * each publisher signed into the RiskRegistry. No keys needed.
 *
 *   npx tsx scripts/vigil-verify.ts                    # the latest archived run
 *   npx tsx scripts/vigil-verify.ts 1793626384         # the run with that computedAt
 *   npx tsx scripts/vigil-verify.ts run.json           # a run you saved (/api/ratings?inputs=1 or /api/ratings/runs?at=)
 *
 * Optional:
 *   VIGIL_ARCHIVE_URL=https://yieldpilot.org/api/ratings/runs
 *   VIGIL_REGISTRY_ID=C…   the registry to compare with (the testnet demo by default; "off" skips it)
 *   VIGIL_RPC_URL / VIGIL_NETWORK_PASSPHRASE / VIGIL_EXEC_POOL_ID
 *
 * The registry keeps each publisher's latest submission only, so the on-chain
 * check covers the run the registry holds now; older runs are on-chain in the
 * publish_batch transactions. Exit code 0 when everything checks out.
 */
import { readFileSync } from "node:fs";
import { rpc } from "@stellar/stellar-sdk";
import { RegistryClient } from "../packages/vigil-sdk/src";
import { verifyRun, type ArchivedRun } from "../src/lib/vigil/audit";

const ARCHIVE = process.env.VIGIL_ARCHIVE_URL ?? "https://yieldpilot.org/api/ratings/runs";
const REGISTRY = process.env.VIGIL_REGISTRY_ID ?? "CB4LXLCCD7YDND5FBVXPKPHUQMF7JFSDRVXHG7ZZTWWNPJ6WDCXDNDF6";
const RPC = process.env.VIGIL_RPC_URL ?? "https://soroban-testnet.stellar.org";
const PASS = process.env.VIGIL_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";
const EXEC_POOL = process.env.VIGIL_EXEC_POOL_ID ?? "CBI7WAUQ4NPQFZW4C3MDSVFAZJWV3RCLZSTTMA5OZ6BTPEQMOZZNSZ3Z";
/** Any funded testnet account; simulation needs a source. */
const READER = process.env.VIGIL_READER ?? "GAIY6WF2F24DCGDWGWOJCBQHDMMGU6JUKT7LIGYBZ4C5VFCKTFCLJJFD";

const getJson = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status} ${await res.text()}`);
  return res.json();
};

async function loadRun(arg: string | undefined): Promise<ArchivedRun> {
  if (arg && !/^\d+$/.test(arg)) return JSON.parse(readFileSync(arg, "utf8"));
  const at = arg ?? (await getJson(ARCHIVE)).runs.at(-1);
  if (at === undefined) throw new Error(`no archived runs at ${ARCHIVE}`);
  return getJson(`${ARCHIVE}?at=${at}`);
}

const mark = (x: boolean | null) => (x === null ? "–" : x ? "✓" : "✗");

async function main() {
  const run = await loadRun(process.argv[2]);
  console.log(`run ${run.computedAt} (${new Date(run.computedAt * 1000).toISOString()}), ${run.engineVersion}, ${run.ratings.length} ratings`);
  const check = verifyRun(run);
  if (check.error) {
    console.log(check.error);
    process.exit(1);
  }
  let ok = check.ok;

  // What each publisher signed for these pools, when the registry still holds this run.
  const onchain = new Map<string, string>();
  if (REGISTRY !== "off") {
    const client = new RegistryClient(REGISTRY, new rpc.Server(RPC), PASS, READER);
    const publishers = await client.publishers();
    for (const r of check.results) {
      const score = run.ratings.find((x) => x.poolId === r.poolId)?.score;
      if (score === null || score === undefined) {
        onchain.set(r.poolId, "not published (NR)");
        continue;
      }
      const seen: string[] = [];
      for (const p of publishers) {
        const sub = await client.getSubmission(r.poolId, p).catch(() => null);
        if (!sub) seen.push(`${p.slice(0, 6)}… none`);
        else if (sub.timestamp !== BigInt(run.computedAt)) seen.push(`${p.slice(0, 6)}… holds a later run (${sub.timestamp})`);
        else {
          const match = sub.reasonsHash === r.reasonsHash && sub.score === score;
          ok &&= match;
          seen.push(`${p.slice(0, 6)}… ${match ? "✓" : `✗ signed ${sub.score} ${sub.reasonsHash.slice(0, 12)}…`}`);
        }
      }
      onchain.set(r.poolId, seen.join(", "));
    }
    // YieldPilot's testnet exec pool carries the hash of the mainnet pool it holds (src/lib/vigil/publish.ts).
    for (const p of publishers) {
      const exec = await client.getSubmission(EXEC_POOL, p).catch(() => null);
      if (exec?.timestamp !== BigInt(run.computedAt)) continue;
      const held = run.ratings.find((x) => x.reasonsHash === exec.reasonsHash);
      console.log(`exec pool ${EXEC_POOL.slice(0, 6)}… (${p.slice(0, 6)}…): ${held ? `✓ stands in for ${held.name} (${held.grade} ${held.score}), signed ${exec.score}` : "✗ signed a hash no rating in this run has"}`);
      ok &&= !!held;
    }
  }

  console.log("\nhash = reasonsHash recomputed from the archived input · re-rate = this engine on that input · registry = what each publisher signed\n");
  for (const r of check.results) {
    const rating = run.ratings.find((x) => x.poolId === r.poolId)!;
    console.log(
      `${mark(r.inputsHash)} hash  ${mark(r.rerun)} re-rate  ${rating.name.padEnd(14)} ${`${rating.grade} ${rating.score ?? ""}`.padEnd(6)} ${r.poolId.slice(0, 8)}…  ${r.reasonsHash.slice(0, 12)}…` +
        (onchain.has(r.poolId) ? `  registry: ${onchain.get(r.poolId)}` : "") +
        (r.note ? `\n      ${r.note}` : ""),
    );
  }
  console.log(`\n${ok ? "every rating checks out" : "MISMATCH: see ✗ above"}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
