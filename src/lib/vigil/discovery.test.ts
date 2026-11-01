import { describe, expect, it } from "vitest";
import { decodeDeployBody, discoverBlendPools, functionSource, stellarExpertDeploySource } from "./discovery";
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
