// When the agent's next tick is due, so the UI can say "next tick in 14 h"
// instead of implying it runs continuously. Pure: no env, no clock.

/**
 * - serverless (Vercel): the daily Cron in vercel.json, "0 0 * * *" → 00:00 UTC.
 *   Keep this in sync with that schedule.
 * - long-lived server (`next dev` / `next start`): one SCAN_INTERVAL_SEC after
 *   the last scan, rolled forward if ticks were missed.
 *
 * Returns epoch-ms, or null when there is nothing to anchor on yet.
 */
export function nextTickAt(o: {
  serverless: boolean;
  now: number;
  lastScanAt: number | null;
  intervalSec: number;
}): number | null {
  if (o.serverless) {
    const d = new Date(o.now);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  }
  if (o.lastScanAt == null) return null;
  const step = o.intervalSec * 1000;
  const due = o.lastScanAt + step;
  if (due > o.now) return due;
  const missed = Math.floor((o.now - o.lastScanAt) / step);
  return o.lastScanAt + (missed + 1) * step;
}
