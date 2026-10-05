import { describe, it, expect } from "vitest";
import { nextTickAt } from "./cadence";

const at = (iso: string) => Date.parse(iso);

describe("nextTickAt", () => {
  it("on serverless, is the next daily cron run (00:00 UTC)", () => {
    expect(nextTickAt({ serverless: true, now: at("2026-10-05T17:30:00Z"), lastScanAt: null, intervalSec: 30 }))
      .toBe(at("2026-10-06T00:00:00Z"));
  });

  it("on serverless at exactly midnight, is the following midnight", () => {
    expect(nextTickAt({ serverless: true, now: at("2026-10-06T00:00:00Z"), lastScanAt: null, intervalSec: 30 }))
      .toBe(at("2026-10-07T00:00:00Z"));
  });

  it("on a long-lived server, is one interval after the last scan", () => {
    const last = at("2026-10-05T17:00:00Z");
    expect(nextTickAt({ serverless: false, now: last + 10_000, lastScanAt: last, intervalSec: 3600 }))
      .toBe(last + 3_600_000);
  });

  it("rolls forward past missed ticks instead of showing a time in the past", () => {
    const last = at("2026-10-05T17:00:00Z");
    const now = last + 2.5 * 3_600_000;
    expect(nextTickAt({ serverless: false, now, lastScanAt: last, intervalSec: 3600 }))
      .toBe(last + 3 * 3_600_000);
  });

  it("is unknown on a long-lived server that has never scanned", () => {
    expect(nextTickAt({ serverless: false, now: at("2026-10-05T17:00:00Z"), lastScanAt: null, intervalSec: 60 }))
      .toBeNull();
  });
});
