/**
 * Which Mongo db is the SERVER using? Nothing else tells us: preflight and the
 * driver only see their own shell's MONGODB_DB. A server left on the smoke db,
 * or started without MONGODB_DB (→ production "yieldseeker"), would otherwise
 * pass every check while the run writes somewhere else.
 */
import type { YsApi } from "./api";

/** Write a nonce row from this shell, then require the server's activity feed to show it. */
export async function probeServerDb(
  api: Pick<YsApi, "get">,
  writeRow: (message: string) => Promise<void>,
  nonce: string,
): Promise<true | string> {
  try {
    await writeRow(`db probe ${nonce}`);
  } catch (e) {
    return `cannot write to this shell's db: ${(e as Error).message}`;
  }
  let rows: unknown;
  try {
    rows = await api.get("/api/activity");
  } catch (e) {
    return `server activity feed unavailable: ${(e as Error).message}`;
  }
  const seen = Array.isArray(rows) && rows.some((r) => typeof r?.message === "string" && r.message.includes(nonce));
  return seen ? true : "server does not see this shell's db — it runs with a different MONGODB_DB/MONGODB_URI";
}

/** A new run needs an empty registry, or the agent also supplies for leftover (e.g. smoke) users. */
export function registryEmptyProblem(usersResponse: unknown): string | null {
  const users = (usersResponse as { users?: unknown })?.users;
  if (!Array.isArray(users)) return `unexpected /api/users answer: ${JSON.stringify(usersResponse)}`;
  return users.length ? `server registry already has ${users.length} user(s) — use a fresh MONGODB_DB` : null;
}

/** The export must read the activity log from the db the run wrote to. */
export function exportDbProblem(recorded: string | undefined, uriSet: boolean, current: string): string | null {
  if (!uriSet) return "MONGODB_URI is not set — source .env.loadtest (the activity log would silently be empty)";
  if (!recorded) return "run.json has no mongoDb — cannot tell which db the run wrote to";
  if (recorded !== current) return `this shell reads db '${current}' but the run wrote to '${recorded}' — set MONGODB_DB=${recorded}`;
  return null;
}
