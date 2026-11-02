import { timingSafeEqual } from "node:crypto";

/**
 * True when the request carries `key` as `Authorization: Bearer <key>` or
 * `?key=<key>`, compared in constant time. Used by the routes an outside
 * scheduler or an operator calls (/api/cron/publish, /api/reset).
 */
export function requestHasKey(req: Request, key: string): boolean {
  const given =
    req.headers.get("authorization")?.replace(/^Bearer /, "") ?? new URL(req.url).searchParams.get("key") ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}
