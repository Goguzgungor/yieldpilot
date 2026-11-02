/**
 * Publish Vigil ratings to a RiskRegistry (testnet by default) and read the
 * aggregates back. This is the publisher's job in the M-of-N model: each
 * publisher computes ratings independently and signs `publish_batch` with its
 * own key; the registry aggregates.
 *
 *   PUBLISHER_SECRET=S… npx tsx scripts/vigil-publish.ts [ratings.json | https://…/api/ratings]
 *
 * Defaults: input http://localhost:3000/api/ratings, registry VIGIL_REGISTRY_ID
 * or the testnet demo registry, RPC soroban-testnet. The ratings are of MAINNET
 * pools; on the testnet registry they are a pipeline demo, keyed by the mainnet
 * pool addresses.
 *
 * Optional:
 *   VIGIL_ARCHIVE=path        write the input exactly as read (with ?inputs=1 it
 *                             carries what each reasonsHash covers)
 *   VIGIL_EXEC_POOL_ID=C…     YieldPilot's testnet exec pool (see below)
 *   VIGIL_POSITION_URL=https://yieldpilot.org/api/position
 *
 * With VIGIL_EXEC_POOL_ID set, YieldPilot's testnet exec pool gets the rating of
 * the mainnet pool YieldPilot holds (read from the position URL); see
 * src/lib/vigil/publish.ts, which this shares with /api/cron/publish, the
 * deployment's own publisher. Run by hand (or .github/workflows/vigil-publish.yml)
 * to publish from elsewhere.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { Keypair, rpc } from "@stellar/stellar-sdk";
import { RegistryClient } from "../packages/vigil-sdk/src";
import { publishRatings, type PublishableRating as Rated } from "../src/lib/vigil/publish";

const RPC = process.env.VIGIL_RPC_URL ?? "https://soroban-testnet.stellar.org";
const PASS = process.env.VIGIL_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";
const REGISTRY = process.env.VIGIL_REGISTRY_ID ?? "CB4LXLCCD7YDND5FBVXPKPHUQMF7JFSDRVXHG7ZZTWWNPJ6WDCXDNDF6";
const source = process.argv[2] ?? "http://localhost:3000/api/ratings";
const secret = process.env.PUBLISHER_SECRET;
if (!secret) throw new Error("PUBLISHER_SECRET is required");
const publisher = Keypair.fromSecret(secret);
const server = new rpc.Server(RPC);

async function loadRatings(): Promise<{ engineVersion: string; computedAt: number; ratings: Rated[] }> {
  const text = source.startsWith("http") ? await (await fetch(source)).text() : readFileSync(source, "utf8");
  if (process.env.VIGIL_ARCHIVE) writeFileSync(process.env.VIGIL_ARCHIVE, text);
  const body = JSON.parse(text);
  if (!Array.isArray(body.ratings)) throw new Error(`no ratings in ${source}: ${text.slice(0, 200)}`);
  if (body.stale) console.log("warning: the server returned its last good ratings (stale: true)");
  return { engineVersion: String(body.engineVersion), computedAt: Number(body.computedAt), ratings: body.ratings };
}

async function heldPool(): Promise<string | null> {
  const url = process.env.VIGIL_POSITION_URL;
  return url ? (((await (await fetch(url)).json()) as { poolId?: string | null }).poolId ?? null) : null;
}

async function main() {
  const { engineVersion, computedAt, ratings } = await loadRatings();
  const client = new RegistryClient(REGISTRY, server, PASS, publisher.publicKey());
  console.log(`registry ${REGISTRY} · publishers ${(await client.publishers()).length} · threshold ${await client.threshold()}`);
  console.log(`publishing ${ratings.length} ${engineVersion} ratings computed at ${new Date(computedAt * 1000).toISOString()} as ${publisher.publicKey()}`);
  const execPoolId = process.env.VIGIL_EXEC_POOL_ID;
  const outcome = await publishRatings({
    server,
    networkPassphrase: PASS,
    registryId: REGISTRY,
    publisher,
    engineVersion,
    computedAt,
    ratings,
    execPoolId,
    heldPoolId: execPoolId ? await heldPool() : null,
    log: console.log,
  });
  if (outcome.skippedNotRated) console.log(`skipped ${outcome.skippedNotRated} not-rated (NR) pools`);

  console.log("\non-chain aggregates (get_rating):");
  for (const r of ratings) {
    const agg = await client.getRating(r.poolId);
    console.log(
      `  ${r.name.slice(0, 24).padEnd(24)} ${r.poolId.slice(0, 6)}…  engine ${String(r.score ?? "NR").padStart(3)} ${r.grade}  →  registry ${agg ? `${agg.score} (${agg.publishers} publisher)` : "none"}`,
    );
  }
  if (execPoolId) {
    const agg = await client.getRating(execPoolId);
    console.log(`  ${"exec pool (testnet)".padEnd(24)} ${execPoolId.slice(0, 6)}…  →  registry ${agg ? agg.score : "none"}`);
  }
  if (outcome.failures.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
