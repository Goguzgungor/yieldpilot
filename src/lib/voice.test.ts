import { describe, it, expect } from "vitest";
import { agentStatus, usdc2, type ActivityRow } from "./voice";

const NOW = 1_800_000_000;
const row = (kind: string, ageSec: number, meta: object | null = null, message = ""): ActivityRow =>
  ({ ts: NOW - ageSec, kind, message, meta: meta ? JSON.stringify(meta) : null });

const base = {
  nowSec: NOW, offline: false, coldStart: false,
  rationale: "Fixed offers the highest APY among eligible pools (8.42%) at risk 45.",
  poolCount: 9, protocols: ["blend", "defindex"],
};

describe("agentStatus", () => {
  it("reports offline before anything else", () => {
    const s = agentStatus({ ...base, offline: true, activity: [row("scan", 1)] });
    expect(s.state).toBe("OFFLINE");
    expect(s.voice).toMatch(/funds are not affected/);
  });

  it("reports the first survey on a cold start", () => {
    const s = agentStatus({ ...base, coldStart: true, activity: [] });
    expect(s.state).toBe("SURVEYING");
  });

  it("reports a supply that just landed, with its amount and tx", () => {
    const s = agentStatus({ ...base, activity: [row("peruser", 5, { hashes: ["abc123"], amount: "2500000000" })] });
    expect(s.state).toBe("SUPPLYING");
    expect(s.voice).toContain("250.00");
    expect(s.hash).toBe("abc123");
  });

  it("reports a scan in progress in words", () => {
    const s = agentStatus({ ...base, activity: [row("scan", 3)] });
    expect(s.state).toBe("SCANNING");
    expect(s.voice).toBe("Reading 9 mainnet pools across Blend and DeFindex.");
  });

  it("falls back to the decision's rationale once the moment has passed", () => {
    const s = agentStatus({ ...base, activity: [row("peruser", 600, { hashes: ["abc"] })] });
    expect(s.state).toBe("HOLDING");
    expect(s.voice).toBe(base.rationale);
  });

  it("ignores per-user rows that moved no money", () => {
    const s = agentStatus({ ...base, activity: [row("peruser", 2, null, "skip G… — no idle USDC")] });
    expect(s.state).toBe("HOLDING");
  });

  it("describes what it watches when there is no decision yet", () => {
    const s = agentStatus({ ...base, rationale: null, activity: [] });
    expect(s.voice).toBe("Watching 9 mainnet pools across Blend and DeFindex.");
  });
});

describe("usdc2", () => {
  it("formats stroops with two decimals and grouping", () => {
    expect(usdc2("12500000000")).toBe("1,250.00");
    expect(usdc2("15")).toBe("0.00");
    expect(usdc2(null)).toBe("0.00");
    expect(usdc2("12345678")).toBe("1.23");
  });
});
