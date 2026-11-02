import { describe, expect, it } from "vitest";
import { execPoolStandIn, nextRunIndex, packRun, registryInputs, RUN_ARCHIVE_DAYS, unpackRun, type PublishableRating } from "./publish";

const rating = (poolId: string, o: Partial<PublishableRating> = {}): PublishableRating => ({
  poolId,
  name: poolId,
  score: 75,
  grade: "B",
  eligibleForDeposit: true,
  reasonsHash: "ab".repeat(32),
  ...o,
});
const EXEC = "CEXECPOOL";

describe("exec pool stand-in", () => {
  it("takes the held pool's score, or 0 when Vigil marks it not eligible", () => {
    expect(execPoolStandIn([rating("HELD", { score: 57, grade: "C" })], "HELD", EXEC, 100n).input).toMatchObject({ pool: EXEC, score: 57, timestamp: 100n });
    const out = execPoolStandIn([rating("HELD", { score: 70, eligibleForDeposit: false })], "HELD", EXEC, 100n);
    expect(out.input?.score).toBe(0);
    expect(out.note).toMatch(/not eligible ⇒ 0/);
  });

  it("publishes nothing for an NR or unrated held pool, or without a position, so the gate refuses", () => {
    expect(execPoolStandIn([rating("HELD", { score: null, grade: "NR" })], "HELD", EXEC, 1n)).toMatchObject({ input: null, note: expect.stringMatching(/is NR/) });
    expect(execPoolStandIn([], "HELD", EXEC, 1n).note).toMatch(/is unrated/);
    expect(execPoolStandIn([rating("A")], null, EXEC, 1n).note).toMatch(/no position/);
  });
});

describe("registry inputs", () => {
  it("signs every rated pool at the engine's computedAt, skips NR, and appends the stand-in", () => {
    const standIn = { pool: EXEC, score: 75, timestamp: 9n, reasonsHash: "cd".repeat(32) };
    const inputs = registryInputs([rating("A"), rating("NR", { score: null, grade: "NR" }), rating("B", { score: 51 })], 9, standIn);
    expect(inputs.map((i) => [i.pool, i.score, i.timestamp])).toEqual([["A", 75, 9n], ["B", 51, 9n], [EXEC, 75, 9n]]);
  });
});

describe("run archive", () => {
  it("round-trips a run through gzip + base64", () => {
    const json = JSON.stringify({ computedAt: 1, ratings: [rating("A")], inputs: { A: { x: "y".repeat(5000) } } });
    const packed = packRun(json);
    expect(unpackRun(packed)).toBe(json);
    expect(packed.length).toBeLessThan(json.length / 4);
  });

  it("keeps 90 days, ascending and without duplicates, and says what fell out", () => {
    const now = 100 * 86_400;
    const old = now - RUN_ARCHIVE_DAYS * 86_400 - 1;
    expect(nextRunIndex([old, now - 3600], now - 1800, now)).toEqual({ index: [now - 3600, now - 1800], dropped: [old] });
    expect(nextRunIndex([now - 1800], now - 1800, now).index).toEqual([now - 1800]);
  });
});
