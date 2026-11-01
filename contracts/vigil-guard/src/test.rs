//! Unit tests: the policy is invoked directly (as the smart account would),
//! with `mock_all_auths` standing in for the smart account's own auth.
extern crate std;

use soroban_sdk::{
    auth::{Context, ContractContext, ContractExecutable, CreateContractHostFnContext},
    map, symbol_short,
    testutils::{Address as _, AuthorizedFunction, Events, Ledger},
    vec, Address, BytesN, Env, Event, IntoVal, Map, String, Symbol, Val, Vec,
};
use stellar_accounts::smart_account::{ContextRule, ContextRuleType, Signer};
use vigil_registry::{VigilRegistry, VigilRegistryClient};

use crate::{
    GuardError, Request, RiskGate, RiskGateClient, RiskGateEnforced, RiskGateInstalled, RiskGateParams,
    RiskGateUninstalled, MAX_RECIPIENTS,
};

const NOW: u64 = 1_700_000_000;
const MAX_AGE: u64 = 7_200;
const MIN_SCORE: u32 = 60;
const POOL_RULE: u32 = 1;
const USDC_RULE: u32 = 2;

struct T {
    e: Env,
    guard: Address,
    client: RiskGateClient<'static>,
    sa: Address,
    pool: Address,
    usdc: Address,
    agent: Signer,
    registry: Address,
    reg: VigilRegistryClient<'static>,
    publisher: Address,
}

fn setup() -> T {
    let e = Env::default();
    e.mock_all_auths();
    e.ledger().set_timestamp(NOW);
    let guard = e.register(RiskGate, ());
    let client = RiskGateClient::new(&e, &guard);
    let admin = Address::generate(&e);
    let registry = e.register(VigilRegistry, (admin, 1u32, 86_400u64));
    let reg = VigilRegistryClient::new(&e, &registry);
    let publisher = Address::generate(&e);
    reg.add_publisher(&publisher);
    let agent = Signer::Delegated(Address::generate(&e));
    T {
        sa: Address::generate(&e),
        pool: Address::generate(&e),
        usdc: Address::generate(&e),
        e,
        guard,
        client,
        agent,
        registry,
        reg,
        publisher,
    }
}

fn rule(t: &T, id: u32, target: &Address) -> ContextRule {
    ContextRule {
        id,
        context_type: ContextRuleType::CallContract(target.clone()),
        name: String::from_str(&t.e, "agent"),
        signers: vec![&t.e, t.agent.clone()],
        signer_ids: vec![&t.e, 1],
        policies: vec![&t.e, t.guard.clone()],
        policy_ids: vec![&t.e, 0],
        valid_until: None,
    }
}

fn pool_params(t: &T) -> RiskGateParams {
    RiskGateParams {
        registry: Some(t.registry.clone()),
        min_score: MIN_SCORE,
        max_age_secs: MAX_AGE,
        allowed_recipients: vec![&t.e],
    }
}

fn token_params(t: &T) -> RiskGateParams {
    RiskGateParams { registry: None, min_score: 0, max_age_secs: 0, allowed_recipients: vec![&t.e, t.pool.clone()] }
}

/// Installs the pool rule (rating-gated) and the USDC rule (recipient-pinned).
fn installed() -> T {
    let t = setup();
    t.client.install(&pool_params(&t), &rule(&t, POOL_RULE, &t.pool), &t.sa);
    t.client.install(&token_params(&t), &rule(&t, USDC_RULE, &t.usdc), &t.sa);
    t
}

fn publish(t: &T, score: u32, ts: u64) {
    t.reg.publish(&t.publisher, &t.pool, &score, &ts, &BytesN::from_array(&t.e, &[9; 32]));
}

fn req(t: &T, request_type: u32, amount: i128) -> Request {
    Request { address: t.usdc.clone(), amount, request_type }
}

fn call(t: &T, contract: &Address, fn_name: &str, args: Vec<Val>) -> Context {
    Context::Contract(ContractContext { contract: contract.clone(), fn_name: Symbol::new(&t.e, fn_name), args })
}

fn submit(t: &T, from: &Address, spender: &Address, to: &Address, reqs: std::vec::Vec<Request>) -> Context {
    let mut v = Vec::new(&t.e);
    for r in reqs {
        v.push_back(r);
    }
    call(t, &t.pool, "submit", (from.clone(), spender.clone(), to.clone(), v).into_val(&t.e))
}

fn self_submit(t: &T, reqs: std::vec::Vec<Request>) -> Context {
    submit(t, &t.sa, &t.sa, &t.sa, reqs)
}

fn transfer(t: &T, from: &Address, to: &Address, amount: i128) -> Context {
    call(t, &t.usdc, "transfer", (from.clone(), to.clone(), amount).into_val(&t.e))
}

fn signers(t: &T) -> Vec<Signer> {
    vec![&t.e, t.agent.clone()]
}

/// Enforce against the rule whose target matches the context's contract.
fn try_enforce(t: &T, ctx: &Context, rule_id: u32) -> Result<(), soroban_sdk::Error> {
    let target = if rule_id == USDC_RULE { &t.usdc } else { &t.pool };
    match t.client.try_enforce(ctx, &signers(t), &rule(t, rule_id, target), &t.sa) {
        Ok(Ok(())) => Ok(()),
        Err(Ok(e)) => Err(e),
        other => panic!("unexpected result {other:?}"),
    }
}

fn err(e: GuardError) -> Result<(), soroban_sdk::Error> {
    Err(e.into())
}

// ================================================================ install

#[test]
fn install_stores_params_requires_sa_auth_and_emits() {
    let t = setup();
    let r = rule(&t, POOL_RULE, &t.pool);
    t.client.install(&pool_params(&t), &r, &t.sa);
    let auths = t.e.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, t.sa);
    match &auths[0].1.function {
        AuthorizedFunction::Contract((c, f, _)) => {
            assert_eq!(c, &t.guard);
            assert_eq!(f, &symbol_short!("install"));
        }
        _ => panic!("expected contract auth"),
    }
    assert_eq!(
        t.e.events().all().filter_by_contract(&t.guard),
        [RiskGateInstalled { smart_account: t.sa.clone(), context_rule_id: POOL_RULE, params: pool_params(&t) }
            .to_xdr(&t.e, &t.guard)]
    );
    assert_eq!(t.client.get_params(&t.sa, &POOL_RULE), Some(pool_params(&t)));
    assert_eq!(t.client.get_params(&t.sa, &99), None);
}

#[test]
fn install_without_sa_auth_fails() {
    let t = setup();
    t.e.set_auths(&[]);
    assert!(t.client.try_install(&pool_params(&t), &rule(&t, POOL_RULE, &t.pool), &t.sa).is_err());
    assert_eq!(t.client.get_params(&t.sa, &POOL_RULE), None);
}

#[test]
fn install_rejects_reinstall() {
    let t = installed();
    assert_eq!(
        t.client.try_install(&pool_params(&t), &rule(&t, POOL_RULE, &t.pool), &t.sa),
        Err(Ok(GuardError::AlreadyInstalled.into()))
    );
}

#[test]
fn install_rejects_invalid_params() {
    let t = setup();
    let r = rule(&t, POOL_RULE, &t.pool);
    let bad = |p: RiskGateParams| {
        assert_eq!(t.client.try_install(&p, &r, &t.sa), Err(Ok(GuardError::InvalidParams.into())));
    };
    bad(RiskGateParams { min_score: 101, ..pool_params(&t) });
    bad(RiskGateParams { registry: None, min_score: 1, ..pool_params(&t) });
    bad(RiskGateParams { max_age_secs: 0, ..pool_params(&t) });
    let mut many = vec![&t.e];
    for _ in 0..(MAX_RECIPIENTS + 1) {
        many.push_back(Address::generate(&t.e));
    }
    bad(RiskGateParams { allowed_recipients: many, ..token_params(&t) });
    // Boundary values are accepted.
    t.client.install(&RiskGateParams { min_score: 100, ..pool_params(&t) }, &r, &t.sa);
}

#[test]
fn install_rejects_non_call_contract_rule() {
    let t = setup();
    let mut r = rule(&t, 0, &t.pool);
    r.context_type = ContextRuleType::Default;
    assert_eq!(t.client.try_install(&pool_params(&t), &r, &t.sa), Err(Ok(GuardError::OnlyCallContract.into())));
    r.context_type = ContextRuleType::CreateContract(BytesN::from_array(&t.e, &[1; 32]));
    assert_eq!(t.client.try_install(&pool_params(&t), &r, &t.sa), Err(Ok(GuardError::OnlyCallContract.into())));
}

#[test]
fn uninstall_removes_and_requires_installed() {
    let t = installed();
    let r = rule(&t, POOL_RULE, &t.pool);
    t.client.uninstall(&r, &t.sa);
    assert_eq!(t.e.auths()[0].0, t.sa);
    assert_eq!(
        t.e.events().all().filter_by_contract(&t.guard),
        [RiskGateUninstalled { smart_account: t.sa.clone(), context_rule_id: POOL_RULE }.to_xdr(&t.e, &t.guard)]
    );
    assert_eq!(t.client.get_params(&t.sa, &POOL_RULE), None);
    assert_eq!(t.client.try_uninstall(&r, &t.sa), Err(Ok(GuardError::NotInstalled.into())));
    // Enforce after uninstall fails closed.
    publish(&t, 90, NOW);
    assert_eq!(try_enforce(&t, &self_submit(&t, std::vec![req(&t, 2, 10)]), POOL_RULE), err(GuardError::NotInstalled));
    // Re-install after uninstall is allowed.
    t.client.install(&pool_params(&t), &r, &t.sa);
}

#[test]
fn uninstall_without_sa_auth_fails() {
    let t = installed();
    t.e.set_auths(&[]);
    assert!(t.client.try_uninstall(&rule(&t, POOL_RULE, &t.pool), &t.sa).is_err());
}

#[test]
fn params_are_per_account_and_rule() {
    let t = installed();
    let other_sa = Address::generate(&t.e);
    assert_eq!(t.client.get_params(&other_sa, &POOL_RULE), None);
    assert_eq!(t.client.get_params(&t.sa, &USDC_RULE), Some(token_params(&t)));
    // Another account is unaffected by t.sa's install.
    let r = rule(&t, POOL_RULE, &t.pool);
    assert_eq!(
        t.client.try_enforce(&submit(&t, &other_sa, &other_sa, &other_sa, std::vec![req(&t, 3, 1)]), &signers(&t), &r, &other_sa),
        Err(Ok(GuardError::NotInstalled.into()))
    );
}

// ================================================================ enforce: auth / signers

#[test]
fn enforce_requires_sa_auth() {
    let t = installed();
    publish(&t, 90, NOW);
    let ctx = self_submit(&t, std::vec![req(&t, 2, 100)]);
    t.client.enforce(&ctx, &signers(&t), &rule(&t, POOL_RULE, &t.pool), &t.sa);
    let auths = t.e.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, t.sa);

    t.e.set_auths(&[]);
    assert!(t.client.try_enforce(&ctx, &signers(&t), &rule(&t, POOL_RULE, &t.pool), &t.sa).is_err());
}

#[test]
fn enforce_rejects_empty_or_foreign_signers() {
    let t = installed();
    let ctx = self_submit(&t, std::vec![req(&t, 3, 1)]);
    let r = rule(&t, POOL_RULE, &t.pool);
    assert_eq!(t.client.try_enforce(&ctx, &vec![&t.e], &r, &t.sa), Err(Ok(GuardError::NoSigners.into())));
    let stranger = Signer::Delegated(Address::generate(&t.e));
    assert_eq!(t.client.try_enforce(&ctx, &vec![&t.e, stranger], &r, &t.sa), Err(Ok(GuardError::NoSigners.into())));
}

#[test]
fn enforce_requires_every_rule_signer() {
    let t = installed();
    let ctx = self_submit(&t, std::vec![req(&t, 3, 1)]);
    let second = Signer::Delegated(Address::generate(&t.e));
    let mut r = rule(&t, POOL_RULE, &t.pool);
    r.signers.push_back(second.clone());
    r.signer_ids.push_back(2);
    // Only one of the two rule signers authenticated.
    assert_eq!(t.client.try_enforce(&ctx, &signers(&t), &r, &t.sa), Err(Ok(GuardError::NoSigners.into())));
    // Both authenticated (order irrelevant).
    assert_eq!(t.client.try_enforce(&ctx, &vec![&t.e, second, t.agent.clone()], &r, &t.sa), Ok(Ok(())));
    // A policy-only rule (no signers) is never satisfied by the guard.
    r.signers = vec![&t.e];
    r.signer_ids = vec![&t.e];
    assert_eq!(t.client.try_enforce(&ctx, &signers(&t), &r, &t.sa), Err(Ok(GuardError::NoSigners.into())));
}

// ================================================================ enforce: submit

#[test]
fn supply_allowed_with_fresh_good_rating_and_emits() {
    let t = installed();
    publish(&t, 75, NOW - 60);
    let ctx = self_submit(&t, std::vec![req(&t, 2, 1_000_0000000)]);
    assert_eq!(try_enforce(&t, &ctx, POOL_RULE), Ok(()));
    t.client.enforce(&ctx, &signers(&t), &rule(&t, POOL_RULE, &t.pool), &t.sa);
    assert_eq!(
        t.e.events().all().filter_by_contract(&t.guard),
        [RiskGateEnforced {
            smart_account: t.sa.clone(),
            context_rule_id: POOL_RULE,
            contract: t.pool.clone(),
            fn_name: symbol_short!("submit"),
            deposit: true,
            score: Some(75),
        }
        .to_xdr(&t.e, &t.guard)]
    );
    // Plain Supply (0) as well.
    assert_eq!(try_enforce(&t, &self_submit(&t, std::vec![req(&t, 0, 5)]), POOL_RULE), Ok(()));
}

#[test]
fn rating_boundaries_inclusive() {
    let t = installed();
    publish(&t, MIN_SCORE, NOW - MAX_AGE);
    assert_eq!(try_enforce(&t, &self_submit(&t, std::vec![req(&t, 2, 1)]), POOL_RULE), Ok(()));
}

#[test]
fn withdraw_allowed_and_never_rating_gated() {
    let t = installed();
    let w = |t: &T| {
        assert_eq!(try_enforce(t, &self_submit(t, std::vec![req(t, 3, 50)]), POOL_RULE), Ok(()));
        assert_eq!(try_enforce(t, &self_submit(t, std::vec![req(t, 1, 50)]), POOL_RULE), Ok(()));
        assert_eq!(
            try_enforce(t, &self_submit(t, std::vec![req(t, 1, 1), req(t, 3, i128::MAX)]), POOL_RULE),
            Ok(())
        );
    };
    // No rating at all.
    w(&t);
    // Terrible rating.
    publish(&t, 0, NOW);
    w(&t);
    // Stale rating.
    t.e.ledger().set_timestamp(NOW + MAX_AGE + 1);
    w(&t);
}

#[test]
fn withdraw_event_has_no_score() {
    let t = installed();
    t.client.enforce(&self_submit(&t, std::vec![req(&t, 3, 1)]), &signers(&t), &rule(&t, POOL_RULE, &t.pool), &t.sa);
    assert_eq!(
        t.e.events().all().filter_by_contract(&t.guard),
        [RiskGateEnforced {
            smart_account: t.sa.clone(),
            context_rule_id: POOL_RULE,
            contract: t.pool.clone(),
            fn_name: symbol_short!("submit"),
            deposit: false,
            score: None,
        }
        .to_xdr(&t.e, &t.guard)]
    );
}

#[test]
fn drain_to_attacker_rejected() {
    let t = installed();
    let attacker = Address::generate(&t.e);
    for rt in [0u32, 1, 2, 3] {
        assert_eq!(
            try_enforce(&t, &submit(&t, &t.sa, &t.sa, &attacker, std::vec![req(&t, rt, 1)]), POOL_RULE),
            err(GuardError::AccountMismatch)
        );
    }
}

#[test]
fn from_or_spender_mismatch_rejected() {
    let t = installed();
    let x = Address::generate(&t.e);
    let r = std::vec![req(&t, 3, 1)];
    assert_eq!(try_enforce(&t, &submit(&t, &x, &t.sa, &t.sa, r.clone()), POOL_RULE), err(GuardError::AccountMismatch));
    assert_eq!(try_enforce(&t, &submit(&t, &t.sa, &x, &t.sa, r.clone()), POOL_RULE), err(GuardError::AccountMismatch));
    assert_eq!(try_enforce(&t, &submit(&t, &x, &x, &x, r), POOL_RULE), err(GuardError::AccountMismatch));
}

#[test]
fn borrow_repay_and_auctions_rejected() {
    let t = installed();
    publish(&t, 99, NOW);
    for rt in 4u32..=9 {
        assert_eq!(
            try_enforce(&t, &self_submit(&t, std::vec![req(&t, rt, 1)]), POOL_RULE),
            err(GuardError::RequestTypeNotAllowed),
            "request_type {rt}"
        );
    }
    assert_eq!(
        try_enforce(&t, &self_submit(&t, std::vec![req(&t, 10, 1)]), POOL_RULE),
        err(GuardError::RequestTypeNotAllowed)
    );
    // A forbidden request hidden behind an allowed one.
    assert_eq!(
        try_enforce(&t, &self_submit(&t, std::vec![req(&t, 2, 10), req(&t, 4, 5)]), POOL_RULE),
        err(GuardError::RequestTypeNotAllowed)
    );
}

#[test]
fn empty_and_negative_requests_rejected() {
    let t = installed();
    assert_eq!(try_enforce(&t, &self_submit(&t, std::vec![]), POOL_RULE), err(GuardError::EmptyRequests));
    assert_eq!(try_enforce(&t, &self_submit(&t, std::vec![req(&t, 3, -1)]), POOL_RULE), err(GuardError::NegativeAmount));
}

#[test]
fn deposit_blocked_without_rating() {
    let t = installed();
    assert_eq!(try_enforce(&t, &self_submit(&t, std::vec![req(&t, 2, 1)]), POOL_RULE), err(GuardError::RatingUnavailable));
    assert_eq!(try_enforce(&t, &self_submit(&t, std::vec![req(&t, 0, 1)]), POOL_RULE), err(GuardError::RatingUnavailable));
}

#[test]
fn deposit_blocked_by_low_score() {
    let t = installed();
    publish(&t, MIN_SCORE - 1, NOW);
    assert_eq!(try_enforce(&t, &self_submit(&t, std::vec![req(&t, 2, 1)]), POOL_RULE), err(GuardError::ScoreTooLow));
    // A withdraw bundled with a deposit does not unlock the deposit.
    assert_eq!(
        try_enforce(&t, &self_submit(&t, std::vec![req(&t, 3, 1), req(&t, 2, 1)]), POOL_RULE),
        err(GuardError::ScoreTooLow)
    );
}

#[test]
fn deposit_blocked_by_stale_rating() {
    let t = installed();
    publish(&t, 95, NOW);
    // Registry max_age is 1 day, the guard's is 2h: the guard's bound applies.
    t.e.ledger().set_timestamp(NOW + MAX_AGE + 1);
    assert!(t.reg.get_rating(&t.pool).is_some());
    assert_eq!(try_enforce(&t, &self_submit(&t, std::vec![req(&t, 2, 1)]), POOL_RULE), err(GuardError::RatingStale));
}

#[test]
fn deposit_blocked_when_registry_unreachable() {
    let t = setup();
    let bogus = Address::generate(&t.e); // not a contract
    let p = RiskGateParams { registry: Some(bogus), ..pool_params(&t) };
    t.client.install(&p, &rule(&t, POOL_RULE, &t.pool), &t.sa);
    assert_eq!(try_enforce(&t, &self_submit(&t, std::vec![req(&t, 2, 1)]), POOL_RULE), err(GuardError::RatingUnavailable));
    assert_eq!(try_enforce(&t, &self_submit(&t, std::vec![req(&t, 3, 1)]), POOL_RULE), Ok(()));
}

#[test]
fn deposit_ungated_without_registry() {
    let t = setup();
    let p = RiskGateParams { registry: None, min_score: 0, max_age_secs: 0, allowed_recipients: vec![&t.e] };
    t.client.install(&p, &rule(&t, POOL_RULE, &t.pool), &t.sa);
    assert_eq!(try_enforce(&t, &self_submit(&t, std::vec![req(&t, 2, 1)]), POOL_RULE), Ok(()));
    // ...but account pinning still applies.
    let attacker = Address::generate(&t.e);
    assert_eq!(
        try_enforce(&t, &submit(&t, &t.sa, &t.sa, &attacker, std::vec![req(&t, 3, 1)]), POOL_RULE),
        err(GuardError::AccountMismatch)
    );
}

#[test]
fn submit_with_allowance_same_rules() {
    let t = installed();
    publish(&t, 90, NOW);
    let attacker = Address::generate(&t.e);
    let mk = |to: &Address, rt: u32| {
        let v: Vec<Request> = vec![&t.e, req(&t, rt, 1)];
        call(&t, &t.pool, "submit_with_allowance", (t.sa.clone(), t.sa.clone(), to.clone(), v).into_val(&t.e))
    };
    assert_eq!(try_enforce(&t, &mk(&t.sa, 2), POOL_RULE), Ok(()));
    assert_eq!(try_enforce(&t, &mk(&t.sa, 3), POOL_RULE), Ok(()));
    assert_eq!(try_enforce(&t, &mk(&attacker, 3), POOL_RULE), err(GuardError::AccountMismatch));
    assert_eq!(try_enforce(&t, &mk(&t.sa, 4), POOL_RULE), err(GuardError::RequestTypeNotAllowed));
}

// ================================================================ enforce: claim

#[test]
fn claim_only_to_self() {
    let t = installed();
    let ids: Vec<u32> = vec![&t.e, 1, 3];
    let other = Address::generate(&t.e);
    let c = |from: &Address, to: &Address| call(&t, &t.pool, "claim", (from.clone(), ids.clone(), to.clone()).into_val(&t.e));
    assert_eq!(try_enforce(&t, &c(&t.sa, &t.sa), POOL_RULE), Ok(()));
    assert_eq!(try_enforce(&t, &c(&t.sa, &other), POOL_RULE), err(GuardError::AccountMismatch));
    assert_eq!(try_enforce(&t, &c(&other, &t.sa), POOL_RULE), err(GuardError::AccountMismatch));
    // Wrong arity / types.
    assert_eq!(
        try_enforce(&t, &call(&t, &t.pool, "claim", (t.sa.clone(), ids.clone()).into_val(&t.e)), POOL_RULE),
        err(GuardError::BadArgs)
    );
    let bad_ids: Vec<Address> = vec![&t.e, other.clone()];
    assert_eq!(
        try_enforce(&t, &call(&t, &t.pool, "claim", (t.sa.clone(), bad_ids, t.sa.clone()).into_val(&t.e)), POOL_RULE),
        err(GuardError::BadArgs)
    );
}

// ================================================================ enforce: token transfer

#[test]
fn token_transfer_to_pool_allowed() {
    let t = installed();
    assert_eq!(try_enforce(&t, &transfer(&t, &t.sa, &t.pool, 1_000), USDC_RULE), Ok(()));
    assert_eq!(try_enforce(&t, &transfer(&t, &t.sa, &t.pool, 0), USDC_RULE), Ok(()));
}

#[test]
fn token_transfer_to_non_allowed_recipient_rejected() {
    let t = installed();
    let attacker = Address::generate(&t.e);
    assert_eq!(try_enforce(&t, &transfer(&t, &t.sa, &attacker, 1), USDC_RULE), err(GuardError::RecipientNotAllowed));
    // Paying from someone else's balance via this rule is also rejected.
    assert_eq!(try_enforce(&t, &transfer(&t, &attacker, &t.pool, 1), USDC_RULE), err(GuardError::AccountMismatch));
    assert_eq!(try_enforce(&t, &transfer(&t, &t.sa, &t.pool, -1), USDC_RULE), err(GuardError::NegativeAmount));
}

#[test]
fn token_transfer_with_empty_allow_list_rejected() {
    let t = setup();
    let p = RiskGateParams { registry: None, min_score: 0, max_age_secs: 0, allowed_recipients: vec![&t.e] };
    t.client.install(&p, &rule(&t, USDC_RULE, &t.usdc), &t.sa);
    assert_eq!(try_enforce(&t, &transfer(&t, &t.sa, &t.pool, 1), USDC_RULE), err(GuardError::RecipientNotAllowed));
}

#[test]
fn token_other_functions_rejected() {
    let t = installed();
    let x = Address::generate(&t.e);
    let approve = call(&t, &t.usdc, "approve", (t.sa.clone(), x.clone(), 1i128, 100u32).into_val(&t.e));
    assert_eq!(try_enforce(&t, &approve, USDC_RULE), err(GuardError::FunctionNotAllowed));
    let burn = call(&t, &t.usdc, "burn", (t.sa.clone(), 1i128).into_val(&t.e));
    assert_eq!(try_enforce(&t, &burn, USDC_RULE), err(GuardError::FunctionNotAllowed));
    let tf = call(&t, &t.usdc, "transfer_from", (t.sa.clone(), t.sa.clone(), x, 1i128).into_val(&t.e));
    assert_eq!(try_enforce(&t, &tf, USDC_RULE), err(GuardError::FunctionNotAllowed));
}

// ================================================================ enforce: everything else

#[test]
fn pool_other_functions_rejected() {
    let t = installed();
    let fl = call(&t, &t.pool, "flash_loan", (t.sa.clone(), 0u32, 0u32).into_val(&t.e));
    assert_eq!(try_enforce(&t, &fl, POOL_RULE), err(GuardError::FunctionNotAllowed));
    let unknown = call(&t, &t.pool, "do_anything", vec![&t.e]);
    assert_eq!(try_enforce(&t, &unknown, POOL_RULE), err(GuardError::FunctionNotAllowed));
    // Transfer-shaped call against the pool rule: allow-list is empty there.
    assert_eq!(
        try_enforce(&t, &call(&t, &t.pool, "transfer", (t.sa.clone(), t.pool.clone(), 1i128).into_val(&t.e)), POOL_RULE),
        err(GuardError::RecipientNotAllowed)
    );
}

#[test]
fn create_contract_context_rejected() {
    let t = installed();
    let ctx = Context::CreateContractHostFn(CreateContractHostFnContext {
        executable: ContractExecutable::Wasm(BytesN::from_array(&t.e, &[1; 32])),
        salt: BytesN::from_array(&t.e, &[2; 32]),
    });
    assert_eq!(try_enforce(&t, &ctx, POOL_RULE), err(GuardError::ContextNotAllowed));
}

#[test]
fn context_contract_must_match_rule_target() {
    let t = installed();
    // A submit to some other contract presented under the pool rule.
    let other_pool = Address::generate(&t.e);
    let v: Vec<Request> = vec![&t.e, req(&t, 3, 1)];
    let ctx = call(&t, &other_pool, "submit", (t.sa.clone(), t.sa.clone(), t.sa.clone(), v).into_val(&t.e));
    assert_eq!(try_enforce(&t, &ctx, POOL_RULE), err(GuardError::WrongContract));
}

// ================================================================ enforce: malformed args

#[test]
fn submit_bad_arity_rejected() {
    let t = installed();
    let v: Vec<Request> = vec![&t.e, req(&t, 3, 1)];
    let three = call(&t, &t.pool, "submit", (t.sa.clone(), t.sa.clone(), v.clone()).into_val(&t.e));
    assert_eq!(try_enforce(&t, &three, POOL_RULE), err(GuardError::BadArgs));
    let five = call(&t, &t.pool, "submit", (t.sa.clone(), t.sa.clone(), t.sa.clone(), v, 1u32).into_val(&t.e));
    assert_eq!(try_enforce(&t, &five, POOL_RULE), err(GuardError::BadArgs));
    assert_eq!(try_enforce(&t, &call(&t, &t.pool, "submit", vec![&t.e]), POOL_RULE), err(GuardError::BadArgs));
}

#[test]
fn submit_bad_types_rejected() {
    let t = installed();
    let v: Vec<Request> = vec![&t.e, req(&t, 3, 1)];
    // from is a u32.
    let ctx = call(&t, &t.pool, "submit", (7u32, t.sa.clone(), t.sa.clone(), v.clone()).into_val(&t.e));
    assert_eq!(try_enforce(&t, &ctx, POOL_RULE), err(GuardError::BadArgs));
    // requests is not a vec.
    let ctx = call(&t, &t.pool, "submit", (t.sa.clone(), t.sa.clone(), t.sa.clone(), 5u32).into_val(&t.e));
    assert_eq!(try_enforce(&t, &ctx, POOL_RULE), err(GuardError::BadArgs));
    // requests is a vec of the wrong element type.
    let nums: Vec<u32> = vec![&t.e, 2, 2];
    let ctx = call(&t, &t.pool, "submit", (t.sa.clone(), t.sa.clone(), t.sa.clone(), nums).into_val(&t.e));
    assert_eq!(try_enforce(&t, &ctx, POOL_RULE), err(GuardError::BadArgs));
    // A request map with the right keys but a wrong value type (amount as u64).
    let bad: Map<Symbol, Val> = map![
        &t.e,
        (Symbol::new(&t.e, "address"), t.usdc.clone().into_val(&t.e)),
        (Symbol::new(&t.e, "amount"), 5u64.into_val(&t.e)),
        (Symbol::new(&t.e, "request_type"), 2u32.into_val(&t.e))
    ];
    let reqs: Vec<Val> = vec![&t.e, bad.into_val(&t.e)];
    let ctx = call(&t, &t.pool, "submit", (t.sa.clone(), t.sa.clone(), t.sa.clone(), reqs).into_val(&t.e));
    assert_eq!(try_enforce(&t, &ctx, POOL_RULE), err(GuardError::BadArgs));
    // A request map missing request_type.
    let short: Map<Symbol, Val> = map![
        &t.e,
        (Symbol::new(&t.e, "address"), t.usdc.clone().into_val(&t.e)),
        (Symbol::new(&t.e, "amount"), 5i128.into_val(&t.e))
    ];
    let reqs: Vec<Val> = vec![&t.e, short.into_val(&t.e)];
    let ctx = call(&t, &t.pool, "submit", (t.sa.clone(), t.sa.clone(), t.sa.clone(), reqs).into_val(&t.e));
    assert_eq!(try_enforce(&t, &ctx, POOL_RULE), err(GuardError::BadArgs));
    // A request map with an extra key.
    let extra: Map<Symbol, Val> = map![
        &t.e,
        (Symbol::new(&t.e, "address"), t.usdc.clone().into_val(&t.e)),
        (Symbol::new(&t.e, "amount"), 5i128.into_val(&t.e)),
        (Symbol::new(&t.e, "request_type"), 3u32.into_val(&t.e)),
        (Symbol::new(&t.e, "to"), t.usdc.clone().into_val(&t.e))
    ];
    let reqs: Vec<Val> = vec![&t.e, extra.into_val(&t.e)];
    let ctx = call(&t, &t.pool, "submit", (t.sa.clone(), t.sa.clone(), t.sa.clone(), reqs).into_val(&t.e));
    assert_eq!(try_enforce(&t, &ctx, POOL_RULE), err(GuardError::BadArgs));
    // A valid request followed by a malformed one.
    let good: Val = req(&t, 3, 1).into_val(&t.e);
    let reqs: Vec<Val> = vec![&t.e, good, 1u32.into_val(&t.e)];
    let ctx = call(&t, &t.pool, "submit", (t.sa.clone(), t.sa.clone(), t.sa.clone(), reqs).into_val(&t.e));
    assert_eq!(try_enforce(&t, &ctx, POOL_RULE), err(GuardError::BadArgs));
}

#[test]
fn request_encoding_matches_blend_shape() {
    // Blend V2 encodes Request as ScMap {address, amount, request_type}.
    let t = setup();
    let m: Map<Symbol, Val> = map![
        &t.e,
        (Symbol::new(&t.e, "address"), t.usdc.clone().into_val(&t.e)),
        (Symbol::new(&t.e, "amount"), 42i128.into_val(&t.e)),
        (Symbol::new(&t.e, "request_type"), 2u32.into_val(&t.e))
    ];
    let decoded: Request = soroban_sdk::FromVal::from_val(&t.e, &m.to_val());
    assert_eq!(decoded, req(&t, 2, 42));
}

#[test]
fn transfer_bad_args_rejected() {
    let t = installed();
    let two = call(&t, &t.usdc, "transfer", (t.sa.clone(), t.pool.clone()).into_val(&t.e));
    assert_eq!(try_enforce(&t, &two, USDC_RULE), err(GuardError::BadArgs));
    let wrong_amount = call(&t, &t.usdc, "transfer", (t.sa.clone(), t.pool.clone(), 5u64).into_val(&t.e));
    assert_eq!(try_enforce(&t, &wrong_amount, USDC_RULE), err(GuardError::BadArgs));
    let wrong_to = call(&t, &t.usdc, "transfer", (t.sa.clone(), 3u32, 5i128).into_val(&t.e));
    assert_eq!(try_enforce(&t, &wrong_to, USDC_RULE), err(GuardError::BadArgs));
}
