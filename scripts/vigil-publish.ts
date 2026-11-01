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
 */
import { readFileSync } from "node:fs";
import { Keypair, TransactionBuilder, rpc, type Transaction } from "@stellar/stellar-sdk";
import { RegistryClient, decodeVigilError, type RatingInput } from "../packages/vigil-sdk/src";

const RPC = process.env.VIGIL_RPC_URL ?? "https://soroban-testnet.stellar.org";
const PASS = process.env.VIGIL_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";
const REGISTRY = process.env.VIGIL_REGISTRY_ID ?? "CB4LXLCCD7YDND5FBVXPKPHUQMF7JFSDRVXHG7ZZTWWNPJ6WDCXDNDF6";
const source = process.argv[2] ?? "http://localhost:3000/api/ratings";
const secret = process.env.PUBLISHER_SECRET;
if (!secret) throw new Error("PUBLISHER_SECRET is required");
const publisher = Keypair.fromSecret(secret);
const server = new rpc.Server(RPC);

interface Rated {
  poolId: string;
  name: string;
  score: number;
  grade: string;
  reasonsHash: string;
}

async function loadRatings(): Promise<{ computedAt: number; ratings: Rated[] }> {
  const body = source.startsWith("http") ? await (await fetch(source)).json() : JSON.parse(readFileSync(source, "utf8"));
  return { computedAt: Number(body.computedAt), ratings: body.ratings };
}

async function send(tx: Transaction): Promise<string> {
  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") throw new Error(`send ERROR ${sent.errorResult?.toXDR("base64")}`);
  let g = await server.getTransaction(sent.hash);
  for (let i = 0; i < 30 && g.status === "NOT_FOUND"; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    g = await server.getTransaction(sent.hash);
  }
  if (g.status !== "SUCCESS") throw new Error(`tx ${sent.hash} ${g.status}`);
  return sent.hash;
}

async function main() {
  const { computedAt, ratings } = await loadRatings();
  const client = new RegistryClient(REGISTRY, server, PASS, publisher.publicKey());
  console.log(`registry ${REGISTRY} · publishers ${(await client.publishers()).length} · threshold ${await client.threshold()}`);
  console.log(`publishing ${ratings.length} ratings computed at ${new Date(computedAt * 1000).toISOString()} as ${publisher.publicKey()}`);

  // The registry rejects timestamps in the future and older than its max age;
  // the engine's computedAt is mainnet chain time, which is what we sign.
  const inputs: RatingInput[] = ratings.map((r) => ({
    pool: r.poolId,
    score: r.score,
    timestamp: BigInt(computedAt),
    reasonsHash: r.reasonsHash,
  }));
  for (let i = 0; i < inputs.length; i += 8) {
    const chunk = inputs.slice(i, i + 8);
    const tx = new TransactionBuilder(await server.getAccount(publisher.publicKey()), { fee: "10000000", networkPassphrase: PASS })
      .addOperation(client.publishBatchOp(publisher.publicKey(), chunk))
      .setTimeout(120)
      .build();
    try {
      const prepared = await server.prepareTransaction(tx);
      prepared.sign(publisher);
      console.log(`  publish_batch ${i + 1}–${i + chunk.length}: ${await send(prepared)}`);
    } catch (e) {
      const msg = (e as Error).message;
      const v = decodeVigilError(msg);
      console.log(`  publish_batch ${i + 1}–${i + chunk.length} FAILED: ${v ? `${v.code} ${v.name}` : msg.split("\n")[0]}`);
    }
  }

  console.log("\non-chain aggregates (get_rating):");
  for (const r of ratings) {
    const agg = await client.getRating(r.poolId);
    console.log(
      `  ${r.name.slice(0, 24).padEnd(24)} ${r.poolId.slice(0, 6)}…  engine ${String(r.score).padStart(3)} ${r.grade}  →  registry ${agg ? `${agg.score} (${agg.publishers} publisher)` : "none"}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
