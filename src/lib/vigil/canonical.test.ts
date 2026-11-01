import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Canonical } from "./canonical";

describe("canonicalJson", () => {
  it("sorts object keys recursively and drops undefined members", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 }, z: undefined })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("is independent of key insertion order", () => {
    expect(canonicalJson({ x: 1, y: [1, 2] })).toBe(canonicalJson({ y: [1, 2], x: 1 }));
  });

  it("rounds non-integers to 6 dp, keeps integers, maps non-finite to null", () => {
    expect(canonicalJson([0.1 + 0.2, 1 / 3, 42, -0.0000001, NaN, Infinity])).toBe("[0.3,0.333333,42,0,null,null]");
  });

  it("encodes bigint as a decimal string and undefined array items as null", () => {
    expect(canonicalJson([10n ** 20n, undefined, null, true, "s"])).toBe('["100000000000000000000",null,null,true,"s"]');
  });
});

describe("sha256Canonical", () => {
  it("returns 64 hex chars and matches a known vector", () => {
    // sha256('{"a":1}')
    expect(sha256Canonical({ a: 1 })).toBe("015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862");
  });

  it("changes when any value changes, not when key order changes", () => {
    const h = sha256Canonical({ a: 1, b: [1, 2, 3] });
    expect(sha256Canonical({ b: [1, 2, 3], a: 1 })).toBe(h);
    expect(sha256Canonical({ a: 1, b: [1, 2, 4] })).not.toBe(h);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});
