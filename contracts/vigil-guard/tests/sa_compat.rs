//! Compatibility with the REAL smart-account wasm deployed for YieldPilot
//! users on testnet (OZ stellar-accounts 0.7.x, soroban-sdk 26.0.1, sha256
//! e2f4ed54…a28d) and the real OZ spending-limit policy wasm used on the USDC
//! rule. The guard (built against stellar-accounts 0.8.0 types) is installed
//! through the SA's own `add_context_rule` / `add_policy`, and authorization
//! is driven through `__check_auth` exactly as the host does it.
extern crate std;

use ed25519_dalek::{Signer as _, SigningKey};
use soroban_sdk::{
    auth::{Context, ContractContext},
    contract, contractimpl, map, symbol_short,
    testutils::{Address as _, Ledger},
    vec,
    xdr::ToXdr,
    Address, Bytes, BytesN, Env, IntoVal, Map, String, Symbol, Val, Vec,
};
use stellar_accounts::{
    policies::spending_limit::SpendingLimitAccountParams,
    verifiers::{ed25519, Verifier},
};
use vigil_guard::{GuardError, Request, RiskGate, RiskGateClient, RiskGateParams};
use vigil_registry::{VigilRegistry, VigilRegistryClient};

mod sa {
    // The spec references the SDK's built-in auth `Context` by name.
    use soroban_sdk::auth::Context;
    soroban_sdk::contractimport!(file = "../testdata/oz_smart_account_0_7.wasm");
}
/// Real OZ 0.7 spending-limit policy wasm (the one on today's USDC rule).
/// Not `contractimport!`ed: its event type derives `Eq` over `auth::Context`,
/// which the SDK type does not implement. Its install params are the 0.8.0
/// `SpendingLimitAccountParams` (same shape), which doubles as a type check.
const SPEND_WASM: &[u8] = include_bytes!("../../testdata/oz_spending_limit_0_7.wasm");

/// Stock OZ ed25519 verifier (same logic as the deployed verifier contract).
#[contract]
struct Ed25519Verifier;

#[contractimpl]
impl Verifier for Ed25519Verifier {
    type KeyData = BytesN<32>;
    type SigData = BytesN<64>;

    fn verify(e: &Env, hash: Bytes, key_data: BytesN<32>, sig_data: BytesN<64>) -> bool {
        ed25519::verify(e, &hash, &key_data, &sig_data)
    }

    fn canonicalize_key(e: &Env, key_data: BytesN<32>) -> Bytes {
        ed25519::canonicalize_key(e, &key_data)
    }

    fn batch_canonicalize_key(e: &Env, keys: Vec<BytesN<32>>) -> Vec<Bytes> {
        ed25519::batch_canonicalize_key(e, &keys)
    }
}

const NOW: u64 = 1_700_000_000;
const AGENT_SEED: [u8; 32] = [42u8; 32];
const CAP: i128 = 500_0000000; // 500 USDC

struct W {
    e: Env,
    sa: Address,
    sa_client: sa::Client<'static>,
    guard: Address,
    pool: Address,
    usdc: Address,
    reg: VigilRegistryClient<'static>,
    publisher: Address,
    agent: sa::Signer,
    pool_rule: u32,
    usdc_rule: u32,
}

/// Deploys the real SA with a Delegated owner, then adds the two agent rules
/// the YieldPilot onboarding adds, with the guard attached:
///   pool rule: CallContract(pool), signer = agent, policies = {guard(rating)}
///   usdc rule: CallContract(usdc), signer = agent, policies = {spend-limit, guard(recipients=[pool])}
fn world(external_agent: bool) -> W {
    world_opts(external_agent, false)
}

/// Built wasm of this workspace's contracts (for the `--ignored` wasm test).
fn built_wasm(name: &str) -> std::vec::Vec<u8> {
    let p = std::format!("{}/../target/wasm32v1-none/release/{name}.wasm", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&p).unwrap_or_else(|_| panic!("{p} missing: run `stellar contract build` in contracts/ first"))
}

/// `compiled = true` registers vigil-guard and vigil-registry from their
/// built wasm instead of natively.
fn world_opts(external_agent: bool, compiled: bool) -> W {
    let e = Env::default();
    e.mock_all_auths();
    e.ledger().set_timestamp(NOW);
    e.ledger().set_sequence_number(1_000);

    let owner = Address::generate(&e);
    let sa = e.register(sa::WASM, (vec![&e, sa::Signer::Delegated(owner)], Map::<Address, Val>::new(&e)));
    let sa_client = sa::Client::new(&e, &sa);

    let admin = Address::generate(&e);
    let (guard, registry) = if compiled {
        let g = built_wasm("vigil_guard");
        let r = built_wasm("vigil_registry");
        (e.register(g.as_slice(), ()), e.register(r.as_slice(), (admin, 1u32, 7_200u64)))
    } else {
        (e.register(RiskGate, ()), e.register(VigilRegistry, (admin, 1u32, 7_200u64)))
    };
    let spend_policy = e.register(SPEND_WASM, ());
    let reg = VigilRegistryClient::new(&e, &registry);
    let publisher = Address::generate(&e);
    reg.add_publisher(&publisher);

    let pool = Address::generate(&e);
    let usdc = Address::generate(&e);

    let agent = if external_agent {
        let verifier = e.register(Ed25519Verifier, ());
        let pk = SigningKey::from_bytes(&AGENT_SEED).verifying_key().to_bytes();
        sa::Signer::External(verifier, Bytes::from_array(&e, &pk))
    } else {
        sa::Signer::Delegated(Address::generate(&e))
    };

    let pool_params = RiskGateParams {
        registry: Some(registry.clone()),
        min_score: 60,
        max_age_secs: 3_600,
        allowed_recipients: vec![&e],
    };
    let pool_rule = sa_client.add_context_rule(
        &sa::ContextRuleType::CallContract(pool.clone()),
        &String::from_str(&e, "vigil-pool"),
        &None,
        &vec![&e, agent.clone()],
        &map![&e, (guard.clone(), pool_params.into_val(&e))],
    );

    // USDC rule: created with the stock spending-limit policy (as onboarding
    // does today), then the guard is added via `add_policy`.
    let usdc_rule = sa_client.add_context_rule(
        &sa::ContextRuleType::CallContract(usdc.clone()),
        &String::from_str(&e, "vigil-usdc"),
        &None,
        &vec![&e, agent.clone()],
        &map![
            &e,
            (
                spend_policy.clone(),
                SpendingLimitAccountParams { spending_limit: CAP, period_ledgers: 17_280 }.into_val(&e)
            )
        ],
    );
    let token_params = RiskGateParams {
        registry: None,
        min_score: 0,
        max_age_secs: 0,
        allowed_recipients: vec![&e, pool.clone()],
    };
    sa_client.add_policy(&usdc_rule.id, &guard, &token_params.into_val(&e));

    // The guard really was installed through the SA.
    let g = RiskGateClient::new(&e, &guard);
    assert_eq!(g.get_params(&sa, &pool_rule.id), Some(pool_params));
    assert_eq!(g.get_params(&sa, &usdc_rule.id), Some(token_params));
    assert_eq!(sa_client.get_context_rule(&usdc_rule.id).policies.len(), 2);

    W { sa, sa_client, guard, pool, usdc, reg, publisher, agent, pool_rule: pool_rule.id, usdc_rule: usdc_rule.id, e }
}

fn rate(w: &W, score: u32) {
    w.reg.publish(&w.publisher, &w.pool, &score, &(NOW - 10), &BytesN::from_array(&w.e, &[1; 32]));
}

fn submit(w: &W, to: &Address, request_type: u32, amount: i128) -> Context {
    let reqs: Vec<Request> = vec![&w.e, Request { address: w.usdc.clone(), amount, request_type }];
    Context::Contract(ContractContext {
        contract: w.pool.clone(),
        fn_name: symbol_short!("submit"),
        args: (w.sa.clone(), w.sa.clone(), to.clone(), reqs).into_val(&w.e),
    })
}

fn transfer(w: &W, to: &Address, amount: i128) -> Context {
    Context::Contract(ContractContext {
        contract: w.usdc.clone(),
        fn_name: symbol_short!("transfer"),
        args: (w.sa.clone(), to.clone(), amount).into_val(&w.e),
    })
}

/// OZ 0.7 digest the agent signs (mirrors src/lib/smartAccount.ts):
/// sha256(signature_payload || xdr(ScVal::Vec[u32 rule ids])).
fn auth_digest(e: &Env, payload: &BytesN<32>, rule_ids: &Vec<u32>) -> [u8; 32] {
    let mut b = Bytes::from_array(e, &payload.to_array());
    b.append(&rule_ids.clone().to_xdr(e));
    e.crypto().sha256(&b).to_array()
}

fn payload_for(w: &W, rule_ids: &Vec<u32>, payload: &BytesN<32>, sign_over: Option<[u8; 32]>) -> sa::AuthPayload {
    let sig = match &w.agent {
        sa::Signer::Delegated(_) => Bytes::new(&w.e),
        sa::Signer::External(_, _) => {
            let digest = sign_over.unwrap_or_else(|| auth_digest(&w.e, payload, rule_ids));
            Bytes::from_array(&w.e, &SigningKey::from_bytes(&AGENT_SEED).sign(&digest).to_bytes())
        }
    };
    sa::AuthPayload { context_rule_ids: rule_ids.clone(), signers: map![&w.e, (w.agent.clone(), sig)] }
}

/// Runs `__check_auth` on the real SA. For the External agent no auth is
/// mocked at all: signature verification, `smart_account.require_auth()`
/// inside the policies and policy enforcement are all real.
fn check(w: &W, contexts: std::vec::Vec<Context>, rule_ids: std::vec::Vec<u32>) -> Result<(), soroban_sdk::Error> {
    check_with(w, contexts, rule_ids, None, None)
}

fn check_with(
    w: &W,
    contexts: std::vec::Vec<Context>,
    rule_ids: std::vec::Vec<u32>,
    override_payload: Option<sa::AuthPayload>,
    sign_over: Option<[u8; 32]>,
) -> Result<(), soroban_sdk::Error> {
    let e = &w.e;
    if matches!(w.agent, sa::Signer::External(_, _)) {
        e.set_auths(&[]); // enforcing mode, nothing mocked
    }
    let payload = BytesN::from_array(e, &[7u8; 32]);
    let mut ids = Vec::new(e);
    for i in rule_ids {
        ids.push_back(i);
    }
    let mut ctxs = Vec::new(e);
    for c in contexts {
        ctxs.push_back(c);
    }
    let ap = override_payload.unwrap_or_else(|| payload_for(w, &ids, &payload, sign_over));
    match e.try_invoke_contract_check_auth::<soroban_sdk::Error>(&w.sa, &payload, ap.into_val(e), &ctxs) {
        Ok(()) => Ok(()),
        Err(Ok(err)) => Err(err),
        Err(Err(inv)) => panic!("invoke error {inv:?}"),
    }
}

fn guard_err(code: GuardError) -> Result<(), soroban_sdk::Error> {
    Err(code.into())
}

// ------------------------------------------------------------ Delegated agent (mock_all_auths)

#[test]
fn delegated_legit_supply_passes_and_drain_fails() {
    let w = world(false);
    rate(&w, 80);
    assert_eq!(check(&w, std::vec![submit(&w, &w.sa, 2, 100)], std::vec![w.pool_rule]), Ok(()));
    let attacker = Address::generate(&w.e);
    assert_eq!(
        check(&w, std::vec![submit(&w, &attacker, 3, i128::MAX)], std::vec![w.pool_rule]),
        guard_err(GuardError::AccountMismatch)
    );
}

#[test]
fn delegated_withdraw_passes_even_with_bad_rating() {
    let w = world(false);
    rate(&w, 5);
    assert_eq!(check(&w, std::vec![submit(&w, &w.sa, 3, 100)], std::vec![w.pool_rule]), Ok(()));
    assert_eq!(
        check(&w, std::vec![submit(&w, &w.sa, 2, 100)], std::vec![w.pool_rule]),
        guard_err(GuardError::ScoreTooLow)
    );
}

// ------------------------------------------------------------ External ed25519 agent (production path)

#[test]
fn external_supply_with_nested_usdc_transfer_passes() {
    let w = world(true);
    rate(&w, 80);
    // What the host hands __check_auth for pool.submit(Supply): the submit
    // context plus the pool's nested usdc.transfer(sa -> pool).
    assert_eq!(
        check(
            &w,
            std::vec![submit(&w, &w.sa, 2, 100_0000000), transfer(&w, &w.pool, 100_0000000)],
            std::vec![w.pool_rule, w.usdc_rule],
        ),
        Ok(())
    );
}

#[test]
fn external_withdraw_passes_without_any_rating() {
    let w = world(true);
    assert_eq!(check(&w, std::vec![submit(&w, &w.sa, 3, 100)], std::vec![w.pool_rule]), Ok(()));
}

#[test]
fn external_drain_via_pool_to_attacker_fails() {
    let w = world(true);
    rate(&w, 99);
    let attacker = Address::generate(&w.e);
    assert_eq!(
        check(&w, std::vec![submit(&w, &attacker, 3, i128::MAX)], std::vec![w.pool_rule]),
        guard_err(GuardError::AccountMismatch)
    );
    assert_eq!(
        check(&w, std::vec![submit(&w, &attacker, 1, 1)], std::vec![w.pool_rule]),
        guard_err(GuardError::AccountMismatch)
    );
}

#[test]
fn external_claim_to_attacker_fails() {
    let w = world(true);
    let attacker = Address::generate(&w.e);
    let ids: Vec<u32> = vec![&w.e, 1];
    let ctx = |to: &Address| {
        Context::Contract(ContractContext {
            contract: w.pool.clone(),
            fn_name: symbol_short!("claim"),
            args: (w.sa.clone(), ids.clone(), to.clone()).into_val(&w.e),
        })
    };
    assert_eq!(check(&w, std::vec![ctx(&attacker)], std::vec![w.pool_rule]), guard_err(GuardError::AccountMismatch));
    assert_eq!(check(&w, std::vec![ctx(&w.sa)], std::vec![w.pool_rule]), Ok(()));
}

#[test]
fn external_borrow_and_flash_loan_fail() {
    let w = world(true);
    rate(&w, 99);
    assert_eq!(
        check(&w, std::vec![submit(&w, &w.sa, 4, 1)], std::vec![w.pool_rule]),
        guard_err(GuardError::RequestTypeNotAllowed)
    );
    let fl = Context::Contract(ContractContext {
        contract: w.pool.clone(),
        fn_name: Symbol::new(&w.e, "flash_loan"),
        args: (w.sa.clone(), 0u32).into_val(&w.e),
    });
    assert_eq!(check(&w, std::vec![fl], std::vec![w.pool_rule]), guard_err(GuardError::FunctionNotAllowed));
}

#[test]
fn external_direct_usdc_transfer_to_attacker_fails() {
    let w = world(true);
    let attacker = Address::generate(&w.e);
    // Within the spending cap, so only the guard stands in the way.
    assert_eq!(
        check(&w, std::vec![transfer(&w, &attacker, 1_0000000)], std::vec![w.usdc_rule]),
        guard_err(GuardError::RecipientNotAllowed)
    );
    let approve = Context::Contract(ContractContext {
        contract: w.usdc.clone(),
        fn_name: symbol_short!("approve"),
        args: (w.sa.clone(), attacker, 1i128, 2_000u32).into_val(&w.e),
    });
    assert_eq!(check(&w, std::vec![approve], std::vec![w.usdc_rule]), Err(soroban_sdk::Error::from_contract_error(3223)));
}

#[test]
fn external_spending_cap_still_enforced_alongside_guard() {
    let w = world(true);
    rate(&w, 80);
    let r = check(
        &w,
        std::vec![submit(&w, &w.sa, 2, CAP + 1), transfer(&w, &w.pool, CAP + 1)],
        std::vec![w.pool_rule, w.usdc_rule],
    );
    // OZ SpendingLimitError::SpendingLimitExceeded
    assert_eq!(r, Err(soroban_sdk::Error::from_contract_error(3221)));
}

#[test]
fn external_deposit_blocked_by_missing_low_and_stale_rating() {
    let w = world(true);
    let dep = || std::vec![submit(&w, &w.sa, 2, 10), transfer(&w, &w.pool, 10)];
    let ids = || std::vec![w.pool_rule, w.usdc_rule];
    assert_eq!(check(&w, dep(), ids()), guard_err(GuardError::RatingUnavailable));
    w.e.mock_all_auths();
    rate(&w, 59);
    assert_eq!(check(&w, dep(), ids()), guard_err(GuardError::ScoreTooLow));
    w.e.mock_all_auths();
    w.e.ledger().set_timestamp(NOW + 1);
    w.reg.publish(&w.publisher, &w.pool, &90, &(NOW + 1), &BytesN::from_array(&w.e, &[2; 32]));
    assert_eq!(check(&w, dep(), ids()), Ok(()));
    // Guard max_age is 1h (registry allows 2h): 1h+1s later the deposit is blocked...
    w.e.ledger().set_timestamp(NOW + 1 + 3_601);
    assert_eq!(check(&w, dep(), ids()), guard_err(GuardError::RatingStale));
    // ...but withdrawing is still fine.
    assert_eq!(check(&w, std::vec![submit(&w, &w.sa, 3, 10)], std::vec![w.pool_rule]), Ok(()));
}

#[test]
fn external_bad_signature_rejected_before_policy() {
    let w = world(true);
    rate(&w, 80);
    let r = check_with(&w, std::vec![submit(&w, &w.sa, 3, 1)], std::vec![w.pool_rule], None, Some([0u8; 32]));
    assert!(r.is_err());
    assert_ne!(r, guard_err(GuardError::AccountMismatch));
}

#[test]
fn external_no_signers_rejected_by_guard() {
    // A policy-bearing rule defers signer checks to its policies: an
    // AuthPayload with NO signatures must still be rejected (by the guard).
    let w = world(true);
    let ids: Vec<u32> = vec![&w.e, w.pool_rule];
    let empty = sa::AuthPayload { context_rule_ids: ids, signers: Map::new(&w.e) };
    let r = check_with(&w, std::vec![submit(&w, &w.sa, 3, 1)], std::vec![w.pool_rule], Some(empty), None);
    assert_eq!(r, guard_err(GuardError::NoSigners));
}

#[test]
fn removing_rule_through_sa_uninstalls_guard() {
    let w = world(true);
    w.e.mock_all_auths();
    w.sa_client.remove_context_rule(&w.pool_rule);
    assert_eq!(RiskGateClient::new(&w.e, &w.guard).get_params(&w.sa, &w.pool_rule), None);
}

#[test]
fn external_path_really_runs_in_enforcing_mode() {
    // Sanity for the External tests above: once `check` switches to
    // enforcing mode, an owner-only SA call without auth entries fails.
    let w = world(true);
    rate(&w, 80);
    assert_eq!(check(&w, std::vec![submit(&w, &w.sa, 3, 1)], std::vec![w.pool_rule]), Ok(()));
    assert!(w.sa_client.try_remove_context_rule(&w.pool_rule).is_err());
}

#[test]
fn foreign_signer_rejected() {
    // A signer that is not on the pool rule cannot use it, even though the
    // rule defers signer checks to its policies.
    let w = world(false);
    let stranger = sa::Signer::Delegated(Address::generate(&w.e));
    let ids: Vec<u32> = vec![&w.e, w.pool_rule];
    let ap = sa::AuthPayload { context_rule_ids: ids, signers: map![&w.e, (stranger, Bytes::new(&w.e))] };
    let r = check_with(&w, std::vec![submit(&w, &w.sa, 3, 1)], std::vec![w.pool_rule], Some(ap), None);
    assert!(r.is_err(), "foreign signer accepted");
    std::println!("foreign signer rejected with {r:?}");
}

/// Same scenarios with the COMPILED guard + registry wasm (what is deployed).
/// Run after `stellar contract build`: `cargo test -- --ignored`.
#[test]
#[ignore = "needs target/wasm32v1-none/release/*.wasm (stellar contract build)"]
fn compiled_wasm_against_real_sa() {
    let w = world_opts(true, true);
    w.e.mock_all_auths();
    rate(&w, 80);
    let attacker = Address::generate(&w.e);
    assert_eq!(
        check(&w, std::vec![submit(&w, &w.sa, 2, 100), transfer(&w, &w.pool, 100)], std::vec![w.pool_rule, w.usdc_rule]),
        Ok(())
    );
    assert_eq!(check(&w, std::vec![submit(&w, &attacker, 3, 1)], std::vec![w.pool_rule]), guard_err(GuardError::AccountMismatch));
    assert_eq!(check(&w, std::vec![transfer(&w, &attacker, 1)], std::vec![w.usdc_rule]), guard_err(GuardError::RecipientNotAllowed));
    assert_eq!(check(&w, std::vec![submit(&w, &w.sa, 4, 1)], std::vec![w.pool_rule]), guard_err(GuardError::RequestTypeNotAllowed));
    w.e.mock_all_auths();
    w.e.ledger().set_timestamp(NOW + 3_600);
    assert_eq!(
        check(&w, std::vec![submit(&w, &w.sa, 2, 100), transfer(&w, &w.pool, 100)], std::vec![w.pool_rule, w.usdc_rule]),
        guard_err(GuardError::RatingStale)
    );
    assert_eq!(check(&w, std::vec![submit(&w, &w.sa, 3, 100)], std::vec![w.pool_rule]), Ok(()));
}
