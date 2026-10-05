import { describe, expect, it } from "vitest";
import { dueAt, parseScale, runPlan } from "../../scripts/loadtest/driver";
import type { PlanEvent } from "../../scripts/loadtest/schedule";

const evs: PlanEvent[] = [
  { id: "snapshot:0000", atMin: 0, kind: "snapshot" },
  { id: "onboard:w00", atMin: 5, kind: "onboard", wallet: 0, fundUsdc: 1 },
  { id: "tick:0010", atMin: 10, kind: "tick" },
];

function clock(start: number) {
  let t = start;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    advance: (ms: number) => (t += ms),
    slept,
  };
}

describe("driver", () => {
  it("parseScale accepts decimals and fractions", () => {
    expect(parseScale("1")).toBe(1);
    expect(parseScale("1/96")).toBeCloseTo(1 / 96);
    expect(() => parseScale("0")).toThrow(/positive/);
    expect(() => parseScale("x")).toThrow(/positive/);
  });

  it("dueAt maps plan minutes to wall time", () => {
    expect(dueAt(1000, 10, 1)).toBe(601_000);
    expect(dueAt(1000, 1440, 1 / 96)).toBe(901_000);
  });

  it("runs events in order, sleeping until each is due", async () => {
    const c = clock(0);
    const ran: Array<[string, number, number]> = [];
    const n = await runPlan({
      events: evs, startedAt: 0, timeScale: 1, finished: new Set(), now: c.now, sleep: c.sleep, log: () => {},
      exec: async (ev, plannedAt) => void ran.push([ev.id, plannedAt, c.now()]),
    });
    expect(n).toBe(3);
    expect(ran).toEqual([["snapshot:0000", 0, 0], ["onboard:w00", 300_000, 300_000], ["tick:0010", 600_000, 600_000]]);
  });

  it("on resume skips finished events and runs overdue ones immediately", async () => {
    const c = clock(700_000);
    const ran: string[] = [];
    await runPlan({
      events: evs, startedAt: 0, timeScale: 1, finished: new Set(["snapshot:0000"]), now: c.now, sleep: c.sleep, log: () => {},
      exec: async (ev) => void ran.push(ev.id),
    });
    expect(ran).toEqual(["onboard:w00", "tick:0010"]);
    expect(c.slept).toEqual([]);
  });

  it("a slow event delays the next one instead of overlapping it", async () => {
    const c = clock(0);
    const starts: number[] = [];
    await runPlan({
      events: evs, startedAt: 0, timeScale: 1, finished: new Set(), now: c.now, sleep: c.sleep, log: () => {},
      exec: async () => {
        starts.push(c.now());
        c.advance(400_000);
      },
    });
    expect(starts).toEqual([0, 400_000, 800_000]);
  });
});
