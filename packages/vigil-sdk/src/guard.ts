/**
 * RiskGate (contracts/vigil-guard) — install params, policy-map helpers and
 * error decoding. Pure: no network.
 */
import { Address, Contract, xdr } from "@stellar/stellar-sdk";

export interface RiskGateParams {
  /** vigil-registry id; null = structural checks only (no rating gate). */
  registry: string | null;
  /** Minimum rating score (0..100) for deposits; must be 0 without a registry. */
  minScore: number;
  /** Maximum rating age in seconds; must be > 0 with a registry, 0 without. */
  maxAgeSecs: bigint;
  /** Allowed `transfer` recipients (token rules), e.g. [pool]; [] for pool rules. */
  allowedRecipients: string[];
}

/**
 * Encode `RiskGateParams` exactly as the contract's `#[contracttype]` struct:
 * an ScMap with Symbol keys in sorted order; `registry: null` → void.
 */
export function riskGateParams(p: RiskGateParams): xdr.ScVal {
  const entry = (k: string, v: xdr.ScVal) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: v });
  return xdr.ScVal.scvMap([
    entry("allowed_recipients", xdr.ScVal.scvVec(p.allowedRecipients.map((a) => Address.fromString(a).toScVal()))),
    entry("max_age_secs", xdr.ScVal.scvU64(xdr.Uint64.fromString(p.maxAgeSecs.toString()))),
    entry("min_score", xdr.ScVal.scvU32(p.minScore)),
    entry("registry", p.registry ? Address.fromString(p.registry).toScVal() : xdr.ScVal.scvVoid()),
  ]);
}

/** Params for the agent's pool rule: rating-gated deposits when a registry is given. */
export function poolRuleParams(opts: { registry?: string; minScore?: number; maxAgeSecs?: bigint }): xdr.ScVal {
  return opts.registry
    ? riskGateParams({ registry: opts.registry, minScore: opts.minScore ?? 60, maxAgeSecs: opts.maxAgeSecs ?? 7200n, allowedRecipients: [] })
    : riskGateParams({ registry: null, minScore: 0, maxAgeSecs: 0n, allowedRecipients: [] });
}

/** Params for the agent's token rule: `transfer` may only pay these contracts (the pools). */
export function tokenRuleParams(allowedRecipients: string[]): xdr.ScVal {
  return riskGateParams({ registry: null, minScore: 0, maxAgeSecs: 0n, allowedRecipients });
}

/**
 * A `policies: Map<Address, Val>` ScVal for `add_context_rule`, sorted by key
 * as Soroban requires (stellar-sdk's scvMap does not sort).
 */
export function policiesMap(entries: Array<[policy: string, installParam: xdr.ScVal]>): xdr.ScVal {
  const mapEntries = entries.map(([policy, val]) => new xdr.ScMapEntry({ key: Address.fromString(policy).toScVal(), val }));
  mapEntries.sort((a, b) => a.key().toXDR("hex").localeCompare(b.key().toXDR("hex")));
  return xdr.ScVal.scvMap(mapEntries);
}

/** `add_policy(context_rule_id, policy, install_param)` on an OZ smart account. */
export function addPolicyOp(smartAccount: string, contextRuleId: number, policy: string, installParam: xdr.ScVal): xdr.Operation {
  return new Contract(smartAccount).call("add_policy", xdr.ScVal.scvU32(contextRuleId), Address.fromString(policy).toScVal(), installParam);
}

/** vigil-guard (41xx) and vigil-registry (42xx) error codes. */
export const VIGIL_ERRORS: Record<number, string> = {
  4100: "NotInstalled — no guard params for this (smart account, rule)",
  4101: "AlreadyInstalled",
  4102: "InvalidParams",
  4103: "OnlyCallContract — the guard only attaches to CallContract rules",
  4104: "NoSigners — not every rule signer authenticated",
  4105: "ContextNotAllowed — contract creation",
  4106: "WrongContract — called contract is not the rule's target",
  4107: "FunctionNotAllowed",
  4108: "BadArgs",
  4109: "AccountMismatch — from/spender/to must be the smart account",
  4110: "EmptyRequests",
  4111: "RequestTypeNotAllowed — only supply/withdraw (0–3)",
  4112: "NegativeAmount",
  4113: "RecipientNotAllowed — transfer recipient not allowed",
  4114: "RatingUnavailable — no rating for this pool",
  4115: "ScoreTooLow — pool rating below the account's minimum",
  4116: "RatingStale — pool rating too old",
  4200: "NotPublisher",
  4201: "AlreadyPublisher",
  4202: "TooManyPublishers",
  4203: "InvalidThreshold",
  4204: "InvalidMaxAge",
  4205: "InvalidScore",
  4206: "FutureTimestamp",
  4207: "StaleTimestamp",
  4208: "NotNewer",
  4209: "EmptyBatch",
  4210: "BatchTooLarge",
};

/** Find a Vigil error in a host/simulation error string, e.g. "Error(Contract, #4115)". */
export function decodeVigilError(message: string): { code: number; name: string } | null {
  for (const m of message.matchAll(/Error\(Contract, #(\d+)\)/g)) {
    const code = Number(m[1]);
    if (VIGIL_ERRORS[code]) return { code, name: VIGIL_ERRORS[code] };
  }
  return null;
}
