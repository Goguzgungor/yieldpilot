/**
 * The run directory: the single source of truth for a load-test run.
 * `events.jsonl` holds `step` records (sub-step checkpoints — what a resume
 * skips) and `event` records (final outcome per plan event). Everything else
 * (wallet state, finished set) is derived from it, so a crash can never leave
 * two files disagreeing.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PlanEvent } from "./schedule";

export type EventStatus = "ok" | "failed" | "skipped";

/** One completed sub-step of an event — the resume checkpoint. */
export interface StepRecord {
  type: "step";
  eventId: string;
  wallet?: number;
  step: string;
  at: number; // epoch ms
  hashes: string[];
  data?: Record<string, unknown>;
}

/** The final outcome of one plan event. */
export interface EventRecord {
  type: "event";
  eventId: string;
  kind: PlanEvent["kind"];
  wallet?: number;
  status: EventStatus;
  plannedAt: number;
  startedAt: number;
  finishedAt: number;
  hashes: string[];
  error?: string;
  data?: Record<string, unknown>;
}

export type ManifestRecord = StepRecord | EventRecord;

export interface RunFiles {
  dir: string;
  append(rec: ManifestRecord): void;
  read(): ManifestRecord[];
  writeJson(name: string, value: unknown): void;
  writeJsonl(name: string, rows: unknown[]): void;
  readJson<T>(name: string): T | null;
}

const EVENTS = "events.jsonl";

export function openRunDir(dir: string): RunFiles {
  mkdirSync(dir, { recursive: true });
  const file = (name: string) => join(dir, name);
  const ensureDir = (name: string) => mkdirSync(dirname(file(name)), { recursive: true });

  // A hard kill can leave a half-written last line. Cut it now, or the next
  // append would glue a valid record onto it and lose both.
  if (existsSync(file(EVENTS))) {
    const text = readFileSync(file(EVENTS), "utf8");
    if (text && !text.endsWith("\n")) writeFileSync(file(EVENTS), text.slice(0, text.lastIndexOf("\n") + 1));
  }

  return {
    dir,
    append(rec) {
      appendFileSync(file(EVENTS), JSON.stringify(rec) + "\n");
    },
    read() {
      if (!existsSync(file(EVENTS))) return [];
      return readFileSync(file(EVENTS), "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as ManifestRecord);
    },
    writeJson(name, value) {
      ensureDir(name);
      writeFileSync(file(name), JSON.stringify(value, null, 2) + "\n");
    },
    writeJsonl(name, rows) {
      ensureDir(name);
      writeFileSync(file(name), rows.map((r) => JSON.stringify(r) + "\n").join(""));
    },
    readJson<T>(name: string): T | null {
      return existsSync(file(name)) ? (JSON.parse(readFileSync(file(name), "utf8")) as T) : null;
    },
  };
}

/** Any event record (ok, failed or skipped) is final — a resume does not re-run it. */
export function finishedEventIds(recs: ManifestRecord[]): Set<string> {
  return new Set(recs.filter((r): r is EventRecord => r.type === "event").map((r) => r.eventId));
}

/** Last record per step name for one event (what a resumed event can skip). */
export function stepsFor(recs: ManifestRecord[], eventId: string): Map<string, StepRecord> {
  const out = new Map<string, StepRecord>();
  for (const r of recs) if (r.type === "step" && r.eventId === eventId) out.set(r.step, r);
  return out;
}

export interface WalletState {
  owner: string;
  smartWallet: string;
  poolRuleId: number;
  usdcRuleId: number;
  registered: boolean;
  trustline: boolean;
}

export function walletStates(recs: ManifestRecord[]): Map<number, WalletState> {
  const out = new Map<number, WalletState>();
  for (const r of recs) {
    if (r.wallet === undefined) continue;
    const s = out.get(r.wallet);
    if (r.type === "event" && r.kind === "onboard" && r.status === "ok" && r.data) {
      const d = r.data as { owner: string; smartWallet: string; poolRuleId: number; usdcRuleId: number };
      out.set(r.wallet, {
        owner: d.owner,
        smartWallet: d.smartWallet,
        poolRuleId: d.poolRuleId,
        usdcRuleId: d.usdcRuleId,
        registered: true,
        trustline: s?.trustline ?? false,
      });
    } else if (s && r.type === "event" && r.kind === "unregister" && r.status === "ok") {
      s.registered = false;
    } else if (s && r.type === "step" && r.step === "trustline") {
      s.trustline = true;
    }
  }
  return out;
}
