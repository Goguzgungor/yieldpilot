/**
 * Minimal JSON over node:http(s).
 *
 * Deliberately not global fetch: undici's default 300 s headers timeout would
 * abort /api/tick, which supplies every registered user serially and can run
 * for many minutes — and a client-side abort followed by a retry would start a
 * second tick on the same agent key. `timeoutMs: 0` disables the timeout.
 * Network errors resolve to status 0 (like useOnboarding's helpers) plus the
 * error code, so the caller can tell "server down" (ECONNREFUSED — the request
 * never arrived, waiting is always safe) from a reset or timeout (the server may
 * still be working on it).
 */
import http from "node:http";
import https from "node:https";

export interface JsonResponse<T = unknown> {
  status: number;
  data: T | null;
  /** Only on status 0: ECONNREFUSED, ECONNRESET, ETIMEDOUT (our timeout), … */
  code?: string;
}

/** Node reports a failed dual-stack connect as an AggregateError; its code sits on the parts. */
function errorCode(e: unknown): string {
  const err = e as { code?: string; errors?: Array<{ code?: string }> };
  return err.code ?? err.errors?.find((x) => x.code)?.code ?? "EUNKNOWN";
}

export function requestJson<T = unknown>(
  method: "GET" | "POST" | "DELETE",
  url: string,
  body?: unknown,
  timeoutMs = 120_000,
): Promise<JsonResponse<T>> {
  return new Promise((resolve) => {
    const u = new URL(url);
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = (u.protocol === "https:" ? https : http).request(
      u,
      {
        method,
        headers: payload ? { "content-type": "application/json", "content-length": payload.length } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let data: T | null = null;
          try {
            data = text ? (JSON.parse(text) as T) : null;
          } catch {
            data = null;
          }
          resolve({ status: res.statusCode ?? 0, data });
        });
        res.on("error", (e) => resolve({ status: 0, data: null, code: errorCode(e) }));
      },
    );
    if (timeoutMs > 0) req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    req.on("error", (e) => resolve({ status: 0, data: null, code: errorCode(e) }));
    if (payload) req.write(payload);
    req.end();
  });
}
