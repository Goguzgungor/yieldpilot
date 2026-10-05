import type { PlanEvent } from "./schedule";

/** "1" → 1 (real time), "1/96" → 24 h squeezed into 15 min (smoke runs). */
export function parseScale(s: string): number {
  const [a, b] = s.split("/");
  const v = b === undefined ? Number(a) : Number(a) / Number(b);
  if (!Number.isFinite(v) || v <= 0) throw new Error(`--scale must be a positive number or fraction, got "${s}"`);
  return v;
}

export function dueAt(startedAt: number, atMin: number, timeScale: number): number {
  return startedAt + Math.round(atMin * 60_000 * timeScale);
}

export interface DriverOpts {
  events: PlanEvent[];
  startedAt: number;
  timeScale: number;
  finished: Set<string>;
  now(): number;
  sleep(ms: number): Promise<void>;
  exec(ev: PlanEvent, plannedAt: number): Promise<void>;
  log(msg: string): void;
}

/**
 * Walk the plan in order, one event at a time. Strictly serial on purpose: the
 * load-test agent pays every authorize + supply and the faucet admin signs every
 * mint, so two in-flight txs from either collide on the account sequence number
 * (tx_bad_seq). A long tick therefore delays later events instead of
 * overlapping them; the plannedAt/startedAt gap in events.jsonl records the lag.
 */
export async function runPlan(o: DriverOpts): Promise<number> {
  let ran = 0;
  for (const ev of o.events) {
    if (o.finished.has(ev.id)) continue;
    const due = dueAt(o.startedAt, ev.atMin, o.timeScale);
    const wait = due - o.now();
    if (wait > 0) {
      o.log(`waiting ${Math.round(wait / 1000)} s for ${ev.id}`);
      await o.sleep(wait);
    }
    o.log(`→ ${ev.id}`);
    await o.exec(ev, due);
    ran++;
  }
  return ran;
}
