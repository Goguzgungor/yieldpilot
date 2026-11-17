import { describe, expect, it } from "vitest";
import {
  KNOWN_BLEND_POOLS,
  decodeDeployBody,
  deployEventsSource,
  discoverBlendPools,
  functionSource,
  knownPoolsSource,
  mergeKnownPools,
  nextKnownPools,
  stellarExpertDeploySource,
  type PoolIdSource,
} from "./discovery";
import { cid } from "./testkit";

// Real mainnet PoolFactory `deploy` event bodies (Stellar Expert, factory CDSYOAVX…).
const FIXED_BODY = "AAAAEgAAAAESnMjMYzbx/bvcwPOYNDTDzbhf2eqFaXo3gtMY2HSlgA==";
const YIELDBLOX_BODY = "AAAAEgAAAAGEJEJDQtEzsZ94ZLqOfWIlLH468xubivw/09TDpXow4w==";
const FIXED = "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD";
const YIELDBLOX = "CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS";
const FACTORY = "CDSYOAVXFY7SM5S64IZPPPYB4GVGGLMQVFREPSQQEZVIWXX5R23G4QSU";

describe("decodeDeployBody", () => {
  it("decodes the ScAddress body of a factory deploy event", () => {
    expect(decodeDeployBody(FIXED_BODY)).toBe(FIXED);
    expect(decodeDeployBody(YIELDBLOX_BODY)).toBe(YIELDBLOX);
    expect(decodeDeployBody("not-xdr")).toBeNull();
  });
});

describe("stellarExpertDeploySource", () => {
  it("paginates with the cursor, keeps only deploy events and dedupes", async () => {
    const urls: string[] = [];
    const pages: Record<string, unknown> = {
      first: { _embedded: { records: [
        { id: "1", topics: ["deploy"], bodyXdr: FIXED_BODY },
        { id: "2", topics: ["set_admin"], bodyXdr: YIELDBLOX_BODY },
      ] } },
      second: { _embedded: { records: [
        { id: "3", topics: ["deploy"], bodyXdr: YIELDBLOX_BODY },
        { id: "4", topics: ["deploy"], bodyXdr: FIXED_BODY },
      ] } },
      third: { _embedded: { records: [] } },
    };
    const src = stellarExpertDeploySource({
      factoryId: FACTORY,
      pageLimit: 2,
      fetchJson: async (url) => {
        urls.push(url);
        return url.includes("cursor=4") ? pages.third : url.includes("cursor=2") ? pages.second : pages.first;
      },
    });
    expect(await src.list()).toEqual([FIXED, YIELDBLOX]);
    expect(urls[0]).toBe(`https://api.stellar.expert/explorer/public/contract/${FACTORY}/events?order=asc&limit=2`);
    expect(urls[1]).toContain("&cursor=2");
    expect(src.authoritative).toBe(true);
  });

  it("throws on an unexpected response so discovery can report the source error", async () => {
    const src = stellarExpertDeploySource({ factoryId: FACTORY, fetchJson: async () => ({ error: "nope" }) });
    await expect(src.list()).rejects.toThrow();
  });
});

describe("discoverBlendPools", () => {
  const a = cid("pool-a");
  const b = cid("pool-b");
  const c = cid("pool-c");
  const fake = cid("not-a-pool");

  it("unions sources + curated fallback, verifies with is_pool and drops rejects", async () => {
    const r = await discoverBlendPools({
      sources: [functionSource("factory", async () => [a, b], true), functionSource("reward-zone", async () => [b, fake])],
      verifier: { isPool: async (id) => id !== fake },
      fallbackIds: [c, "garbage"],
    });
    expect(r.poolIds).toEqual([a, b, c]);
    expect(r.rejected).toEqual([fake]);
    expect(r.candidates.find((x) => x.poolId === b)!.sources).toEqual(["factory", "reward-zone"]);
    expect(r.fallbackOnly).toBe(false);
  });

  it("keeps unverifiable candidates only when an authoritative source or the curated list vouches", async () => {
    const r = await discoverBlendPools({
      sources: [functionSource("factory", async () => [a], true), functionSource("events", async () => [b])],
      verifier: { isPool: async () => null },
      fallbackIds: [c],
    });
    expect(r.poolIds).toEqual([a, c]);
    expect(r.rejected).toEqual([b]);
    expect(r.candidates.every((x) => x.verified === null)).toBe(true);
  });

  it("falls back to curated ids and reports source errors when the indexer is down", async () => {
    const r = await discoverBlendPools({
      sources: [functionSource("factory", async () => { throw new Error("503"); }, true)],
      verifier: { isPool: async () => true },
      fallbackIds: [a],
    });
    expect(r.poolIds).toEqual([a]);
    expect(r.fallbackOnly).toBe(true);
    expect(r.sources[0]).toMatchObject({ name: "factory", count: 0, error: "503" });
  });
});

describe("known pools + deploy events (no indexer)", () => {
  const a = cid("pool-a");
  const b = cid("pool-b");
  const fresh = cid("pool-new");
  const known = { ids: [a, b], syncedLedger: 1000 };
  const indexerDown = (scope: string): PoolIdSource => ({
    ...functionSource(`stellar-expert:${scope}`, async () => {
      throw new Error("402 Payment Required");
    }, true),
    scope,
  });
  const events = (scope: string, scan: { pools: string[]; startLedger: number; endLedger: number }) =>
    deployEventsSource({ scope, known, scan: async () => scan });

  it("is complete without the indexer when the events since the known ledger are all on the RPC", async () => {
    const seen: number[] = [];
    const r = await discoverBlendPools({
      sources: [
        deployEventsSource({ scope: "v2", known, scan: async (from) => (seen.push(from), { pools: [fresh], startLedger: from, endLedger: 1500 }) }),
        indexerDown("v2"),
        events("v2.1", { pools: [], startLedger: 1001, endLedger: 1498 }),
        indexerDown("v2.1"),
        knownPoolsSource(known),
      ],
      verifier: { isPool: async () => true },
    });
    expect(seen).toEqual([1001]); // the scan starts at the first ledger after the known set
    expect(r.poolIds).toEqual([fresh, a, b]);
    expect(r.fallbackOnly).toBe(false);
    expect(r.syncedLedger).toBe(1498); // the earliest ledger any deployment was read to
    expect(r.sources.map((x) => [x.name, x.count, !!x.error])).toEqual([
      ["rpc:factory-deploy-events:v2", 1, false],
      ["stellar-expert:v2", 0, true],
      ["rpc:factory-deploy-events:v2.1", 0, false],
      ["stellar-expert:v2.1", 0, true],
      ["known-pools", 2, false],
      ["curated", 0, false],
    ]);
    expect(r.sources[0].note).toBe("ledgers 1001-1500");
  });

  it("says so when the RPC no longer has the ledgers after the known set", async () => {
    const r = await discoverBlendPools({
      sources: [
        events("v2", { pools: [], startLedger: 1001, endLedger: 9000 }),
        events("v2.1", { pools: [], startLedger: 5000, endLedger: 9000 }),
        knownPoolsSource(known),
      ],
      verifier: { isPool: async () => true },
    });
    expect(r.poolIds).toEqual([a, b]); // the known pools are still rated
    expect(r.fallbackOnly).toBe(true);
    expect(r.syncedLedger).toBeUndefined();
    expect(r.sources[1].note).toBe("ledgers 5000-9000; 1001-4999 are no longer on the RPC");
  });

  it("needs every deployment complete, not just one", async () => {
    const r = await discoverBlendPools({
      sources: [
        { ...functionSource("stellar-expert:v2", async () => [a], true), scope: "v2" },
        indexerDown("v2.1"),
        knownPoolsSource(known),
      ],
      verifier: { isPool: async () => true },
    });
    expect(r.fallbackOnly).toBe(true);
  });

  it("is complete through the indexer alone, and closes an RPC gap when it answers", async () => {
    const r = await discoverBlendPools({
      sources: [
        events("v2", { pools: [], startLedger: 5000, endLedger: 9000 }),
        { ...functionSource("stellar-expert:v2", async () => [a, b, fresh], true), scope: "v2" },
        knownPoolsSource(known),
      ],
      verifier: { isPool: async () => true },
    });
    expect(r.fallbackOnly).toBe(false);
    expect(r.poolIds).toEqual([a, b, fresh]);
    expect(r.syncedLedger).toBeUndefined(); // no ledger is known for the indexer's answer
  });

  it("keeps known pools when is_pool cannot be asked, and drops one it denies", async () => {
    const unreachable = await discoverBlendPools({ sources: [knownPoolsSource(known)], verifier: { isPool: async () => null } });
    expect(unreachable.poolIds).toEqual([a, b]);
    const denied = await discoverBlendPools({ sources: [knownPoolsSource(known)], verifier: { isPool: async (id) => id !== b } });
    expect(denied.poolIds).toEqual([a]);
    expect(denied.rejected).toEqual([b]);
  });
});

describe("the stored known-pool set", () => {
  const a = cid("pool-a");
  const b = cid("pool-b");
  const c = cid("pool-c");
  const builtIn = { ids: [a, b], syncedLedger: 1000 };

  it("starts from the built-in list when nothing is stored or the stored value is unusable", () => {
    expect(mergeKnownPools(null, builtIn)).toEqual(builtIn);
    expect(mergeKnownPools({ ids: "x", syncedLedger: 5 } as never, builtIn)).toEqual(builtIn);
  });

  it("never loses a built-in pool or moves the ledger back", () => {
    expect(mergeKnownPools({ ids: [c], syncedLedger: 400 }, builtIn)).toEqual({ ids: [a, b, c], syncedLedger: 1000 });
    expect(mergeKnownPools({ ids: [a, c], syncedLedger: 2000 }, builtIn)).toEqual({ ids: [a, b, c], syncedLedger: 2000 });
  });

  it("adds only pools is_pool confirmed, and moves the ledger only after a complete run", async () => {
    const run = (verified: boolean | null, complete: boolean) =>
      discoverBlendPools({
        sources: [
          deployEventsSource({ scope: "v2", known: builtIn, scan: async (from) => ({ pools: [c], startLedger: complete ? from : from + 50, endLedger: 3000 }) }),
          knownPoolsSource(builtIn),
        ],
        verifier: { isPool: async () => verified },
      });
    expect(nextKnownPools(builtIn, await run(true, true))).toEqual({ ids: [a, b, c], syncedLedger: 3000 });
    expect(nextKnownPools(builtIn, await run(true, false))).toEqual({ ids: [a, b, c], syncedLedger: 1000 });
    expect(nextKnownPools(builtIn, await run(null, true))).toEqual({ ids: [a, b], syncedLedger: 3000 });
  });

  it("ships the 13 pools of Blend's two factories", () => {
    expect(KNOWN_BLEND_POOLS.ids.length).toBe(13);
    expect(new Set(KNOWN_BLEND_POOLS.ids).size).toBe(13);
    expect(KNOWN_BLEND_POOLS.ids.every((id) => /^C[A-Z2-7]{55}$/.test(id))).toBe(true);
    expect(KNOWN_BLEND_POOLS.syncedLedger).toBeGreaterThan(65_000_000);
  });
});
