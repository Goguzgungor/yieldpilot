import { createHash } from "node:crypto";

/**
 * Canonical JSON used for `reasonsHash` (published on-chain as BytesN<32>).
 *
 * Rules (so any implementation can reproduce the hash byte-for-byte):
 *   - object keys sorted by UTF-16 code unit order (JS default sort), no whitespace;
 *   - `undefined` object members are dropped; `undefined` array items become null;
 *   - bigint → decimal string;
 *   - finite non-integer numbers are rounded to 6 decimal places (then printed by
 *     JSON.stringify), integers are printed as-is; NaN/±Infinity → null;
 *   - strings / booleans / null as JSON.
 */
export function canonicalJson(value: unknown): string {
  return encode(value);
}

function encode(v: unknown): string {
  if (v === null || v === undefined) return "null";
  switch (typeof v) {
    case "boolean":
      return v ? "true" : "false";
    case "string":
      return JSON.stringify(v);
    case "bigint":
      return JSON.stringify(v.toString());
    case "number":
      return encodeNumber(v);
    case "object": {
      if (Array.isArray(v)) return "[" + v.map((x) => encode(x)).join(",") + "]";
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return "{" + keys.map((k) => JSON.stringify(k) + ":" + encode(obj[k])).join(",") + "}";
    }
    default:
      return "null";
  }
}

function encodeNumber(n: number): string {
  if (!Number.isFinite(n)) return "null";
  if (Number.isInteger(n)) return JSON.stringify(n);
  const r = Math.round(n * 1e6) / 1e6;
  return JSON.stringify(Object.is(r, -0) ? 0 : r);
}

/** sha256 hex (64 chars) of the canonical JSON encoding of `value`. */
export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
