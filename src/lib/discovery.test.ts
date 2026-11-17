import { describe, it, expect } from "vitest";
import { Address, Contract, xdr } from "@stellar/stellar-sdk";
import {
  createPoolDiscovery,
  isDiscoveryCacheFresh,
  ledgerOfCursor,
  mergePoolIds,
  scanFactoryDeploys,
  DISCOVERY_TTL_MS,
  type EventsRpc,
  type PoolSource,
} from "./discovery";

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

// ── scanFactoryDeploys ───────────────────────────────────────────────────────

const FACTORY = "CDSYOAVXFY7SM5S64IZPPPYB4GVGGLMQVFREPSQQEZVIWXX5R23G4QSU";
const POOL_A = "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD";
const POOL_B = "CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS";

/** An event cursor at the end of `ledger`, as the RPC writes it. */
const cursorAt = (ledger: number) => `${((BigInt(ledger) << 32n) | 0xffffffffn).toString().padStart(19, "0")}-4294967295`;

function deployEvent(pool: string, ledger: number, topic = "deploy") {
  return {
    id: `${ledger}-1`,
    type: "contract",
    ledger,
    ledgerClosedAt: "2026-11-17T00:00:00Z",
    contractId: new Contract(FACTORY),
    topic: [xdr.ScVal.scvSymbol(topic)],
    value: new Address(pool).toScVal(),
    txHash: "00",
  };
}

/**
 * An RPC that, like stellar-rpc, reads `window` ledgers per getEvents call and
 * then hands back a cursor, whether or not it found an event.
 */
function fakeRpc(opts: { oldest: number; latest: number; window: number; events: ReturnType<typeof deployEvent>[] }) {
  const calls: { startLedger?: number; cursor?: string }[] = [];
  const server = {
    getLatestLedger: async () => ({ sequence: opts.latest }),
    getEvents: async (req: { startLedger?: number; cursor?: string; limit?: number }) => {
      calls.push({ startLedger: req.startLedger, cursor: req.cursor });
      const from = req.cursor ? ledgerOfCursor(req.cursor)! + 1 : req.startLedger!;
      if (from < opts.oldest) throw new Error(`startLedger must be within the ledger range: ${opts.oldest} - ${opts.latest}`);
      const to = Math.min(from + opts.window - 1, opts.latest);
      const events = req.limit === 1 ? [] : opts.events.filter((e) => e.ledger >= from && e.ledger <= to);
      return { events, cursor: cursorAt(to), latestLedger: opts.latest, oldestLedger: opts.oldest };
    },
  } as unknown as EventsRpc;
  return { server, calls };
}

describe("ledgerOfCursor", () => {
  it("reads the ledger out of an RPC event cursor", () => {
    expect(ledgerOfCursor("0281453991500447743-4294967295")).toBe(65531113);
    expect(ledgerOfCursor(cursorAt(65410124))).toBe(65410124);
    expect(ledgerOfCursor("not-a-cursor")).toBeNull();
  });
});

describe("scanFactoryDeploys", () => {
  it("follows the cursor through empty pages to the latest ledger", async () => {
    // A pool deployed 85,000 ledgers after the oldest retained one: nine empty pages come first.
    const { server, calls } = fakeRpc({ oldest: 100_000, latest: 220_959, window: 10_000, events: [deployEvent(POOL_A, 185_000)] });
    const scan = await scanFactoryDeploys(server, FACTORY);
    expect(scan.pools).toEqual([POOL_A]);
    expect(scan.startLedger).toBe(100_000);
    expect(scan.endLedger).toBe(220_959);
    expect(calls.length).toBe(1 + 13); // the probe, then 13 windows of 10,000 ledgers
  });

  it("starts at the ledger asked for and reads one page when the tip is close", async () => {
    const { server, calls } = fakeRpc({ oldest: 100_000, latest: 220_959, window: 10_000, events: [deployEvent(POOL_A, 185_000), deployEvent(POOL_B, 220_900)] });
    const scan = await scanFactoryDeploys(server, FACTORY, { fromLedger: 220_600 });
    expect(scan).toEqual({ pools: [POOL_B], startLedger: 220_600, endLedger: 220_959 });
    expect(calls.length).toBe(2);
  });

  it("reports the oldest retained ledger when the one asked for is gone", async () => {
    const { server } = fakeRpc({ oldest: 100_000, latest: 105_000, window: 10_000, events: [] });
    const scan = await scanFactoryDeploys(server, FACTORY, { fromLedger: 50_000 });
    expect(scan).toEqual({ pools: [], startLedger: 100_000, endLedger: 105_000 });
  });

  it("looks back a set number of ledgers and ignores events that are not deploys", async () => {
    const { server, calls } = fakeRpc({
      oldest: 100_000,
      latest: 220_959,
      window: 10_000,
      events: [deployEvent(POOL_A, 150_000), deployEvent(POOL_B, 200_000), deployEvent(POOL_A, 210_000, "set_admin")],
    });
    const scan = await scanFactoryDeploys(server, FACTORY, { lookback: 30_000 });
    expect(scan.pools).toEqual([POOL_B]);
    expect(scan.startLedger).toBe(190_959);
    expect(calls.length).toBe(1 + 4);
  });

  it("stops when the RPC returns no cursor, taking the page as the end", async () => {
    const server = {
      getLatestLedger: async () => ({ sequence: 500 }),
      getEvents: async () => ({ events: [], latestLedger: 500, oldestLedger: 100 }),
    } as unknown as EventsRpc;
    expect(await scanFactoryDeploys(server, FACTORY)).toEqual({ pools: [], startLedger: 100, endLedger: 500 });
  });
});
