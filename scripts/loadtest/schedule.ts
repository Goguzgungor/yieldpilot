/**
 * Deterministic 24 h load-test plan: which wallet does what, when.
 *
 * Pure (seeded PRNG, no clock, no network) so a run is reproducible and the
 * later on-chain analysis can compare what was intended (plan.json) with what
 * landed (events.jsonl + the chain export).
 */

export type Cohort = "steady" | "drip" | "whale" | "churn" | "dust";

export type PlanEvent =
  | { id: string; atMin: number; kind: "onboard"; wallet: number; fundUsdc: number }
  | { id: string; atMin: number; kind: "topup"; wallet: number; usdc: number; via: "faucet" | "transfer" }
  | { id: string; atMin: number; kind: "unregister"; wallet: number }
  | { id: string; atMin: number; kind: "tick" }
  | { id: string; atMin: number; kind: "snapshot" };

export interface Plan {
  seed: number;
  wallets: Array<{ index: number; cohort: Cohort }>;
  events: PlanEvent[];
}

export const WALLET_COUNT = 97;
export const RUN_MIN = 1440;
export const COHORT_ORDER: Cohort[] = ["steady", "drip", "whale", "churn", "dust"];
export const COHORT_SIZES: Record<Cohort, number> = { steady: 40, drip: 25, whale: 12, churn: 10, dust: 10 };

/** First hour = back-to-back onboarding burst (25 of 97 wallets). */
const BURST_END_MIN = 60;
const BURST_SHARE = 25 / 97;
/** Last arrival at T+20h so even late wallets see ≥ 12 agent ticks. */
const LAST_ARRIVAL_MIN = 1200;
/** User actions stop at T+23h20m so at least two ticks observe each one. */
const LAST_ACTION_MIN = 1400;
const TICK_FIRST_MIN = 10;
const TICK_EVERY_MIN = 20;
const SNAPSHOT_EVERY_MIN = 120;

const KIND_ORDER: Record<PlanEvent["kind"], number> = { onboard: 0, topup: 1, unregister: 2, tick: 3, snapshot: 4 };

/** Small seeded PRNG (mulberry32) — Math.random would make plans unreproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function assignCohorts(count: number): Cohort[] {
  if (count === WALLET_COUNT) return COHORT_ORDER.flatMap((c) => Array<Cohort>(COHORT_SIZES[c]).fill(c));
  // Smoke runs: one wallet per cohort first, so a 5-wallet run covers every behaviour.
  return Array.from({ length: count }, (_, i) => COHORT_ORDER[i % COHORT_ORDER.length]);
}

const w = (i: number) => `w${String(i).padStart(2, "0")}`;
const m = (min: number) => String(min).padStart(4, "0");

export function buildPlan(opts: { walletCount: number; seed: number }): Plan {
  const rand = mulberry32(opts.seed);
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  function pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(rand() * xs.length)];
  }

  const cohorts = assignCohorts(opts.walletCount);
  // Fisher–Yates: arrival order is independent of the cohort index ranges.
  const order = cohorts.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const burst = Math.round(opts.walletCount * BURST_SHARE);
  const arrival = new Array<number>(opts.walletCount);
  order.forEach((idx, pos) => {
    arrival[idx] = pos < burst ? int(0, BURST_END_MIN - 1) : int(BURST_END_MIN, LAST_ARRIVAL_MIN);
  });

  const events: PlanEvent[] = [];
  const onboard = (i: number, fundUsdc: number) =>
    events.push({ id: `onboard:${w(i)}`, atMin: arrival[i], kind: "onboard", wallet: i, fundUsdc });

  cohorts.forEach((cohort, i) => {
    const at = arrival[i];
    switch (cohort) {
      case "steady":
        onboard(i, pick([100, 250, 500, 1000, 2000]));
        break;
      case "drip": {
        onboard(i, pick([100, 250, 500]));
        const times = Array.from({ length: int(2, 4) }, () => int(at + 30, LAST_ACTION_MIN)).sort((a, b) => a - b);
        times.forEach((t, k) =>
          events.push({ id: `topup:${w(i)}:${k + 1}`, atMin: t, kind: "topup", wallet: i, usdc: pick([50, 100, 250]), via: "transfer" }),
        );
        break;
      }
      case "whale":
        onboard(i, 5000);
        events.push({
          id: `topup:${w(i)}:1`,
          atMin: int(at + 120, Math.min(at + 240, LAST_ACTION_MIN)),
          kind: "topup",
          wallet: i,
          usdc: 3000,
          via: "faucet",
        });
        break;
      case "churn": {
        onboard(i, pick([250, 500, 1000]));
        const off = int(at + 90, Math.min(at + 240, LAST_ACTION_MIN - 20));
        events.push({ id: `unregister:${w(i)}`, atMin: off, kind: "unregister", wallet: i });
        // Funds arriving after unregister must stay idle — the agent may act only on registered users.
        events.push({ id: `topup:${w(i)}:1`, atMin: off + 30, kind: "topup", wallet: i, usdc: 500, via: "faucet" });
        break;
      }
      case "dust":
        onboard(i, 1);
        break;
    }
  });

  for (let t = TICK_FIRST_MIN; t < RUN_MIN; t += TICK_EVERY_MIN) events.push({ id: `tick:${m(t)}`, atMin: t, kind: "tick" });
  for (let t = 0; t <= RUN_MIN; t += SNAPSHOT_EVERY_MIN) events.push({ id: `snapshot:${m(t)}`, atMin: t, kind: "snapshot" });
  events.sort((a, b) => a.atMin - b.atMin || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.id.localeCompare(b.id));

  return { seed: opts.seed, wallets: cohorts.map((cohort, index) => ({ index, cohort })), events };
}
