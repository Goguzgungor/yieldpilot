import { describe, it, expect } from "vitest";
import { createPoolDiscovery, isDiscoveryCacheFresh, mergePoolIds, DISCOVERY_TTL_MS, type PoolSource } from "./discovery";

const FALLBACK = ["C_FALLBACK_A", "C_FALLBACK_B"];

const sourceReturning = (ids: string[]): PoolSource => ({ listPools: async () => ids });
const sourceThrowing = (): PoolSource => ({
  listPools: async () => {
    throw new Error("rpc down");
  },
});

describe("createPoolDiscovery", () => {
  it("returns the source pools (deduped) when the source yields ids", async () => {
    const d = createPoolDiscovery(sourceReturning(["C_X", "C_Y", "C_X"]), FALLBACK);
    expect(await d.discoverPoolIds()).toEqual(["C_X", "C_Y"]);
  });

  it("returns the fallback list when the source returns []", async () => {
    const d = createPoolDiscovery(sourceReturning([]), FALLBACK);
    expect(await d.discoverPoolIds()).toEqual(FALLBACK);
  });

  it("returns the fallback list when the source throws", async () => {
    const d = createPoolDiscovery(sourceThrowing(), FALLBACK);
    expect(await d.discoverPoolIds()).toEqual(FALLBACK);
  });
});

describe("mergePoolIds", () => {
  it("keeps every known pool and appends the new ones, deduped", () => {
    expect(mergePoolIds(["A", "B"], ["B", "C", "C"])).toEqual(["A", "B", "C"]);
  });
  it("does not shrink when discovery comes back with fewer pools", () => {
    expect(mergePoolIds(["A", "B", "C"], ["A"])).toEqual(["A", "B", "C"]);
  });
  it("is the discovery result when nothing was known", () => {
    expect(mergePoolIds([], ["A", "B"])).toEqual(["A", "B"]);
  });
});

describe("isDiscoveryCacheFresh", () => {
  const NOW = 1_700_000_000_000; // arbitrary epoch-ms anchor

  it("returns true when cache is younger than TTL", () => {
    // 1 second old — well within TTL
    expect(isDiscoveryCacheFresh(NOW - 1_000, NOW)).toBe(true);
  });

  it("returns true when cache is exactly 1ms before the TTL boundary", () => {
    expect(isDiscoveryCacheFresh(NOW - DISCOVERY_TTL_MS + 1, NOW)).toBe(true);
  });

  it("returns false when cache is exactly at the TTL boundary (== ttl)", () => {
    // age === TTL → NOT fresh (strictly less than)
    expect(isDiscoveryCacheFresh(NOW - DISCOVERY_TTL_MS, NOW)).toBe(false);
  });

  it("returns false when cache is older than TTL", () => {
    // 2× TTL old
    expect(isDiscoveryCacheFresh(NOW - DISCOVERY_TTL_MS * 2, NOW)).toBe(false);
  });

  it("returns false when discoveredAtMs is null", () => {
    expect(isDiscoveryCacheFresh(null, NOW)).toBe(false);
  });

  it("returns false when discoveredAtMs is undefined", () => {
    expect(isDiscoveryCacheFresh(undefined, NOW)).toBe(false);
  });

  it("returns false when discoveredAtMs is 0", () => {
    expect(isDiscoveryCacheFresh(0, NOW)).toBe(false);
  });

  it("returns false when discoveredAtMs is NaN", () => {
    expect(isDiscoveryCacheFresh(NaN, NOW)).toBe(false);
  });

  it("respects a custom ttlMs override", () => {
    const customTtl = 5_000; // 5 seconds
    expect(isDiscoveryCacheFresh(NOW - 4_000, NOW, customTtl)).toBe(true);
    expect(isDiscoveryCacheFresh(NOW - 5_000, NOW, customTtl)).toBe(false);
    expect(isDiscoveryCacheFresh(NOW - 6_000, NOW, customTtl)).toBe(false);
  });
});
