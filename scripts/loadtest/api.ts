/**
 * Typed client for the YieldSeeker routes the onboarding UI calls
 * (src/app/_components/useOnboarding.ts), plus /api/tick and the read routes
 * used for snapshots. The load test drives the product only through these.
 */
import { requestJson, type JsonResponse } from "./http";

/** A non-2xx (or unreachable, status 0) answer from a YieldSeeker route. */
export class ApiError extends Error {
  constructor(
    readonly route: string,
    readonly status: number,
    detail: string,
  ) {
    super(`${route} → ${status === 0 ? "unreachable" : `HTTP ${status}`}: ${detail}`);
    this.name = "ApiError";
  }
  /** 4xx = the request itself is wrong; retrying cannot help. */
  get permanent(): boolean {
    return this.status >= 400 && this.status < 500;
  }
}

export interface RegisterBody {
  owner: string;
  smartWallet: string;
  poolRuleId: number;
  usdcRuleId: number;
}

export interface YsApi {
  agent(): Promise<{ agentPublicKey: string; ownerPublicKey: string }>;
  prepareDeploy(owner: string): Promise<{ xdr: string; contractId: string }>;
  prepareFund(owner: string, smartWallet: string, amountStroops: bigint): Promise<{ xdr: string }>;
  submit(signedXdr: string, label: string): Promise<{ hash: string }>;
  authorize(smartWallet: string, owner: string): Promise<{ poolRuleId: number; usdcRuleId: number; hashes: string[] }>;
  faucet(to: string, amountUsdc: number): Promise<{ txHash: string }>;
  register(body: RegisterBody): Promise<void>;
  unregister(owner: string): Promise<{ removed: boolean }>;
  tick(): Promise<{ ranAt: string }>;
  get(path: string): Promise<unknown>;
}

type Body = Record<string, unknown> & { error?: string };

/** Authorize submits two txs and polls each; give every call well over that. */
const DEFAULT_TIMEOUT_MS = 300_000;

export function createApi(baseUrl: string, opts: { request?: typeof requestJson; cronSecret?: string } = {}): YsApi {
  const request = opts.request ?? requestJson;

  async function call<T extends Body>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<T> {
    const res: JsonResponse<T> = await request<T>(method, new URL(path, baseUrl).toString(), body, timeoutMs);
    if (res.status < 200 || res.status >= 300 || !res.data) {
      // The query string is dropped from the route so a cron key never reaches a log.
      throw new ApiError(path.split("?")[0], res.status, res.data?.error ?? JSON.stringify(res.data));
    }
    return res.data;
  }

  return {
    async agent() {
      const d = await call<Body & { agentPublicKey: string; ownerPublicKey: string }>("GET", "/api/agent");
      return { agentPublicKey: d.agentPublicKey, ownerPublicKey: d.ownerPublicKey };
    },
    async prepareDeploy(owner) {
      const d = await call<Body & { xdr: string; contractId?: string }>("POST", "/api/onboard/prepare", { owner, step: "deploy" });
      if (!d.contractId) throw new ApiError("/api/onboard/prepare", 200, "deploy answer has no contractId");
      return { xdr: d.xdr, contractId: d.contractId };
    },
    async prepareFund(owner, smartWallet, amountStroops) {
      const d = await call<Body & { xdr: string }>("POST", "/api/onboard/prepare", {
        owner,
        step: "fund",
        smartWallet,
        amountStroops: amountStroops.toString(),
      });
      return { xdr: d.xdr };
    },
    async submit(signedXdr, label) {
      const d = await call<Body & { hash: string }>("POST", "/api/onboard/submit", { signedXdr, label });
      return { hash: d.hash };
    },
    async authorize(smartWallet, owner) {
      const d = await call<Body & { poolRuleId: number; usdcRuleId: number; hashes: string[] }>("POST", "/api/authorize", {
        smartWallet,
        owner,
      });
      return { poolRuleId: d.poolRuleId, usdcRuleId: d.usdcRuleId, hashes: d.hashes };
    },
    async faucet(to, amountUsdc) {
      const d = await call<Body & { txHash: string }>("POST", "/api/faucet", { to, amount: amountUsdc });
      return { txHash: d.txHash };
    },
    async register(body) {
      await call("POST", "/api/register", body);
    },
    async unregister(owner) {
      const d = await call<Body & { removed: boolean }>("DELETE", `/api/register?owner=${encodeURIComponent(owner)}`);
      return { removed: d.removed };
    },
    async tick() {
      const key = opts.cronSecret ? `?key=${encodeURIComponent(opts.cronSecret)}` : "";
      // timeoutMs 0: a tick supplies every registered user serially and can take many minutes.
      const d = await call<Body & { ranAt: string }>("POST", `/api/tick${key}`, undefined, 0);
      return { ranAt: d.ranAt };
    },
    async get(path) {
      return call<Body>("GET", path);
    },
  };
}
