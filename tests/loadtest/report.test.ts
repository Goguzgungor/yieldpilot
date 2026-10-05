import { describe, expect, it } from "vitest";
import type { FetchLike } from "../../scripts/loadtest/chain";
import type { EventRecord, ManifestRecord, StepRecord } from "../../scripts/loadtest/manifest";
import { activityHashes, collectHashes, horizonAccountTxs, parseActivity, rpcGetTransaction, runWindow, summarize } from "../../scripts/loadtest/report";
import type { Plan } from "../../scripts/loadtest/schedule";

const ev = (p: Partial<EventRecord> & Pick<EventRecord, "eventId" | "kind" | "status">): EventRecord => ({
  type: "event", plannedAt: 0, startedAt: 0, finishedAt: 0, hashes: [], ...p,
});
const st = (p: Partial<StepRecord> & Pick<StepRecord, "eventId" | "step">): StepRecord => ({ type: "step", at: 0, hashes: [], ...p });

describe("collectHashes", () => {
  it("dedupes step + event hashes in first-seen order", () => {
    const recs: ManifestRecord[] = [
      st({ eventId: "onboard:w00", step: "deploy", hashes: ["a"] }),
      ev({ eventId: "onboard:w00", kind: "onboard", status: "ok", hashes: ["a", "b"] }),
    ];
    expect(collectHashes(recs)).toEqual(["a", "b"]);
  });
});

describe("horizonAccountTxs", () => {
  const window = { sinceIso: "2026-10-06T09:00:00Z", untilIso: "2026-10-07T09:00:00Z" };
  it("includes failed txs, follows next links and keeps only the run window", async () => {
    const first = "https://horizon-testnet.stellar.org/accounts/GA/transactions?order=asc&limit=200&include_failed=true";
    const pages: Record<string, unknown> = {
      [first]: {
        _embedded: { records: [{ hash: "old", created_at: "2026-10-05T00:00:00Z" }, { hash: "a", created_at: "2026-10-06T10:00:00Z" }] },
        _links: { next: { href: "p2" } },
      },
      p2: { _embedded: { records: [{ hash: "b", created_at: "2026-10-06T11:00:00Z" }] }, _links: { next: { href: "p3" } } },
      p3: { _embedded: { records: [] }, _links: { next: { href: "p4" } } },
    };
    const fetchFn: FetchLike = async (url) => ({ status: 200, json: async () => pages[url] });
    expect((await horizonAccountTxs("GA", window, fetchFn)).map((t) => t.hash)).toEqual(["a", "b"]);
  });
  it("drops txs after the window and stops paging there (a later smoke/other run must not leak in)", async () => {
    const first = "https://horizon-testnet.stellar.org/accounts/GA/transactions?order=asc&limit=200&include_failed=true";
    const pages: Record<string, unknown> = {
      [first]: {
        _embedded: { records: [{ hash: "a", created_at: "2026-10-06T10:00:00Z" }, { hash: "late", created_at: "2026-10-08T00:00:00Z" }] },
        _links: { next: { href: "never" } },
      },
    };
    const fetched: string[] = [];
    const fetchFn: FetchLike = async (url) => {
      fetched.push(url);
      return { status: 200, json: async () => pages[url] };
    };
    expect((await horizonAccountTxs("GA", window, fetchFn)).map((t) => t.hash)).toEqual(["a"]);
    expect(fetched).toEqual([first]);
  });
  it("returns [] for an account Horizon does not know", async () => {
    const fetchFn: FetchLike = async () => ({ status: 404, json: async () => ({}) });
    expect(await horizonAccountTxs("GX", window, fetchFn)).toEqual([]);
  });
});

describe("runWindow", () => {
  const startedAt = Date.parse("2026-10-06T10:00:00Z");
  it("starts 2 min before the run (clock skew, not the 40-min-earlier smoke run) and ends 15 min after the plan", () => {
    expect(runWindow({ startedAt, timeScale: 1 }, [])).toEqual({
      sinceMs: startedAt - 120_000,
      untilMs: startedAt + 1440 * 60_000 + 900_000,
      sinceIso: "2026-10-06T09:58:00Z",
      untilIso: "2026-10-07T10:15:00Z",
    });
  });
  it("stretches to the last finished event when the driver lagged", () => {
    const late = startedAt + 1440 * 60_000 + 3_600_000;
    const recs: ManifestRecord[] = [ev({ eventId: "tick:1430", kind: "tick", status: "ok", finishedAt: late })];
    expect(runWindow({ startedAt, timeScale: 1 }, recs).untilMs).toBe(late + 900_000);
  });
  it("scales the plan length for compressed smoke runs", () => {
    expect(runWindow({ startedAt, timeScale: 1 / 96 }, []).untilMs).toBe(startedAt + 900_000 + 900_000);
  });
});

describe("activityHashes", () => {
  it("collects txHash, hash and hashes[] from activity meta", () => {
    const rows = parseActivity([
      { ts: 1, kind: "faucet", message: "minted", meta: JSON.stringify({ to: "C", txHash: "m1" }) },
      { ts: 2, kind: "onboard", message: "deploy", meta: JSON.stringify({ hash: "d1", status: "SUCCESS" }) },
      { ts: 3, kind: "peruser", message: "supplied", meta: JSON.stringify({ hashes: ["s1", "s2"] }) },
      { ts: 4, kind: "scan", message: "scanned", meta: null },
      { ts: 5, kind: "peruser", message: "supplied", meta: JSON.stringify({ hashes: ["s1"] }) },
    ]);
    expect(activityHashes(rows)).toEqual(["m1", "d1", "s1", "s2"]);
  });
});

describe("rpcGetTransaction", () => {
  it("keeps the raw result and tags it with the hash", async () => {
    const post = async () => ({ result: { status: "SUCCESS", envelopeXdr: "E", resultMetaXdr: "M", ledger: 7 } });
    expect(await rpcGetTransaction("http://rpc", "h1", post)).toEqual({ hash: "h1", status: "SUCCESS", envelopeXdr: "E", resultMetaXdr: "M", ledger: 7 });
  });
  it("records an RPC error instead of throwing", async () => {
    const post = async () => ({ error: { message: "boom" } });
    expect(await rpcGetTransaction("http://rpc", "h1", post)).toEqual({ hash: "h1", status: "RPC_ERROR", error: "boom" });
  });
});

describe("summarize", () => {
  const plan: Plan = { seed: 1, wallets: [{ index: 0, cohort: "whale" }, { index: 1, cohort: "dust" }], events: [] };
  const recs: ManifestRecord[] = [
    st({ eventId: "onboard:w00", wallet: 0, step: "fund", hashes: ["m1"], data: { usdc: 5000 } }),
    ev({ eventId: "onboard:w00", kind: "onboard", wallet: 0, status: "ok", data: { smartWallet: "CSA0" } }),
    ev({ eventId: "onboard:w01", kind: "onboard", wallet: 1, status: "failed", plannedAt: 100, startedAt: 2_100 }),
    st({ eventId: "topup:w00:1", wallet: 0, step: "mint-sa", data: { usdc: 3000 } }),
    ev({ eventId: "topup:w00:1", kind: "topup", wallet: 0, status: "ok" }),
    ev({ eventId: "tick:0010", kind: "tick", status: "ok", data: { durationMs: 1000 } }),
    ev({ eventId: "tick:0030", kind: "tick", status: "ok", data: { durationMs: 3000 } }),
    ev({ eventId: "tick:0050", kind: "tick", status: "failed" }),
  ];
  const activity = parseActivity([
    { ts: 1, kind: "peruser", message: "supplied", meta: JSON.stringify({ smartWallet: "CSA0", hashes: ["s1"], amount: "20000000000" }) },
    { ts: 2, kind: "peruser", message: "supplied", meta: JSON.stringify({ smartWallet: "CSA0", hashes: ["s2"], amount: "20000000000" }) },
    { ts: 3, kind: "error", message: "per-user supply failed for GAAA…: simulate failed", meta: JSON.stringify({ smartWallet: "CSA0", hashes: [] }) },
    { ts: 4, kind: "error", message: "tick failed: boom", meta: null },
    { ts: 5, kind: "peruser", message: "skip GAAA… — no idle USDC", meta: JSON.stringify({ smartWallet: "CSA0" }) },
    { ts: 6, kind: "faucet", message: "minted 5000 USDC → CSA0", meta: JSON.stringify({ to: "CSA0", amount: 5000, txHash: "m1" }) },
    // A mint the driver never recorded (killed mid-request, then replayed).
    { ts: 7, kind: "faucet", message: "minted 5000 USDC → CSA0", meta: JSON.stringify({ to: "CSA0", amount: 5000, txHash: "m2" }) },
  ]);

  it("counts per cohort from events + the server's activity log", () => {
    const s = summarize(plan, recs, activity);
    expect(s.cohorts.whale).toEqual({ wallets: 1, onboarded: 1, onboardFailed: 0, mintedUsdc: 8000, supplies: 2, suppliedUsdc: 4000, supplyErrors: 1 });
    expect(s.cohorts.dust).toMatchObject({ wallets: 1, onboarded: 0, onboardFailed: 1 });
    expect(s.ticks).toEqual({ ok: 2, failed: 1, avgDurationMs: 2000, maxDurationMs: 3000, serverTickFailures: 1 });
    expect(s.events).toEqual({ ok: 4, failed: 2, skipped: 0 });
    expect(s.maxLagMs).toBe(2000);
    expect(s.activityIncluded).toBe(true);
    expect(s.unrecordedMints).toBe(1);
  });
  it("works without the activity log (--local-only)", () => {
    const s = summarize(plan, recs, null);
    expect(s.activityIncluded).toBe(false);
    expect(s.cohorts.whale.supplies).toBe(0);
    expect(s.cohorts.whale.mintedUsdc).toBe(8000);
    expect(s.unrecordedMints).toBeNull();
  });
});
