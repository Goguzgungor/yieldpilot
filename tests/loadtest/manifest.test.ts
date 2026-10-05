import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  finishedEventIds,
  openRunDir,
  stepsFor,
  walletStates,
  type EventRecord,
  type StepRecord,
} from "../../scripts/loadtest/manifest";

const tmp = () => mkdtempSync(join(tmpdir(), "ys-lt-"));
const ev = (p: Partial<EventRecord> & Pick<EventRecord, "eventId" | "kind" | "status">): EventRecord => ({
  type: "event", plannedAt: 0, startedAt: 0, finishedAt: 0, hashes: [], ...p,
});
const st = (p: Partial<StepRecord> & Pick<StepRecord, "eventId" | "step">): StepRecord => ({
  type: "step", at: 0, hashes: [], ...p,
});

describe("openRunDir", () => {
  it("round-trips records, json and jsonl files", () => {
    const dir = tmp();
    const f = openRunDir(dir);
    f.append(st({ eventId: "onboard:w00", step: "deploy", hashes: ["h1"] }));
    f.append(ev({ eventId: "tick:0010", kind: "tick", status: "ok" }));
    expect(f.read().map((r) => r.type)).toEqual(["step", "event"]);
    f.writeJson("snapshots/x.json", { a: 1 });
    expect(f.readJson("snapshots/x.json")).toEqual({ a: 1 });
    expect(f.readJson("missing.json")).toBeNull();
    f.writeJsonl("chain/t.jsonl", [{ h: 1 }, { h: 2 }]);
    expect(readFileSync(join(dir, "chain/t.jsonl"), "utf8")).toBe('{"h":1}\n{"h":2}\n');
  });

  it("drops a torn last line left by a hard kill and keeps appending cleanly", () => {
    const dir = tmp();
    openRunDir(dir).append(ev({ eventId: "tick:0010", kind: "tick", status: "ok" }));
    const path = join(dir, "events.jsonl");
    writeFileSync(path, readFileSync(path, "utf8") + '{"type":"ev');
    const g = openRunDir(dir);
    g.append(ev({ eventId: "tick:0030", kind: "tick", status: "ok" }));
    expect(g.read().map((r) => r.eventId)).toEqual(["tick:0010", "tick:0030"]);
  });
});

describe("derived state", () => {
  const recs = [
    st({ eventId: "onboard:w03", wallet: 3, step: "deploy", hashes: ["d"], data: { smartWallet: "CSA" } }),
    ev({ eventId: "onboard:w03", kind: "onboard", wallet: 3, status: "ok", data: { owner: "GOWN", smartWallet: "CSA", poolRuleId: 1, usdcRuleId: 2 } }),
    ev({ eventId: "onboard:w04", kind: "onboard", wallet: 4, status: "failed", error: "x" }),
    st({ eventId: "topup:w03:1", wallet: 3, step: "trustline", hashes: ["t"] }),
    ev({ eventId: "unregister:w03", kind: "unregister", wallet: 3, status: "ok" }),
  ];

  it("treats ok/failed/skipped events as finished, steps as not", () => {
    expect([...finishedEventIds(recs)].sort()).toEqual(["onboard:w03", "onboard:w04", "unregister:w03"]);
  });
  it("indexes the last record per step of an event", () => {
    expect(stepsFor(recs, "onboard:w03").get("deploy")?.data).toEqual({ smartWallet: "CSA" });
  });
  it("tracks onboarded wallets, trustlines and unregistration", () => {
    const s = walletStates(recs);
    expect(s.has(4)).toBe(false);
    expect(s.get(3)).toEqual({ owner: "GOWN", smartWallet: "CSA", poolRuleId: 1, usdcRuleId: 2, registered: false, trustline: true });
  });
});
