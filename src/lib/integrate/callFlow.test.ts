import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { checkOrder, checkRating, flowFor, liveCodeFor, outcomeFor, type OnchainRating } from "./callFlow";
import { snippetFor } from "./brief";
import { snippet } from "./snippets";
import type { PathId, Where } from "./facts";

const now = 1_794_145_000;
const rating = (score: number, ageSecs = 60 * 41): OnchainRating => ({ score, publishers: 1, timestamp: now - ageSecs });
const opts = (path: PathId = "registry") => ({ path, minScore: 60, maxAgeSecs: 7200, nowSecs: now });

describe("checkRating", () => {
  it("passes a fresh rating at or above the minimum", () => {
    const c = checkRating(rating(76), opts());
    expect(c).toMatchObject({ allowed: true, code: null, failed: null });
    expect(c.checks.map((x) => [x.id, x.state, x.note])).toEqual([
      ["exists", "pass", "Some(Rating)"],
      ["fresh", "pass", "41 min old, within 2 h"],
      ["min", "pass", "76 ≥ 60"],
    ]);
  });

  it("refuses None with 4114 and does not reach the other checks", () => {
    const c = checkRating(null, opts());
    expect(c).toMatchObject({ allowed: false, code: 4114, failed: "exists" });
    expect(c.checks.map((x) => x.state)).toEqual(["fail", "skipped", "skipped"]);
  });

  it("refuses a score under the minimum with 4115, and says why a 0 is a 0", () => {
    expect(checkRating(rating(58), opts())).toMatchObject({ allowed: false, code: 4115, failed: "min" });
    expect(checkRating(rating(0), opts()).checks[2].note).toMatch(/^0 < 60 \(Vigil holds this pool back/);
  });

  it("refuses a stale rating with 4116", () => {
    const c = checkRating(rating(76, 3 * 3600), opts());
    expect(c).toMatchObject({ allowed: false, code: 4116, failed: "fresh" });
    expect(c.checks[1].note).toBe("3 h old, over 2 h");
  });

  it("tolerates a ledger a little ahead of the visitor's clock, not a lot", () => {
    expect(checkRating(rating(76, -120), opts()).allowed).toBe(true);
    expect(checkRating(rating(76, -900), opts())).toMatchObject({ allowed: false, code: 4116 });
  });

  it("runs RiskGate's order: the score before freshness", () => {
    expect(checkOrder("riskgate")).toEqual(["exists", "min", "fresh"]);
    expect(checkOrder("registry")).toEqual(["exists", "fresh", "min"]);
    // stale AND low: the order decides the code, as on-chain
    const staleLow = rating(10, 3 * 3600);
    expect(checkRating(staleLow, opts("riskgate")).code).toBe(4115);
    expect(checkRating(staleLow, opts("registry")).code).toBe(4116);
  });
});

describe("flowFor / outcomeFor", () => {
  it("has no on-chain flow for the ratings API", () => {
    expect(flowFor("api", "backend")).toBeNull();
    expect(liveCodeFor("api", "backend")).toBeNull();
  });

  it("ends every on-chain flow at the registry's get_rating", () => {
    for (const [p, w] of [["registry", "backend"], ["registry", "contract"], ["riskgate", "backend"]] as const) {
      expect(flowFor(p, w)!.nodes[2]).toEqual({ title: "RiskRegistry · testnet", sub: "get_rating(pool)" });
    }
    expect(flowFor("registry", "backend")!.nodes[1].sub).toBe("simulateTransaction");
    expect(flowFor("riskgate", "backend")!.nodes[1].sub).toBe("RiskGate enforce()");
  });

  it("names the error each path's code raises", () => {
    const low = checkRating(rating(58), opts());
    expect(outcomeFor("registry", "contract", low)).toContain("RiskError::ScoreTooLow");
    expect(outcomeFor("registry", "backend", low)).toContain('reason: "score below the minimum (4115)"');
    expect(outcomeFor("riskgate", "backend", checkRating(rating(58), opts("riskgate")))).toContain("Error(Contract, #4115) ScoreTooLow");
  });
});

describe("liveCodeFor", () => {
  // Every line shown next to the live call must be real: in the brief's snippet for
  // the same path, or in the RiskGate contract. Callers' lines and comments are exempt.
  const guardSrc = readFileSync("contracts/vigil-guard/src/lib.rs", "utf8");
  const sourceFor = (p: PathId, w: Where) =>
    p === "riskgate" ? guardSrc : snippet(snippetFor(p, w), { minScore: 60, maxAgeSecs: 7200 }).code;
  const norm = (l: string) => l.replace(/\s+\/\/ .*$/, "").trim();

  for (const [p, w] of [["registry", "backend"], ["registry", "contract"], ["riskgate", "backend"]] as const) {
    it(`${p}/${w}: every line comes from the source`, () => {
      const src = sourceFor(p, w).split("\n").map(norm);
      const code = liveCodeFor(p, w)!;
      for (const l of code.lines) {
        const t = norm(l.text);
        if (l.caller || t === "" || t.startsWith("//")) continue;
        expect(src, `${p}/${w}: ${t}`).toContain(t);
      }
    });

    it(`${p}/${w}: marks each check once and lights all three nodes`, () => {
      const code = liveCodeFor(p, w)!;
      const checks = code.lines.filter((l) => l.check).map((l) => l.check);
      expect([...checks].sort()).toEqual(["exists", "fresh", "min"]);
      expect(checks).toEqual(checkOrder(p));
      expect(new Set(code.lines.map((l) => l.step).filter(Boolean))).toEqual(new Set([1, 2, 3]));
    });
  }
});
