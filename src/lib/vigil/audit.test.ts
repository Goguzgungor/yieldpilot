import { describe, expect, it } from "vitest";
import { restoreSnapshot, splitBooks, verifyRun, type ArchivedRun } from "./audit";
import { toSample } from "./depthHistory";
import { functionSource } from "./discovery";
import { runVigil, toRatingsJson } from "./engine";
import { hashInputs } from "./score";
import { cid, depth, healthyPool, reserve, src, T0 } from "./testkit";
import type { PoolSnapshot } from "./types";

// A pool with SDEX-priced collateral (a current book and two stored ones) and
// a DeFindex strategy on it, through the engine and a JSON round trip, as the
// archive keeps it.
const pool = cid("audit-pool");
const ustry = reserve("USTRY", { supplied: 2_000, borrowed: 0, priceUsd: 1.06, supplyCap: 250_000, source: src("reflector_dex", { maxDevPct: 10 }) });
const snap: PoolSnapshot = {
  ...healthyPool({ poolId: pool, name: "Audit" }),
  dexDepth: { [ustry.assetId]: depth(ustry.assetId, [[1.07, 50_000], [1.2, 80_000], [9, 1]]) },
  dexDepthHistory: {
    [ustry.assetId]: [
      toSample(depth(ustry.assetId, [[1.05, 40_000], [1.3, 10]]), T0 - 7200, 1.04),
      toSample(depth(ustry.assetId, [[1.06, 45_000]]), T0 - 3600, 1.06),
    ],
  },
};
snap.reserves.push(ustry);

async function archivedRun() {
  const r = await runVigil(
    { sources: [functionSource("factory", async () => [pool], true)], verifier: { isPool: async () => true }, snapshot: async () => snap },
    { defindexStrategies: [{ strategyId: cid("strategy"), name: "Strategy", asset: "USDC", assetContractId: snap.reserves[0].assetId, blendPoolId: pool }] },
  );
  return JSON.parse(JSON.stringify(toRatingsJson(r)));
}

describe("the run archive keeps every order book", () => {
  it("stores each book once by its hash, and the snapshot comes back exactly", async () => {
    const run = await archivedRun();
    expect(Object.keys(run.books)).toHaveLength(3);
    expect(run.inputs[pool].dexDepth[ustry.assetId]).toMatchObject({ levels: 3, bestAsk: 1.07, asksHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(run.inputs[pool].dexDepth[ustry.assetId].asks).toBeUndefined();
    const back = restoreSnapshot(run.inputs[pool], run.books);
    expect(hashInputs(back)).toEqual(hashInputs(snap));
  });

  it("splits the books out for storage", async () => {
    const run = await archivedRun();
    const { run: lean, books } = splitBooks(run);
    expect(lean).not.toHaveProperty("books");
    expect({ ...lean, books }).toEqual(run);
  });
});

describe("verifyRun", () => {
  it("re-hashes every rating from the archived inputs and re-rates every pool", async () => {
    const out = verifyRun(await archivedRun());
    expect(out.results.map((x) => [x.name, x.inputsHash, x.rerun])).toEqual([
      ["Audit", true, true],
      ["Strategy", true, true],
    ]);
    expect(out.ok).toBe(true);
  });

  it("a changed order book no longer matches the hash", async () => {
    const run = await archivedRun();
    const h = run.inputs[pool].dexDepthHistory[ustry.assetId][0].asksHash;
    run.books[h][0].amount = 39_999;
    const out = verifyRun(run);
    expect(out.ok).toBe(false);
    expect(out.results[0]).toMatchObject({ inputsHash: false, rerun: false });
  });

  it("a changed factor fails the re-hash; the re-rate says what differs", async () => {
    const run = await archivedRun();
    run.ratings[0].factors[0].value = 1;
    const out = verifyRun(run);
    expect(out.results[0].inputsHash).toBe(false);
    expect(out.results[0].note).toMatch(/oracle_source/);
  });

  it("reports a missing book instead of throwing", async () => {
    const run = await archivedRun();
    delete run.books[run.inputs[pool].dexDepth[ustry.assetId].asksHash];
    const out = verifyRun(run);
    expect(out.ok).toBe(false);
    expect(out.results[0]).toMatchObject({ inputsHash: false, rerun: null, note: expect.stringMatching(/book .* not in the archive/) });
  });

  it("says when a run predates the full archive", () => {
    const old = { engineVersion: "vigil-risk-v2.3.0", computedAt: 1, ratings: [], inputs: { P: { dexDepth: { A: { levels: 3, bestAsk: 1 } } } } };
    expect(verifyRun(old as unknown as ArchivedRun)).toMatchObject({ ok: false, error: expect.stringMatching(/predates the full archive/) });
  });
});
