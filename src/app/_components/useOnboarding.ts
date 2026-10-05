"use client";

import { useCallback, useEffect, useState } from "react";

// NOTE: this hook is intentionally free of any `@stellar/stellar-sdk` import so
// the browser bundle never pulls in the SDK (it relies on Node built-ins). All
// transaction building / simulation / submission happens server-side
// (`/api/onboard/*`, `/api/authorize`); the client only runs Freighter's
// `signTransaction` on a server-prepared XDR and POSTs the signed XDR back.

const EXEC_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

// ── API shapes ───────────────────────────────────────────────────────────────

export interface RegisteredUser {
  owner: string;
  smartWallet: string;
  poolRuleId: number;
  usdcRuleId: number;
  createdAt: number;
  position: { poolId: string | null; amountUsdc: string };
  /** Unsupplied USDC in the smart account (decimal stroops); null if unreadable. */
  idleUsdc?: string | null;
}

interface AgentInfo {
  agentPublicKey: string;
  agentPublicKeyHex: string;
  ownerPublicKey: string;
  ownerPublicKeyHex: string;
  freighterCanSignOwnerAuth: boolean;
  ownerMode: string;
}

export type StepKey = "deploy" | "authorize" | "fund" | "register";
export type StepStatus = "idle" | "active" | "done" | "error";

export interface OnboardingStep {
  key: StepKey;
  status: StepStatus;
  detail?: string;
  txHash?: string;
}

const INITIAL_STEPS: OnboardingStep[] = [
  { key: "deploy", status: "idle" },
  { key: "authorize", status: "idle" },
  { key: "fund", status: "idle" },
  { key: "register", status: "idle" },
];

// ── tiny fetch helpers ─────────────────────────────────────────────────────────

async function getJson<T>(url: string): Promise<{ ok: boolean; status: number; data: T | null }> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    const data = res.headers.get("content-type")?.includes("application/json")
      ? ((await res.json()) as T)
      : null;
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

async function postJson<T>(url: string, body: unknown): Promise<{ ok: boolean; status: number; data: T | null }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const data = res.headers.get("content-type")?.includes("application/json")
      ? ((await res.json()) as T)
      : null;
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

async function deleteJson<T>(url: string): Promise<{ ok: boolean; status: number; data: T | null }> {
  try {
    const res = await fetch(url, { method: "DELETE", cache: "no-store" });
    const data = res.headers.get("content-type")?.includes("application/json")
      ? ((await res.json()) as T)
      : null;
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

/**
 * Self-serve faucet: mint our testnet USDC straight into the smart account `C…`
 * (no external USDC needed, no classic trustline). Returns the tx hash + the
 * smart account's new USDC balance (stroops, decimal string). Throws on failure.
 */
async function faucetMint(opts: {
  to: string;
  amountUsdc: number;
}): Promise<{ txHash: string; balanceStroops: string | null }> {
  const res = await postJson<{
    ok: boolean;
    txHash: string;
    amount: number;
    balanceStroops: string | null;
    error?: string;
  }>("/api/faucet", { to: opts.to, amount: opts.amountUsdc });
  if (!res.ok || !res.data?.ok || !res.data.txHash) {
    throw new Error(`faucet: ${res.data?.error ?? `HTTP ${res.status}`}`);
  }
  return { txHash: res.data.txHash, balanceStroops: res.data.balanceStroops };
}

/**
 * Server-prepare an onboarding tx, sign it in Freighter, submit it server-side.
 * Returns the on-chain tx hash. Throws with a readable message on any failure.
 *
 * Used for the `deploy` step (createCustomContract, user-signed). Funding is no
 * longer Freighter-driven — the Fund step self-serve-mints via `/api/faucet`.
 */
async function prepareSignSubmit(opts: {
  owner: string;
  step: "deploy";
  label: string;
}): Promise<{ hash: string; contractId?: string }> {
  const prep = await postJson<{ xdr: string; contractId?: string; error?: string }>(
    "/api/onboard/prepare",
    {
      owner: opts.owner,
      step: opts.step,
    },
  );
  if (!prep.ok || !prep.data?.xdr) {
    throw new Error(`${opts.label}: prepare failed (${prep.data?.error ?? `HTTP ${prep.status}`})`);
  }

  const api = await import("@stellar/freighter-api");
  const signRes = await api.signTransaction(prep.data.xdr, {
    networkPassphrase: EXEC_NETWORK_PASSPHRASE,
    address: opts.owner,
  });
  if (signRes.error || !signRes.signedTxXdr) {
    throw new Error(`${opts.label}: Freighter signing failed (${signRes.error ?? "no signature"})`);
  }

  const sub = await postJson<{ hash: string; success: boolean; status: string; error?: string }>(
    "/api/onboard/submit",
    { signedXdr: signRes.signedTxXdr, label: opts.label },
  );
  if (!sub.ok || !sub.data?.success) {
    throw new Error(`${opts.label}: ${sub.data?.status ?? `HTTP ${sub.status}`}${sub.data?.error ? ` (${sub.data.error})` : ""}`);
  }
  return { hash: sub.data.hash, contractId: prep.data.contractId };
}

// ── hook ─────────────────────────────────────────────────────────────────────

export interface OnboardingState {
  /** null until the owner lookup resolves; then registered user row or false. */
  registered: RegisteredUser | null | false;
  loadingStatus: boolean;
  steps: OnboardingStep[];
  running: boolean;
  error: string | null;
  /** The smart wallet C-address captured during/after deploy (for display). */
  smartWallet: string | null;
  agent: AgentInfo | null;
  /**
   * The smart account's USDC balance in stroops (decimal string), set after the
   * faucet mint in the Fund step. null until known.
   */
  saUsdcStroops: string | null;
  /** True while a demo reset (un-register) request is in flight. */
  resetting: boolean;
  /** Kick off the full deploy → authorize → fund → register flow. */
  start: (amountUsdc: number) => Promise<void>;
  /** Re-pull the owner's registration status. */
  refresh: () => void;
  /** Reset the local step UI (does not touch the server registry). */
  reset: () => void;
  /**
   * DEMO RESET: forget THIS user's registration in the in-memory registry
   * (`DELETE /api/register?owner=…`) so the onboarding re-appears, then re-pull
   * status. Used by the "Reset demo" affordance in the registered view.
   */
  resetDemo: () => Promise<void>;
}

/**
 * Drives the per-user onboarding for a connected Freighter `G…` address:
 *   - Looks up `/api/users?owner=…` → registered row | not-registered.
 *   - `start(amount)` runs the 4 steps and flips `registered` on success.
 *
 * Steps 1 (deploy) / 3 (fund) / 4 (register) are Freighter-native. Step 2
 * (authorize) is backend-assisted (`/api/authorize`) because Freighter cannot
 * produce the OZ SmartAccount owner AuthPayload signature.
 */
export function useOnboarding(ownerAddress: string | null): OnboardingState {
  const [registered, setRegistered] = useState<RegisteredUser | null | false>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [steps, setSteps] = useState<OnboardingStep[]>(INITIAL_STEPS);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [smartWallet, setSmartWallet] = useState<string | null>(null);
  const [agent, setAgent] = useState<AgentInfo | null>(null);
  const [saUsdcStroops, setSaUsdcStroops] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  const setStep = useCallback((key: StepKey, patch: Partial<OnboardingStep>) => {
    setSteps((prev) => prev.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  }, []);

  // Owner-status lookup whenever the connected address changes.
  const fetchStatus = useCallback(async (owner: string) => {
    setLoadingStatus(true);
    const res = await getJson<RegisteredUser>(`/api/users?owner=${encodeURIComponent(owner)}`);
    if (res.status === 404) {
      setRegistered(false);
    } else if (res.ok && res.data) {
      setRegistered(res.data);
      setSmartWallet(res.data.smartWallet);
    } else {
      // Unknown / network error: treat as not-registered so onboarding shows.
      setRegistered(false);
    }
    setLoadingStatus(false);
  }, []);

  useEffect(() => {
    if (!ownerAddress) {
      setRegistered(null);
      setSmartWallet(null);
      setSaUsdcStroops(null);
      setSteps(INITIAL_STEPS);
      setError(null);
      return;
    }
    void fetchStatus(ownerAddress);
  }, [ownerAddress, fetchStatus]);

  const refresh = useCallback(() => {
    if (ownerAddress) void fetchStatus(ownerAddress);
  }, [ownerAddress, fetchStatus]);

  const reset = useCallback(() => {
    setSteps(INITIAL_STEPS);
    setError(null);
    setRunning(false);
  }, []);

  const resetDemo = useCallback(async () => {
    if (!ownerAddress || resetting) return;
    setResetting(true);
    setError(null);
    await deleteJson<{ ok: boolean; removed: boolean }>(
      `/api/register?owner=${encodeURIComponent(ownerAddress)}`,
    );
    // Back to a clean onboarding slate, then re-pull status (now 404 ⇒ false).
    setSteps(INITIAL_STEPS);
    setSmartWallet(null);
    setSaUsdcStroops(null);
    await fetchStatus(ownerAddress);
    setResetting(false);
  }, [ownerAddress, resetting, fetchStatus]);

  const start = useCallback(
    async (amountUsdc: number) => {
      if (!ownerAddress || running) return;
      if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) {
        setError("Enter a positive USDC amount.");
        return;
      }
      setRunning(true);
      setError(null);
      setSteps(INITIAL_STEPS);
      setSaUsdcStroops(null);

      try {
        // Load the agent + demo-owner keys (informational + drives the panel).
        const agentRes = await getJson<AgentInfo>("/api/agent");
        if (!agentRes.ok || !agentRes.data) {
          throw new Error("could not load /api/agent (agent key unavailable)");
        }
        setAgent(agentRes.data);

        // ── STEP 1: deploy the smart account (owner = backend demo owner) ──
        setStep("deploy", { status: "active", detail: "building createCustomContract…" });
        const deploy = await prepareSignSubmit({ owner: ownerAddress, step: "deploy", label: "deploy" });
        const contractId = deploy.contractId;
        if (!contractId) throw new Error("deploy: server did not return a contract id");
        setSmartWallet(contractId);
        setStep("deploy", { status: "done", detail: contractId, txHash: deploy.hash });

        // ── STEP 2: authorize the agent (backend-assisted owner signing) ──
        setStep("authorize", { status: "active", detail: "owner-signing add_context_rule ×2 (backend)…" });
        const authRes = await postJson<{
          poolRuleId: number;
          usdcRuleId: number;
          hashes: string[];
          error?: string;
        }>("/api/authorize", { smartWallet: contractId, owner: ownerAddress });
        if (!authRes.ok || !authRes.data || authRes.data.error) {
          throw new Error(`authorize failed: ${authRes.data?.error ?? `HTTP ${authRes.status}`}`);
        }
        const { poolRuleId, usdcRuleId, hashes } = authRes.data;
        setStep("authorize", {
          status: "done",
          detail: `pool rule #${poolRuleId} · usdc rule #${usdcRuleId} (capped)`,
          txHash: hashes[hashes.length - 1],
        });

        // ── STEP 3: fund the smart account by minting our test USDC into it ──
        // Self-serve faucet: the backend mints our own testnet USDC SAC straight
        // into the smart account `C…` (no external USDC, no classic trustline).
        setStep("fund", { status: "active", detail: `minting ${amountUsdc} test USDC…` });
        const fund = await faucetMint({ to: contractId, amountUsdc });
        setSaUsdcStroops(fund.balanceStroops);
        setStep("fund", { status: "done", detail: `${amountUsdc} USDC → smart account`, txHash: fund.txHash });

        // ── STEP 4: register the user (records the SA + rule ids) ──
        setStep("register", { status: "active", detail: "recording your smart account…" });
        const regRes = await postJson<{ ok: boolean; user: RegisteredUser }>("/api/register", {
          owner: ownerAddress,
          smartWallet: contractId,
          poolRuleId,
          usdcRuleId,
        });
        if (!regRes.ok || !regRes.data?.ok) {
          throw new Error(`register failed: HTTP ${regRes.status}`);
        }
        setStep("register", { status: "done", detail: "agent now managing your USDC" });

        // Trigger an immediate agent tick so the blue glow + ripple animation
        // fires right after onboarding — without this, the user would wait for
        // the daily Vercel cron. Fire-and-forget: don't block the success view.
        void fetch("/api/tick").catch(() => {});

        // Flip to the registered view.
        await fetchStatus(ownerAddress);
      } catch (e) {
        const msg = (e as Error).message || "onboarding failed";
        setError(msg);
        setSteps((prev) => {
          const firstActive = prev.find((s) => s.status === "active");
          if (!firstActive) return prev;
          return prev.map((s) => (s.key === firstActive.key ? { ...s, status: "error", detail: msg } : s));
        });
      } finally {
        setRunning(false);
      }
    },
    [ownerAddress, running, setStep, fetchStatus],
  );

  return {
    registered,
    loadingStatus,
    steps,
    running,
    error,
    smartWallet,
    agent,
    saUsdcStroops,
    resetting,
    start,
    refresh,
    reset,
    resetDemo,
  };
}
