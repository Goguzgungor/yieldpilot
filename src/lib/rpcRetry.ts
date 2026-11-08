/**
 * Retries for the scan's mainnet reads. The public Soroban RPC answers HTTP 429
 * once a burst passes its limit (about 38 pool loads in 10 s, measured
 * 2026-11-08) and recovers within ~16 s; before this, scanSource swallowed the
 * error and the pool silently fell off the homepage.
 */

/** A read that fails the same way every time (no such reserve, a contract error): never retried. */
export class PermanentReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentReadError";
  }
}

const TRANSIENT_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "ECONNABORTED", "EAI_AGAIN", "EPIPE", "UND_ERR_SOCKET"]);

/** True for a rate limit, a 5xx or a dropped connection; anything else is treated as permanent. */
export function isTransientRpcError(e: unknown): boolean {
  if (e instanceof PermanentReadError) return false;
  const err = e as { message?: unknown; code?: unknown; response?: { status?: unknown } } | null;
  const status = err?.response?.status;
  if (typeof status === "number") return status === 429 || status >= 500;
  if (typeof err?.code === "string" && TRANSIENT_CODES.has(err.code)) return true;
  const msg = typeof err?.message === "string" ? err.message : String(e);
  if (/HostError/.test(msg)) return false;
  const coded = msg.match(/status code (\d{3})/);
  if (coded) return coded[1] === "429" || coded[1].startsWith("5");
  return /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|timeout|fetch failed|network error/i.test(msg);
}

export interface RetryOptions {
  /** Wait before each retry; its length is the number of retries. */
  delaysMs: number[];
  sleep?: (ms: number) => Promise<void>;
  /** Shared across calls so one scan's total waiting stays bounded. */
  budget?: { remainingMs: number };
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Run `fn`, retrying transient RPC failures after each delay in turn. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const sleep = opts.sleep ?? realSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const wait = opts.delaysMs[attempt];
      if (wait === undefined || !isTransientRpcError(e)) throw e;
      if (opts.budget) {
        if (opts.budget.remainingMs < wait) throw e;
        opts.budget.remainingMs -= wait;
      }
      await sleep(wait);
    }
  }
}
