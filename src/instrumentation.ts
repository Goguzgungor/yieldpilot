/**
 * Next.js instrumentation hook. Runs once when the server process boots.
 *
 * Starts the continuous in-process agent loop ONLY on a long-lived server (local
 * `next dev` / `next start`). On Vercel (serverless) `startLocalLoop` is a no-op:
 * there is no persistent process to host a `setInterval`, so the daily Vercel
 * Cron (`/api/tick`) + the lazy first-load scan drive ticks instead.
 *
 * Guards: only the Node server runtime, never during `next build`, and never
 * when explicitly disabled (the escape hatch used by build/CI/tests so no RPC
 * calls happen).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return; // only the Node server runtime
  if (process.env.NEXT_PHASE === "phase-production-build") return; // never during build
  if (process.env.AGENT_LOOP_ENABLED === "0") return; // escape hatch for tests/build
  const { startLocalLoop } = await import("./lib/runtime");
  await startLocalLoop();
}
