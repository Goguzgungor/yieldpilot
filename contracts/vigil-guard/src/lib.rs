//! # Vigil RiskGate (`vigil-guard`)
//!
//! A shared, multi-tenant, admin-less OpenZeppelin smart-account **policy**
//! (`stellar_accounts::policies::Policy`). Attach it to the context rules
//! under which an automated agent key may act on a user's smart account:
//!
//! * on the `CallContract(BLEND_POOL)` rule it only allows the agent to
//!   `submit` / `submit_with_allowance` **self-directed** Supply / Withdraw /
//!   SupplyCollateral / WithdrawCollateral requests (`from == spender == to ==
//!   smart_account`) and `claim` emissions to the account itself; deposits
//!   additionally require a fresh registry rating `>= min_score`;
//!   withdrawals are never rating-gated;
//! * on the `CallContract(TOKEN)` rule it only allows
//!   `transfer(smart_account, to ∈ allowed_recipients, amount >= 0)`.
//!
//! Everything else (approve, flash_loan, borrow, auctions, unknown functions,
//! contract-creation contexts) is rejected.
//!
//! Parameters are stored per `(smart_account, context_rule_id)`; the contract
//! has no admin and no upgrade path.
#![no_std]

use soroban_sdk::{
    auth::{Context, ContractContext},
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error,
    symbol_short, Address, Env, Map, Symbol, TryFromVal, Val, Vec,
};
use stellar_accounts::{
    policies::Policy,
    smart_account::{ContextRule, ContextRuleType, Signer},
};
pub use vigil_interface::{Rating, RiskRegistryClient, MAX_SCORE};

/// Upper bound on `allowed_recipients` (bounds the `contains` scan).
pub const MAX_RECIPIENTS: u32 = 8;

/// Blend V2 request types the agent may submit.
pub const REQ_SUPPLY: u32 = 0;
pub const REQ_WITHDRAW: u32 = 1;
pub const REQ_SUPPLY_COLLATERAL: u32 = 2;
pub const REQ_WITHDRAW_COLLATERAL: u32 = 3;

const DAY_IN_LEDGERS: u32 = 17_280;
const PARAMS_EXTEND: u32 = 30 * DAY_IN_LEDGERS;
const PARAMS_THRESHOLD: u32 = PARAMS_EXTEND - DAY_IN_LEDGERS;
const INSTANCE_EXTEND: u32 = 30 * DAY_IN_LEDGERS;
const INSTANCE_THRESHOLD: u32 = INSTANCE_EXTEND - DAY_IN_LEDGERS;

// ---------------------------------------------------------------- types

/// Install parameters, passed as `install_param` to the smart account's
/// `add_policy` / `add_context_rule`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RiskGateParams {
    /// RiskRegistry used to gate deposits. `None` = no rating gate (account
    /// pinning still applies). When `None`, `min_score` must be 0.
    pub registry: Option<Address>,
    /// Minimum aggregated score (0..=100) for a deposit to be allowed.
    pub min_score: u32,
    /// Maximum age of the rating (`now - rating.timestamp`), seconds. Must be
    /// > 0 when a registry is set.
    pub max_age_secs: u64,
    /// Token rules only: who `transfer` may pay (the pool(s)). Empty = no
    /// transfer allowed. At most `MAX_RECIPIENTS`.
    pub allowed_recipients: Vec<Address>,
}

/// Mirror of Blend V2 `Request` (encodes as the same ScMap).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Request {
    pub address: Address,
    pub amount: i128,
    pub request_type: u32,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum GuardError {
    /// No params stored for (smart_account, context_rule_id).
    NotInstalled = 4100,
    /// Already installed for (smart_account, context_rule_id).
    AlreadyInstalled = 4101,
    /// min_score > 100, min_score > 0 without registry, max_age 0 with
    /// registry, or too many recipients.
    InvalidParams = 4102,
    /// Policy can only be attached to `CallContract(_)` rules.
    OnlyCallContract = 4103,
    /// Rule has no signers, or not every rule signer authenticated.
    NoSigners = 4104,
    /// Not a contract-call context (e.g. contract creation).
    ContextNotAllowed = 4105,
    /// Called contract differs from the rule's `CallContract` target.
    WrongContract = 4106,
    /// Function name is not on the allow-list.
    FunctionNotAllowed = 4107,
    /// Wrong arity or argument types.
    BadArgs = 4108,
    /// from / spender / to is not the smart account.
    AccountMismatch = 4109,
    /// `submit` with an empty request list.
    EmptyRequests = 4110,
    /// Request type outside {0,1,2,3} (borrow, repay, auctions, ...).
    RequestTypeNotAllowed = 4111,
    /// Negative amount.
    NegativeAmount = 4112,
    /// Token transfer recipient not in `allowed_recipients`.
    RecipientNotAllowed = 4113,
    /// Deposit gated but the registry returned no rating (or failed).
    RatingUnavailable = 4114,
    /// Deposit gated and rating score < min_score.
    ScoreTooLow = 4115,
    /// Deposit gated and rating older than max_age_secs.
    RatingStale = 4116,
}

#[contracttype]
#[derive(Clone)]
enum GuardKey {
    Params(Address, u32),
}

// ---------------------------------------------------------------- events

#[contractevent]
#[derive(Clone, Debug)]
pub struct RiskGateInstalled {
    #[topic]
    pub smart_account: Address,
    pub context_rule_id: u32,
    pub params: RiskGateParams,
}

#[contractevent]
#[derive(Clone, Debug)]
pub struct RiskGateUninstalled {
    #[topic]
    pub smart_account: Address,
    pub context_rule_id: u32,
}

#[contractevent]
#[derive(Clone, Debug)]
pub struct RiskGateEnforced {
    #[topic]
    pub smart_account: Address,
    pub context_rule_id: u32,
    pub contract: Address,
    pub fn_name: Symbol,
    /// True when a deposit request (0 or 2) was present.
    pub deposit: bool,
    /// The rating score checked, when the deposit was rating-gated.
    pub score: Option<u32>,
}

// ---------------------------------------------------------------- helpers

fn bump_instance(e: &Env) {
    e.storage().instance().extend_ttl(INSTANCE_THRESHOLD, INSTANCE_EXTEND);
}

fn load_params(e: &Env, smart_account: &Address, rule_id: u32) -> RiskGateParams {
    let key = GuardKey::Params(smart_account.clone(), rule_id);
    match e.storage().persistent().get::<_, RiskGateParams>(&key) {
        Some(p) => {
            e.storage().persistent().extend_ttl(&key, PARAMS_THRESHOLD, PARAMS_EXTEND);
            p
        }
        None => panic_with_error!(e, GuardError::NotInstalled),
    }
}

fn arg<T: TryFromVal<Env, Val>>(e: &Env, args: &Vec<Val>, i: u32) -> T {
    let v = match args.get(i) {
        Some(v) => v,
        None => panic_with_error!(e, GuardError::BadArgs),
    };
    T::try_from_val(e, &v).unwrap_or_else(|_| panic_with_error!(e, GuardError::BadArgs))
}

fn require_arity(e: &Env, args: &Vec<Val>, n: u32) {
    if args.len() != n {
        panic_with_error!(e, GuardError::BadArgs);
    }
}

fn require_self(e: &Env, a: &Address, smart_account: &Address) {
    if a != smart_account {
        panic_with_error!(e, GuardError::AccountMismatch);
    }
}

/// Strict decode of one Blend `Request`: exactly the three keys
/// {address, amount, request_type} with the right types. (SDK 28 struct
/// decoding is sparse and would ignore extra keys; Blend's is strict.)
fn decode_request(e: &Env, v: &Val) -> Request {
    let m = Map::<Val, Val>::try_from_val(e, v).unwrap_or_else(|_| panic_with_error!(e, GuardError::BadArgs));
    if m.len() != 3 {
        panic_with_error!(e, GuardError::BadArgs);
    }
    Request::try_from_val(e, v).unwrap_or_else(|_| panic_with_error!(e, GuardError::BadArgs))
}

/// `submit(from, spender, to, requests)` and
/// `submit_with_allowance(from, spender, to, requests)`.
/// Returns (has_deposit, rating_score_checked).
fn enforce_submit(
    e: &Env,
    args: &Vec<Val>,
    smart_account: &Address,
    pool: &Address,
    params: &RiskGateParams,
) -> (bool, Option<u32>) {
    require_arity(e, args, 4);
    let from: Address = arg(e, args, 0);
    let spender: Address = arg(e, args, 1);
    let to: Address = arg(e, args, 2);
    require_self(e, &from, smart_account);
    require_self(e, &spender, smart_account);
    require_self(e, &to, smart_account);

    let requests: Vec<Val> = arg(e, args, 3);
    if requests.is_empty() {
        panic_with_error!(e, GuardError::EmptyRequests);
    }
    let mut deposit = false;
    for v in requests.iter() {
        let r = decode_request(e, &v);
        match r.request_type {
            REQ_SUPPLY | REQ_SUPPLY_COLLATERAL => deposit = true,
            REQ_WITHDRAW | REQ_WITHDRAW_COLLATERAL => {}
            _ => panic_with_error!(e, GuardError::RequestTypeNotAllowed),
        }
        if r.amount < 0 {
            panic_with_error!(e, GuardError::NegativeAmount);
        }
    }

    // Withdrawals are never rating-gated: users must always be able to exit.
    let score = match (&params.registry, deposit) {
        (Some(registry), true) => Some(check_rating(e, registry, pool, params)),
        _ => None,
    };
    (deposit, score)
}

fn check_rating(e: &Env, registry: &Address, pool: &Address, params: &RiskGateParams) -> u32 {
    let rating = match RiskRegistryClient::new(e, registry).try_get_rating(pool) {
        Ok(Ok(Some(r))) => r,
        _ => panic_with_error!(e, GuardError::RatingUnavailable),
    };
    if rating.score < params.min_score {
        panic_with_error!(e, GuardError::ScoreTooLow);
    }
    let now = e.ledger().timestamp();
    if rating.timestamp > now || now - rating.timestamp > params.max_age_secs {
        panic_with_error!(e, GuardError::RatingStale);
    }
    rating.score
}

/// Blend `claim(from, reserve_token_ids, to)`.
fn enforce_claim(e: &Env, args: &Vec<Val>, smart_account: &Address) {
    require_arity(e, args, 3);
    let from: Address = arg(e, args, 0);
    let ids: Vec<u32> = arg(e, args, 1);
    for id in ids.try_iter() {
        if id.is_err() {
            panic_with_error!(e, GuardError::BadArgs);
        }
    }
    let to: Address = arg(e, args, 2);
    require_self(e, &from, smart_account);
    require_self(e, &to, smart_account);
}

/// SEP-41 `transfer(from, to, amount)`. A muxed `to` does not decode as a
/// plain `Address` and is rejected with `BadArgs`.
fn enforce_transfer(e: &Env, args: &Vec<Val>, smart_account: &Address, params: &RiskGateParams) {
    require_arity(e, args, 3);
    let from: Address = arg(e, args, 0);
    let to: Address = arg(e, args, 1);
    let amount: i128 = arg(e, args, 2);
    require_self(e, &from, smart_account);
    if !params.allowed_recipients.contains(&to) {
        panic_with_error!(e, GuardError::RecipientNotAllowed);
    }
    if amount < 0 {
        panic_with_error!(e, GuardError::NegativeAmount);
    }
}

fn validate_params(e: &Env, p: &RiskGateParams) {
    let bad = p.min_score > MAX_SCORE
        || (p.registry.is_none() && p.min_score != 0)
        || (p.registry.is_some() && p.max_age_secs == 0)
        || p.allowed_recipients.len() > MAX_RECIPIENTS;
    if bad {
        panic_with_error!(e, GuardError::InvalidParams);
    }
}

// ---------------------------------------------------------------- contract

#[contract]
pub struct RiskGate;

#[contractimpl]
impl RiskGate {
    /// Stored params for (smart_account, context_rule_id), if installed.
    pub fn get_params(e: Env, smart_account: Address, context_rule_id: u32) -> Option<RiskGateParams> {
        e.storage().persistent().get(&GuardKey::Params(smart_account, context_rule_id))
    }
}

#[contractimpl]
impl Policy for RiskGate {
    type AccountParams = RiskGateParams;

    fn enforce(
        e: &Env,
        context: Context,
        authenticated_signers: Vec<Signer>,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        smart_account.require_auth();

        // A rule with policies has its signer check deferred to the policies
        // by the smart account. Require what a policy-less rule requires:
        // EVERY rule signer authenticated (and at least one), so attaching
        // this guard never loosens a rule's signer requirement.
        if context_rule.signers.is_empty()
            || authenticated_signers.is_empty()
            || !context_rule.signers.iter().all(|s| authenticated_signers.contains(&s))
        {
            panic_with_error!(e, GuardError::NoSigners);
        }

        let params = load_params(e, &smart_account, context_rule.id);

        let ContractContext { contract, fn_name, args } = match context {
            Context::Contract(c) => c,
            _ => panic_with_error!(e, GuardError::ContextNotAllowed),
        };

        // Defence in depth: the SA already matched the rule's context type.
        match &context_rule.context_type {
            ContextRuleType::CallContract(target) if *target == contract => {}
            _ => panic_with_error!(e, GuardError::WrongContract),
        }

        let (deposit, score) = if fn_name == symbol_short!("submit")
            || fn_name == Symbol::new(e, "submit_with_allowance")
        {
            enforce_submit(e, &args, &smart_account, &contract, &params)
        } else if fn_name == symbol_short!("claim") {
            enforce_claim(e, &args, &smart_account);
            (false, None)
        } else if fn_name == symbol_short!("transfer") {
            enforce_transfer(e, &args, &smart_account, &params);
            (false, None)
        } else {
            panic_with_error!(e, GuardError::FunctionNotAllowed)
        };

        bump_instance(e);
        RiskGateEnforced {
            smart_account,
            context_rule_id: context_rule.id,
            contract,
            fn_name,
            deposit,
            score,
        }
        .publish(e);
    }

    fn install(e: &Env, install_params: RiskGateParams, context_rule: ContextRule, smart_account: Address) {
        smart_account.require_auth();

        if !matches!(context_rule.context_type, ContextRuleType::CallContract(_)) {
            panic_with_error!(e, GuardError::OnlyCallContract);
        }
        validate_params(e, &install_params);

        let key = GuardKey::Params(smart_account.clone(), context_rule.id);
        if e.storage().persistent().has(&key) {
            panic_with_error!(e, GuardError::AlreadyInstalled);
        }
        e.storage().persistent().set(&key, &install_params);
        e.storage().persistent().extend_ttl(&key, PARAMS_THRESHOLD, PARAMS_EXTEND);
        bump_instance(e);

        RiskGateInstalled { smart_account, context_rule_id: context_rule.id, params: install_params }.publish(e);
    }

    fn uninstall(e: &Env, context_rule: ContextRule, smart_account: Address) {
        smart_account.require_auth();

        let key = GuardKey::Params(smart_account.clone(), context_rule.id);
        if !e.storage().persistent().has(&key) {
            panic_with_error!(e, GuardError::NotInstalled);
        }
        e.storage().persistent().remove(&key);

        RiskGateUninstalled { smart_account, context_rule_id: context_rule.id }.publish(e);
    }
}

#[cfg(test)]
mod test;
