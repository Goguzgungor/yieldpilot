import { MongoClient, type Db as MongoNativeDb, type Document } from "mongodb";

/**
 * Serverless-safe MongoDB connection.
 *
 * On Vercel each request may run in a fresh (or reused/warm) function instance,
 * so we cache the connect() PROMISE on `globalThis` — every module instance in a
 * warm sandbox reuses the same connection instead of opening a new client per
 * call (which would exhaust the Atlas connection limit). The promise (not the
 * resolved client) is cached so concurrent first-calls don't race to connect.
 *
 * This replaces the old better-sqlite3 file DB, which cannot work on Vercel
 * (read-only filesystem + no shared state across invocations).
 */

/**
 * Database name inside the cluster. Production uses the default; MONGODB_DB lets
 * an isolated run (the on-chain load test) keep its users, positions and activity
 * log out of the live registry. Read at call time, like MONGODB_URI.
 */
export function mongoDbName(env: Record<string, string | undefined> = process.env): string {
  const v = env.MONGODB_DB?.trim();
  return v ? v : "yieldseeker";
}

interface MongoCache {
  promise: Promise<MongoNativeDb> | null;
}

function cache(): MongoCache {
  const g = globalThis as unknown as { __ysMongo?: MongoCache };
  return (g.__ysMongo ??= { promise: null });
}

/** Connect (once) and return the shared `yieldseeker` database handle. */
export function getMongoDb(): Promise<MongoNativeDb> {
  const c = cache();
  if (!c.promise) {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      throw new Error(
        "MONGODB_URI is not set — the agent needs a MongoDB connection string to persist state.",
      );
    }
    c.promise = (async () => {
      const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 });
      await client.connect();
      return client.db(mongoDbName());
    })();
    // If the first connect fails, drop the cached (rejected) promise so a later
    // call can retry instead of being stuck with a permanently-rejected handle.
    c.promise.catch(() => {
      c.promise = null;
    });
  }
  return c.promise;
}

/** Convenience: resolve one typed collection from the shared db. */
export async function getCollection<T extends Document = Document>(name: string) {
  const db = await getMongoDb();
  return db.collection<T>(name);
}
