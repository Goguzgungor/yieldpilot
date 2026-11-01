# Vigil contracts

Two Soroban contracts that turn the YieldPilot agent key from "can call the
Blend pool however it likes" into "can only move the user's money between the
user's own account and a pool that is currently rated safe".

| crate | kind | what it is |
|---|---|---|
| `vigil-guard` | contract (wasm) | **RiskGate**: a shared, admin-less OpenZeppelin smart-account policy (`stellar_accounts::policies::Policy`, stellar-accounts 0.8.0) |
| `vigil-registry` | contract (wasm) | **RiskRegistry**: publishers sign per-pool risk ratings, consumers read an M-of-N median |
| `vigil-interface` | rlib only | shared `Rating` / `Submission` / `RatingInput` types and the `RiskRegistryClient` the guard uses. A separate crate so neither contract links the other's exported functions into its wasm |

`testdata/` has copies of the **real** testnet wasms the compatibility tests
run against: `oz_smart_account_0_7.wasm` (sha256 `e2f4ed54…a28d`, the
YieldPilot user smart account, OZ 0.7.x on soroban-sdk 26.0.1) and
`oz_spending_limit_0_7.wasm` (sha256 `de5c4ac6…941c`, the spending-limit
policy on the USDC rule).

---

## The threat this closes

Today every YieldPilot smart account has the backend agent key as an External
ed25519 signer under two context rules:

| rule | policy today | what a stolen agent key can do today |
|---|---|---|
| `CallContract(BLEND_POOL)` | **none** | `pool.submit(from=SA, spender=SA, to=ATTACKER, [WithdrawCollateral max])` → the whole position goes to the attacker. Also `claim(SA, ids, ATTACKER)`, `flash_loan`, borrow against the collateral, fill auctions |
| `CallContract(USDC)` | OZ spending limit | `usdc.transfer(SA, ATTACKER, ≤ cap)` every period |

With the guard installed on both rules (pool rule: rating params; USDC rule:
`allowed_recipients = [pool]`), the agent can only do:

* `pool.submit` / `pool.submit_with_allowance` with `from == spender == to == SA`
  and request types `0 Supply`, `1 Withdraw`, `2 SupplyCollateral`, `3 WithdrawCollateral`;
* deposits only into a pool whose aggregated rating is `>= min_score` and fresh;
* withdrawals at any time, whatever the rating says;
* `pool.claim(SA, ids, SA)`;
* `usdc.transfer(SA, pool, amount >= 0)`, still capped by the spending-limit policy.

Everything else is rejected.

---

## vigil-guard: RiskGate policy

Deployed once and shared by every smart account. Params are stored per
`(smart_account, context_rule_id)`. There is no admin and no upgrade path.

### Lifecycle (called by the smart account)

| fn | auth | behaviour |
|---|---|---|
| `install(install_params: RiskGateParams, context_rule, smart_account)` | `smart_account.require_auth()` | rule type must be `CallContract(_)` (else 4103); params validated (4102); panics on reinstall (4101); stores params, emits `risk_gate_installed` |
| `uninstall(context_rule, smart_account)` | `smart_account.require_auth()` | 4100 if not installed; deletes params, emits `risk_gate_uninstalled` |
| `enforce(context, authenticated_signers, context_rule, smart_account)` | `smart_account.require_auth()` | rules below; emits `risk_gate_enforced` |
| `get_params(smart_account, context_rule_id) -> Option<RiskGateParams>` | none | read |

Param validation: `min_score <= 100`; `registry == None ⇒ min_score == 0`
(so you can't think deposits are gated when they aren't);
`registry != None ⇒ max_age_secs > 0`; `allowed_recipients.len() <= 8`.

### Exact enforcement rules (`enforce`)

These run in order. The first failure panics with the listed code.

1. `smart_account.require_auth()`. Inside `__check_auth` this passes because the SA is the direct invoker.
2. **Signers (4104).** The rule must have ≥ 1 signer, `authenticated_signers`
   must be non-empty, and **every** rule signer must be in
   `authenticated_signers`. A rule that has policies hands its signer check
   to those policies. The tests show that an `AuthPayload` with *no*
   signatures reaches the policy on the deployed 0.7 SA. Requiring all
   rule signers means attaching the guard never loosens a rule compared
   with having no policy.
3. Params for `(smart_account, context_rule.id)` must exist (4100). Their TTL is extended.
4. The context must be `Context::Contract` (4105). Contract-creation contexts are rejected.
5. `context.contract` must equal the rule's `CallContract(target)` (4106). This is defence in depth: the SA already checks it.
6. Dispatch on `fn_name`:

| fn_name | args (exact arity, typed decode → else 4108) | rule |
|---|---|---|
| `submit`, `submit_with_allowance` | `(from: Address, spender: Address, to: Address, requests: Vec<Request>)` | `from == spender == to == smart_account` (4109); `requests` non-empty (4110); each request must be an ScMap with exactly `{address, amount, request_type}` and the right types (4108); `request_type ∈ {0,1,2,3}` (4111); `amount >= 0` (4112). If **any** request is a deposit (0 or 2) **and** `registry` is set: `registry.get_rating(context.contract)` must return `Some` (a failed call or `None` → 4114), `score >= min_score` (4115), `rating.timestamp <= now && now - rating.timestamp <= max_age_secs` (4116). **Withdraw-only requests are never rating-gated.** |
| `claim` | `(from: Address, reserve_token_ids: Vec<u32>, to: Address)` | `from == to == smart_account` (4109) |
| `transfer` | `(from: Address, to: Address, amount: i128)` | `from == smart_account` (4109); `to ∈ allowed_recipients` (4113, so an empty list allows nothing); `amount >= 0` (4112). A muxed `to` does not decode as `Address` → 4108 |
| anything else (`approve`, `transfer_from`, `burn`, `flash_loan`, …) | | 4107 |

The rating is looked up for the **called contract** (the pool in
`ContractContext.contract`), not for anything in the args. Effective
freshness is `min(registry.max_age, guard.max_age_secs)`, measured from the
oldest submission the registry used.

### Events

| topic[0] | topic[1] | data |
|---|---|---|
| `risk_gate_installed` | smart_account | `{context_rule_id, params}` |
| `risk_gate_uninstalled` | smart_account | `{context_rule_id}` |
| `risk_gate_enforced` | smart_account | `{context_rule_id, contract, fn_name, deposit: bool, score: Option<u32>}` |

---

## vigil-registry: RiskRegistry

```rust
__constructor(admin: Address, threshold: u32, max_age_secs: u64)   // threshold 1..=16, max_age > 0

// admin (admin.require_auth())
add_publisher(publisher: Address)          // max 16 publishers
remove_publisher(publisher: Address)
set_threshold(threshold: u32)              // 1..=16; may exceed publisher count (reads then return None)
set_max_age(max_age_secs: u64)             // > 0
transfer_admin(new_admin: Address)         // current admin AND new_admin must both authorize

// publishers (publisher.require_auth(), must be registered)
publish(publisher: Address, pool: Address, score: u32, timestamp: u64, reasons_hash: BytesN<32>)
publish_batch(publisher: Address, ratings: Vec<RatingInput>)   // 1..=32 entries, atomic

// reads (the RiskRegistryInterface in vigil-interface)
get_rating(pool: Address) -> Option<Rating>
get_submission(pool: Address, publisher: Address) -> Option<Submission>
publishers() -> Vec<Address>
threshold() -> u32
max_age() -> u64
admin() -> Address

struct Rating      { score: u32, publishers: u32, timestamp: u64 }
struct Submission  { score: u32, timestamp: u64, reasons_hash: BytesN<32> }
struct RatingInput { pool: Address, score: u32, timestamp: u64, reasons_hash: BytesN<32> }
```

* `publish` checks `score <= 100`, `timestamp <= ledger.timestamp`, and
  `now - timestamp <= max_age`. A submission replaces that publisher's
  previous one for the same pool **only if strictly newer** (otherwise
  4208). In `publish_batch` any invalid entry, including the same pool
  twice, reverts the whole batch.
* `get_rating` reads the submissions of **currently registered** publishers
  only. A removed publisher stops counting at once; if re-added, its
  still-fresh submissions count again. Only submissions with
  `now - timestamp <= max_age` count. It returns `None` when fewer than
  `threshold` remain. Otherwise:
  * `score`: median of the counted scores; with an even count, the **lower** middle;
  * `publishers`: how many submissions were counted;
  * `timestamp`: the **oldest** counted timestamp.
* Storage: config in instance storage; submissions in persistent storage
  under `(pool, publisher)`, with TTL extended 30 days on every publish.
  Reads never extend TTL, which keeps the guard's call inside
  `__check_auth` cheap.
* Events: `rating_published [pool, publisher] {score, timestamp, reasons_hash}`,
  `publisher_added`, `publisher_removed`, `threshold_set`, `max_age_set`,
  `admin_transferred`.

---

## Install-param encoding (what a TypeScript client sends)

`RiskGateParams` is a `#[contracttype]` struct, so on the wire it is an
**ScMap with Symbol keys sorted alphabetically**:

```
ScMap {
  "allowed_recipients": ScVec<ScAddress>,
  "max_age_secs":       U64,
  "min_score":          U32,
  "registry":           ScAddress | Void      // Option<Address>: None = Void
}
```

stellar-xdr JSON (validated with `stellar xdr encode --type ScVal`):

```jsonc
// pool rule: CallContract(EXEC_POOL_ID)
{"map":[
  {"key":{"symbol":"allowed_recipients"},"val":{"vec":[]}},
  {"key":{"symbol":"max_age_secs"},"val":{"u64":"3600"}},
  {"key":{"symbol":"min_score"},"val":{"u32":60}},
  {"key":{"symbol":"registry"},"val":{"address":"CB4LXLCCD7YDND5FBVXPKPHUQMF7JFSDRVXHG7ZZTWWNPJ6WDCXDNDF6"}}
]}

// USDC rule: CallContract(EXEC_USDC_CONTRACT_ID)
{"map":[
  {"key":{"symbol":"allowed_recipients"},"val":{"vec":[{"address":"CBI7WAUQ4NPQFZW4C3MDSVFAZJWV3RCLZSTTMA5OZ6BTPEQMOZZNSZ3Z"}]}},
  {"key":{"symbol":"max_age_secs"},"val":{"u64":"0"}},
  {"key":{"symbol":"min_score"},"val":{"u32":0}},
  {"key":{"symbol":"registry"},"val":"void"}
]}
```

`@stellar/stellar-sdk`:

```ts
import { Address, xdr } from "@stellar/stellar-sdk";

const entry = (k: string, v: xdr.ScVal) =>
  new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: v });

export function riskGateParams(p: {
  registry: string | null; minScore: number; maxAgeSecs: bigint; allowedRecipients: string[];
}): xdr.ScVal {
  return xdr.ScVal.scvMap([                       // keys MUST stay in this (sorted) order
    entry("allowed_recipients", xdr.ScVal.scvVec(p.allowedRecipients.map((a) => new Address(a).toScVal()))),
    entry("max_age_secs", xdr.ScVal.scvU64(new xdr.Uint64(p.maxAgeSecs))),
    entry("min_score", xdr.ScVal.scvU32(p.minScore)),
    entry("registry", p.registry ? new Address(p.registry).toScVal() : xdr.ScVal.scvVoid()),
  ]);
}

// Pool rule
const poolParams = riskGateParams({ registry: VIGIL_REGISTRY, minScore: 60, maxAgeSecs: 3600n, allowedRecipients: [] });
// USDC rule
const usdcParams = riskGateParams({ registry: null, minScore: 0, maxAgeSecs: 0n, allowedRecipients: [EXEC_POOL_ID] });
```

Where it goes on the smart account (OZ 0.7 interface):

* **Existing rule** (the migration path):
  `add_policy(context_rule_id: u32, policy: Address = VIGIL_GUARD, install_param: Val = <params ScVal>)`.
  `install_param` is passed through untouched as the ScMap above.
* **New rule**:
  `add_context_rule(context_type, name, valid_until, signers, policies: Map<Address, Val>)`,
  where `policies` is an `scvMap` of `{ key: Address(policy).toScVal(), val: <params> }`.
  When there are several policies (e.g. spending-limit + guard on the USDC
  rule), ScMap entries **must be sorted by key**: contract addresses
  compare by their 32-byte id. stellar-sdk's `scvMap` does not sort for
  you. A second `add_policy` call avoids the issue.

Both calls need the smart account's own (owner / Default-rule) auth. In
YieldPilot new wallets are owned by the user's G-account (`Signer::Delegated`),
so the user signs them in Freighter (`src/lib/smartAccount.ts`
`buildDelegatedOwnerTx`); YieldPilot's `addAgentRuleOps({guard})` and
`riskGateParams` build exactly the encodings above.

Stellar CLI form (the spec types `install_params` on the guard, so it
accepts JSON):

```sh
stellar contract invoke --id $VIGIL_GUARD ... -- install \
  --install_params '{"registry":"CB4L…NDF6","min_score":60,"max_age_secs":3600,"allowed_recipients":[]}' \
  --context_rule '{"id":1,"context_type":{"CallContract":"C…POOL"},"name":"agent-pool","signers":[…],"signer_ids":[1],"policies":["C…GUARD"],"policy_ids":[0],"valid_until":null}' \
  --smart_account C…SA
```

---

## Error codes

### vigil-guard (`GuardError`)

| code | name | meaning |
|---|---|---|
| 4100 | NotInstalled | no params for (smart_account, rule id) |
| 4101 | AlreadyInstalled | install called twice for the same (smart_account, rule id) |
| 4102 | InvalidParams | min_score > 100; min_score > 0 without registry; max_age 0 with registry; > 8 recipients |
| 4103 | OnlyCallContract | install on a Default / CreateContract rule |
| 4104 | NoSigners | rule has no signers, or not every rule signer authenticated |
| 4105 | ContextNotAllowed | contract-creation context |
| 4106 | WrongContract | called contract ≠ rule's CallContract target |
| 4107 | FunctionNotAllowed | fn not in {submit, submit_with_allowance, claim, transfer} |
| 4108 | BadArgs | wrong arity / types, malformed or extra-key Request, muxed recipient |
| 4109 | AccountMismatch | from / spender / to ≠ smart account |
| 4110 | EmptyRequests | submit with no requests |
| 4111 | RequestTypeNotAllowed | request_type ∉ {0,1,2,3} (borrow, repay, auctions, …) |
| 4112 | NegativeAmount | amount < 0 |
| 4113 | RecipientNotAllowed | transfer `to` ∉ allowed_recipients |
| 4114 | RatingUnavailable | deposit gated: registry returned None or the call failed |
| 4115 | ScoreTooLow | deposit gated: score < min_score |
| 4116 | RatingStale | deposit gated: rating older than max_age_secs (or in the future) |

### vigil-registry (`RegistryError`)

| code | name |
|---|---|
| 4200 | NotPublisher |
| 4201 | AlreadyPublisher |
| 4202 | TooManyPublishers (max 16) |
| 4203 | InvalidThreshold (must be 1..=16) |
| 4204 | InvalidMaxAge (must be > 0) |
| 4205 | InvalidScore (> 100) |
| 4206 | FutureTimestamp |
| 4207 | StaleTimestamp |
| 4208 | NotNewer |
| 4209 | EmptyBatch |
| 4210 | BatchTooLarge (max 32) |

An error raised inside a policy comes back unchanged from the SA's
`__check_auth` (e.g. `Error(Contract, #4109)`). The compatibility tests
assert this. On-chain, the code shows up in the diagnostic events of the
failed simulation or transaction.

---

## Build & test

```sh
cd contracts
cargo test                     # 79 tests (+1 ignored, below)
stellar contract build         # -> target/wasm32v1-none/release/{vigil_guard,vigil_registry}.wasm
cargo test -- --ignored        # runs the COMPILED wasms against the real SA (needs the build above)
```

| wasm | size | sha256 |
|---|---|---|
| `vigil_guard.wasm` | 19,377 B | `10279cd9198a5423d5ed04908411c4e99ed25ae206c57460f17cbd3f45b09987` |
| `vigil_registry.wasm` | 11,986 B | `7213dcc092d3667a60b95d427b0a9167369ef589d4a0f4a079d1aefe8b2a2b66` |

Toolchain: soroban-sdk 28.0.0, stellar-accounts 0.8.0, stellar CLI 26.0.0, target `wasm32v1-none`.

### What the compatibility test (`vigil-guard/tests/sa_compat.rs`) proves

It registers the real `oz_smart_account_0_7.wasm` with a `Signer::Delegated`
owner. It then adds the pool rule with the guard (through
`add_context_rule`) and the USDC rule with the **real** spending-limit wasm,
then adds the guard to that rule with `add_policy`. Finally it calls
`env.try_invoke_contract_check_auth`:

* **Delegated agent** (auth mocked): legitimate supply passes; `to = attacker` fails with 4109.
* **External ed25519 agent** (the production path), with **no auth mocked**
  (`set_auths(&[])`): the agent signs the 0.7 digest
  `sha256(signature_payload || xdr(ScVec[u32 rule ids]))` with a real key,
  checked by a stock OZ ed25519 verifier. Results:
  * supply with the nested `usdc.transfer(SA→pool)` across both rules passes;
  * drain via `submit`/`claim` to the attacker, borrow, flash_loan, and a direct `transfer` to the attacker all fail;
  * low, stale or missing ratings block deposits while withdrawals still pass;
  * the spending cap is still enforced next to the guard;
  * a bad signature fails;
  * an `AuthPayload` with no signers reaches the guard and is rejected with 4104;
  * removing the rule through the SA uninstalls the guard.
* The `--ignored` test repeats the core cases with the **compiled**
  guard + registry wasm in place of the native ones.

So the stellar-accounts 0.8.0 `Context` / `ContextRule` / `Signer` types
decode the values the 0.7 SA passes. This is verified, not assumed.

---

## Testnet deployment (2026-11-01)

| | value |
|---|---|
| network | testnet, `https://soroban-testnet.stellar.org`, `Test SDF Network ; September 2015` |
| deployer / registry admin | `GANUB45L4U3YYHZDSEJEVMLSBVXCKBIRLP3ZPE3PANUWMVI4UKBGQH3C` (stellar CLI identity `vigil-deployer`, throwaway) |
| **vigil-guard** | `CD6BDS7R5K3IUCQSJUZUWAGLTR47EZOYEVCO5MPT7YGNBNQRHSNY5VMS` (wasm `10279cd9…09987`) |
| **vigil-registry** | `CB4LXLCCD7YDND5FBVXPKPHUQMF7JFSDRVXHG7ZZTWWNPJ6WDCXDNDF6` (wasm `7213dcc0…a2b66`), threshold 1, max_age 7200 s |
| publishers | `GANUB45L…QH3C`, the deployer itself: a **demo publisher only**, so a single key controls every rating |

The on-chain wasm hashes were re-fetched and match the local build. One
smoke `publish` (score 77) was made for the guard's own id as a dummy
"pool". It stops counting after 2 h.

---

## Migrating an existing YieldPilot account (testnet)

Implemented by `scripts/migrate-legacy-accounts.ts` (dry run by default), which
also hands ownership from the backend demo owner to the user. For each user SA,
using the owner (demo-owner) auth:

1. `add_policy(poolRuleId, VIGIL_GUARD, riskGateParams({registry: VIGIL_REGISTRY, minScore, maxAgeSecs, allowedRecipients: []}))`
2. `add_policy(usdcRuleId, VIGIL_GUARD, riskGateParams({registry: null, minScore: 0, maxAgeSecs: 0, allowedRecipients: [EXEC_POOL_ID]}))`
3. Have a publisher `publish` a rating for `EXEC_POOL_ID` more often than
   `maxAgeSecs`, or deposits stop with 4114/4116. Withdrawals keep working
   either way.

The agent's own transaction flow does not change: same `pool.submit`,
same rule ids, same two-pass simulate. Simulation picks up the guard's and
the registry's footprint.

**On-chain proof (testnet, 2026-11-01)** — `scripts/verify-guard.ts` on a
real user-owned wallet `CDNE56FV…77PBB` against the real exec Blend pool:

| step | before guard | after guard |
|---|---|---|
| agent supplies USDC | OK `36ee6d02…` | OK `e97b7128…` (rating 80 ≥ 60) |
| agent withdraws the position **to an attacker** | **OK `afd85af7…` — attacker 0 → 10 USDC** | `Error(Contract, #4109)` |
| agent `usdc.transfer(SA → attacker)` | — | `Error(Contract, #4113)` |
| agent borrows | — | `Error(Contract, #4111)` |
| rating drops to 30, agent supplies | — | `Error(Contract, #4115)` |
| rating 30, agent withdraws back to the SA | — | OK `18c14f1a…` |

---

## Known limitations / residual risk

* **Direct donation to an allowed recipient.** Under the USDC rule the
  agent can still call `usdc.transfer(SA, pool, x)` *directly*, without a
  matching `submit`. That gives USDC to the pool with nothing credited to
  the user. The spending cap bounds it per period, and the attacker gains
  nothing. A policy only sees one context per `enforce`, so stopping this
  would take a "ticket" recorded by the pool-rule `submit` and consumed by
  the nested `transfer` (temporary storage). That is not implemented.
* **Churn.** The agent can withdraw and re-supply as often as it likes.
  Funds only move between the SA and the rule's pool, and supplies use up
  the spending cap.
* **Registry trust.** Deposits are only as safe as the publisher set and the
  admin key. The testnet deployment is 1-of-1 with the deployer as
  publisher. Production needs independent publishers, threshold ≥ 2, and a
  multisig / contract admin.
* **The rating gate is per pool.** It covers the pool the rule targets. The
  guard does not pick pools, and it does not limit which reserve asset a
  Supply names: other assets need their own agent token rule, which the
  agent does not have.
* **Fail-closed on deposits.** If the registry is missing, broken or stale,
  deposits fail; withdrawals never do.
* **All rule signers are required.** The guard is not an M-of-N policy. On
  a multi-signer rule every signer must sign.
* **No upgrade path.** Fixing a guard bug means deploying a new guard, and
  each owner then runs `remove_policy` + `add_policy`.
