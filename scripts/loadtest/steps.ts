/**
 * One function per plan-event kind. Each sub-step that lands on-chain is
 * checkpointed (a `step` record) the moment it succeeds, so a resumed run picks
 * up exactly where a crash left it — never a second deploy, authorize or mint.
 */
import type { Keypair } from "@stellar/stellar-sdk";
import { ApiError, type YsApi } from "./api";
import type { ChainOps } from "./chain";
import { stepsFor, walletStates, type EventRecord, type RunFiles, type StepRecord } from "./manifest";
import type { PlanEvent } from "./schedule";

export const STROOPS_PER_USDC = 10_000_000n;

export interface StepCtx {
  api: YsApi;
  chain: ChainOps;
  files: RunFiles;
  wallet(index: number): Keypair;
  now(): number;
  sleep(ms: number): Promise<void>;
  /**
   * attempts / baseDelayMs: real failures back off ×3 (5 s → 15 s by default).
   * outageWaitMs / maxOutageWaits: a refused connection (server down — the
   * request never arrived) is waited out without burning attempts, so a server
   * restart mid-run costs time, not events. run.ts waits indefinitely. A reset or
   * client timeout is NOT an outage: the server may still be processing the
   * request, so it counts as an ordinary attempt.
   */
  retry: { attempts: number; baseDelayMs: number; outageWaitMs: number; maxOutageWaits: number };
  log(msg: string): void;
}

type Result = { hashes: string[]; data?: Record<string, unknown> };
type Ev<K extends PlanEvent["kind"]> = Extract<PlanEvent, { kind: K }>;

/** Thrown when an event cannot apply (its wallet never onboarded) — recorded as "skipped". */
class SkipEvent extends Error {}

async function withRetry<T>(ctx: StepCtx, label: string, fn: () => Promise<T>): Promise<T> {
  let failures = 0;
  let outages = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ApiError && e.code === "ECONNREFUSED" && outages < ctx.retry.maxOutageWaits) {
        // Log the first wait and then every 10th, so a long outage stays visible but quiet.
        if (outages % 10 === 0) ctx.log(`${label}: server down (connection refused), waiting — ${outages} wait(s) so far`);
        outages++;
        await ctx.sleep(ctx.retry.outageWaitMs);
        continue;
      }
      if (e instanceof ApiError && e.permanent) throw e;
      failures++;
      if (failures >= ctx.retry.attempts) throw e;
      const wait = ctx.retry.baseDelayMs * 3 ** (failures - 1);
      ctx.log(`${label}: attempt ${failures} failed (${(e as Error).message}); retry in ${wait} ms`);
      await ctx.sleep(wait);
    }
  }
}

function checkpoint(ctx: StepCtx, ev: PlanEvent, step: string, hashes: string[], data?: Record<string, unknown>): void {
  const rec: StepRecord = { type: "step", eventId: ev.id, wallet: "wallet" in ev ? ev.wallet : undefined, step, at: ctx.now(), hashes, data };
  ctx.files.append(rec);
}

async function onboard(ctx: StepCtx, ev: Ev<"onboard">): Promise<Result> {
  const kp = ctx.wallet(ev.wallet);
  const owner = kp.publicKey();
  const done = stepsFor(ctx.files.read(), ev.id);
  const hashes = [...done.values()].flatMap((s) => s.hashes);

  if (!done.has("friendbot")) {
    const r = await withRetry(ctx, `${ev.id} friendbot`, () => ctx.chain.ensureFunded(owner));
    checkpoint(ctx, ev, "friendbot", [], { result: r });
  }

  // 1 — deploy: server prepares, the wallet signs (Freighter in the UI), server submits.
  // A retry after an ambiguous submit can orphan one smart account; the export's
  // per-wallet Horizon listing still captures it.
  let smartWallet = done.get("deploy")?.data?.smartWallet as string | undefined;
  if (!smartWallet) {
    const d = await withRetry(ctx, `${ev.id} deploy`, async () => {
      const prep = await ctx.api.prepareDeploy(owner);
      const sub = await ctx.api.submit(ctx.chain.sign(prep.xdr, kp), `loadtest deploy ${ev.id}`);
      return { hash: sub.hash, smartWallet: prep.contractId };
    });
    smartWallet = d.smartWallet;
    hashes.push(d.hash);
    checkpoint(ctx, ev, "deploy", [d.hash], { smartWallet });
  }
  const sw = smartWallet;

  // 2 — authorize: the backend demo owner adds the pool + capped USDC agent rules.
  let rules = done.get("authorize")?.data as { poolRuleId: number; usdcRuleId: number } | undefined;
  if (!rules) {
    const a = await withRetry(ctx, `${ev.id} authorize`, () => ctx.api.authorize(sw, owner));
    rules = { poolRuleId: a.poolRuleId, usdcRuleId: a.usdcRuleId };
    hashes.push(...a.hashes);
    checkpoint(ctx, ev, "authorize", a.hashes, rules);
  }
  const r = rules;

  // 3 — fund: the UI's Fund step mints test USDC straight into the smart account.
  if (!done.has("fund")) {
    const f = await withRetry(ctx, `${ev.id} fund`, () => ctx.api.faucet(sw, ev.fundUsdc));
    hashes.push(f.txHash);
    checkpoint(ctx, ev, "fund", [f.txHash], { usdc: ev.fundUsdc });
  }

  // 4 — register.
  if (!done.has("register")) {
    await withRetry(ctx, `${ev.id} register`, () => ctx.api.register({ owner, smartWallet: sw, ...r }));
    checkpoint(ctx, ev, "register", []);
  }
  return { hashes, data: { owner, smartWallet: sw, ...r, fundUsdc: ev.fundUsdc } };
}

async function topup(ctx: StepCtx, ev: Ev<"topup">): Promise<Result> {
  const recs = ctx.files.read();
  const state = walletStates(recs).get(ev.wallet);
  if (!state) throw new SkipEvent(`wallet ${ev.wallet} was never onboarded`);
  const done = stepsFor(recs, ev.id);
  const hashes = [...done.values()].flatMap((s) => s.hashes);
  const data = { smartWallet: state.smartWallet, usdc: ev.usdc, via: ev.via };

  if (ev.via === "faucet") {
    if (!done.has("mint-sa")) {
      const f = await withRetry(ctx, `${ev.id} mint`, () => ctx.api.faucet(state.smartWallet, ev.usdc));
      hashes.push(f.txHash);
      checkpoint(ctx, ev, "mint-sa", [f.txHash], { usdc: ev.usdc });
    }
    return { hashes, data };
  }

  // via "transfer": the user moves USDC from their own G into the smart account
  // (/api/onboard/prepare step=fund — the route the UI no longer calls).
  const kp = ctx.wallet(ev.wallet);
  if (!state.trustline && !done.has("trustline")) {
    const h = await withRetry(ctx, `${ev.id} trustline`, () => ctx.chain.ensureTrustline(kp));
    if (h) hashes.push(h);
    checkpoint(ctx, ev, "trustline", h ? [h] : []);
  }
  if (!done.has("mint-g")) {
    const f = await withRetry(ctx, `${ev.id} mint-g`, () => ctx.api.faucet(state.owner, ev.usdc));
    hashes.push(f.txHash);
    checkpoint(ctx, ev, "mint-g", [f.txHash], { usdc: ev.usdc });
  }
  if (!done.has("transfer")) {
    const t = await withRetry(ctx, `${ev.id} transfer`, async () => {
      const prep = await ctx.api.prepareFund(state.owner, state.smartWallet, BigInt(ev.usdc) * STROOPS_PER_USDC);
      return ctx.api.submit(ctx.chain.sign(prep.xdr, kp), `loadtest transfer ${ev.id}`);
    });
    hashes.push(t.hash);
    checkpoint(ctx, ev, "transfer", [t.hash], { usdc: ev.usdc });
  }
  return { hashes, data };
}

async function unregister(ctx: StepCtx, ev: Ev<"unregister">): Promise<Result> {
  const state = walletStates(ctx.files.read()).get(ev.wallet);
  if (!state) throw new SkipEvent(`wallet ${ev.wallet} was never onboarded`);
  const r = await withRetry(ctx, ev.id, () => ctx.api.unregister(state.owner));
  return { hashes: [], data: { owner: state.owner, smartWallet: state.smartWallet, removed: r.removed } };
}

async function tick(ctx: StepCtx): Promise<Result> {
  const t0 = ctx.now();
  const r = await withRetry(ctx, "tick", () => ctx.api.tick());
  // Supply hashes are only in the server's activity log — export.ts pulls them.
  return { hashes: [], data: { ranAt: r.ranAt, durationMs: ctx.now() - t0 } };
}

const SNAPSHOT_ROUTES = ["/api/users", "/api/decision", "/api/scan", "/api/position", "/api/activity"];

async function snapshot(ctx: StepCtx, ev: Ev<"snapshot">): Promise<Result> {
  const out: Record<string, unknown> = { at: ctx.now() };
  for (const route of SNAPSHOT_ROUTES) {
    // Best-effort: a failing read route is recorded, never fails the run.
    out[route] = await ctx.api.get(route).catch((e: Error) => ({ error: e.message }));
  }
  const file = `snapshots/${ev.id.replace(":", "-")}.json`;
  ctx.files.writeJson(file, out);
  return { hashes: [], data: { file } };
}

function dispatch(ctx: StepCtx, ev: PlanEvent): Promise<Result> {
  switch (ev.kind) {
    case "onboard":
      return onboard(ctx, ev);
    case "topup":
      return topup(ctx, ev);
    case "unregister":
      return unregister(ctx, ev);
    case "tick":
      return tick(ctx);
    case "snapshot":
      return snapshot(ctx, ev);
  }
}

export async function runEvent(ctx: StepCtx, ev: PlanEvent, plannedAt: number): Promise<EventRecord> {
  const startedAt = ctx.now();
  const base = { type: "event" as const, eventId: ev.id, kind: ev.kind, wallet: "wallet" in ev ? ev.wallet : undefined, plannedAt, startedAt };
  let rec: EventRecord;
  try {
    const r = await dispatch(ctx, ev);
    rec = { ...base, status: "ok", finishedAt: ctx.now(), hashes: r.hashes, data: r.data };
  } catch (e) {
    rec = { ...base, status: e instanceof SkipEvent ? "skipped" : "failed", finishedAt: ctx.now(), hashes: [], error: (e as Error).message };
  }
  ctx.files.append(rec);
  return rec;
}
