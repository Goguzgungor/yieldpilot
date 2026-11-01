/**
 * CLIENT-SAFE wallet detection.
 *
 * Varial (formerly Freighter) answers `isConnected` through its Manifest V3
 * background worker: the content script forwards every request with
 * `runtime.sendMessage`. freighter-api gives that request a fixed 2 s timeout
 * and reports a timeout as `{ isConnected: false }`, exactly like a missing
 * extension. A worker that is waking up, or still initialising after an
 * extension update, can miss that window once, so a single unanswered probe is
 * not proof that the wallet is absent.
 */
export async function probeWallet(
  isConnected: () => Promise<{ isConnected?: boolean } | undefined>,
  opts: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const attempts = opts.attempts ?? 3;
  const delayMs = opts.delayMs ?? 1000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; i < attempts; i++) {
    try {
      if ((await isConnected())?.isConnected) return true;
    } catch {
      // treat like an unanswered probe
    }
    if (i < attempts - 1) await sleep(delayMs * (i + 1));
  }
  return false;
}
