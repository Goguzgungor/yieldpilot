//! # Vigil RiskRegistry
//!
//! Publishers sign per-pool risk ratings (0..=100, higher = safer); consumers
//! (e.g. the `vigil-guard` policy) read an M-of-N aggregate:
//!
//! * only submissions from **currently registered** publishers count,
//! * only **fresh** ones (`now - timestamp <= max_age_secs`),
//! * `None` unless at least `threshold` such submissions exist,
//! * score = median (lower middle for an even count: conservative),
//! * timestamp = the **oldest** timestamp among the used submissions.
//!
//! The publisher set is capped at [`MAX_PUBLISHERS`] so `get_rating` has a
//! bounded read cost (it is called inside smart-account auth).
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, Address,
    BytesN, Env, Vec,
};
pub use vigil_interface::{Rating, RatingInput, RiskRegistryInterface, Submission, MAX_SCORE};

/// Upper bound on the publisher set (bounds `get_rating` cost).
pub const MAX_PUBLISHERS: u32 = 16;
/// Upper bound on one `publish_batch` call.
pub const MAX_BATCH: u32 = 32;

const DAY_IN_LEDGERS: u32 = 17_280;
const INSTANCE_EXTEND: u32 = 30 * DAY_IN_LEDGERS;
const INSTANCE_THRESHOLD: u32 = INSTANCE_EXTEND - DAY_IN_LEDGERS;
const SUBMISSION_EXTEND: u32 = 30 * DAY_IN_LEDGERS;
const SUBMISSION_THRESHOLD: u32 = SUBMISSION_EXTEND - DAY_IN_LEDGERS;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum RegistryError {
    /// Caller / argument is not a registered publisher.
    NotPublisher = 4200,
    /// Publisher is already registered.
    AlreadyPublisher = 4201,
    /// Publisher set would exceed `MAX_PUBLISHERS`.
    TooManyPublishers = 4202,
    /// Threshold must be in `1..=MAX_PUBLISHERS`.
    InvalidThreshold = 4203,
    /// `max_age_secs` must be > 0.
    InvalidMaxAge = 4204,
    /// Score must be `<= 100`.
    InvalidScore = 4205,
    /// Submission timestamp is after the ledger timestamp.
    FutureTimestamp = 4206,
    /// Submission is already older than `max_age_secs`.
    StaleTimestamp = 4207,
    /// Publisher already has a submission for this pool at the same or a later timestamp.
    NotNewer = 4208,
    /// `publish_batch` with no entries.
    EmptyBatch = 4209,
    /// `publish_batch` with more than `MAX_BATCH` entries.
    BatchTooLarge = 4210,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    Threshold,
    MaxAge,
    Publishers,
    /// (pool, publisher) -> Submission
    Submission(Address, Address),
}

// ---------------------------------------------------------------- events

#[contractevent]
#[derive(Clone, Debug)]
pub struct RatingPublished {
    #[topic]
    pub pool: Address,
    #[topic]
    pub publisher: Address,
    pub score: u32,
    pub timestamp: u64,
    pub reasons_hash: BytesN<32>,
}

#[contractevent]
#[derive(Clone, Debug)]
pub struct PublisherAdded {
    #[topic]
    pub publisher: Address,
}

#[contractevent]
#[derive(Clone, Debug)]
pub struct PublisherRemoved {
    #[topic]
    pub publisher: Address,
}

#[contractevent]
#[derive(Clone, Debug)]
pub struct ThresholdSet {
    pub threshold: u32,
}

#[contractevent]
#[derive(Clone, Debug)]
pub struct MaxAgeSet {
    pub max_age_secs: u64,
}

#[contractevent]
#[derive(Clone, Debug)]
pub struct AdminTransferred {
    #[topic]
    pub previous_admin: Address,
    #[topic]
    pub new_admin: Address,
}

// ---------------------------------------------------------------- helpers

fn bump_instance(e: &Env) {
    e.storage().instance().extend_ttl(INSTANCE_THRESHOLD, INSTANCE_EXTEND);
}

fn admin(e: &Env) -> Address {
    e.storage().instance().get(&DataKey::Admin).expect("admin set in constructor")
}

fn require_admin(e: &Env) -> Address {
    let a = admin(e);
    a.require_auth();
    a
}

fn load_publishers(e: &Env) -> Vec<Address> {
    e.storage().instance().get(&DataKey::Publishers).unwrap_or_else(|| Vec::new(e))
}

fn load_threshold(e: &Env) -> u32 {
    e.storage().instance().get(&DataKey::Threshold).unwrap_or(1)
}

fn load_max_age(e: &Env) -> u64 {
    e.storage().instance().get(&DataKey::MaxAge).unwrap_or(0)
}

fn check_threshold(e: &Env, threshold: u32) {
    if threshold == 0 || threshold > MAX_PUBLISHERS {
        panic_with_error!(e, RegistryError::InvalidThreshold);
    }
}

fn check_max_age(e: &Env, max_age_secs: u64) {
    if max_age_secs == 0 {
        panic_with_error!(e, RegistryError::InvalidMaxAge);
    }
}

/// Validates and stores one submission. Auth and publisher membership are
/// checked by the caller (once per call, not once per batch entry).
fn store_submission(
    e: &Env,
    publisher: &Address,
    pool: &Address,
    score: u32,
    timestamp: u64,
    reasons_hash: &BytesN<32>,
    now: u64,
    max_age: u64,
) {
    if score > MAX_SCORE {
        panic_with_error!(e, RegistryError::InvalidScore);
    }
    if timestamp > now {
        panic_with_error!(e, RegistryError::FutureTimestamp);
    }
    if now - timestamp > max_age {
        panic_with_error!(e, RegistryError::StaleTimestamp);
    }
    let key = DataKey::Submission(pool.clone(), publisher.clone());
    if let Some(prev) = e.storage().persistent().get::<_, Submission>(&key) {
        if prev.timestamp >= timestamp {
            panic_with_error!(e, RegistryError::NotNewer);
        }
    }
    let sub = Submission { score, timestamp, reasons_hash: reasons_hash.clone() };
    e.storage().persistent().set(&key, &sub);
    e.storage().persistent().extend_ttl(&key, SUBMISSION_THRESHOLD, SUBMISSION_EXTEND);

    RatingPublished {
        pool: pool.clone(),
        publisher: publisher.clone(),
        score,
        timestamp,
        reasons_hash: reasons_hash.clone(),
    }
    .publish(e);
}

fn require_publisher(e: &Env, publisher: &Address) {
    publisher.require_auth();
    if !load_publishers(e).contains(publisher) {
        panic_with_error!(e, RegistryError::NotPublisher);
    }
}

/// Lower-middle median of `scores[..n]` (sorts in place; n <= MAX_PUBLISHERS).
fn lower_median(scores: &mut [u32], n: usize) -> u32 {
    let s = &mut scores[..n];
    // Insertion sort: n is at most 16.
    for i in 1..s.len() {
        let mut j = i;
        while j > 0 && s[j - 1] > s[j] {
            s.swap(j - 1, j);
            j -= 1;
        }
    }
    s[(n - 1) / 2]
}

// ---------------------------------------------------------------- contract

#[contract]
pub struct VigilRegistry;

#[contractimpl]
impl VigilRegistry {
    /// `threshold` in 1..=MAX_PUBLISHERS, `max_age_secs` > 0. The publisher
    /// set starts empty; `get_rating` returns `None` until `threshold`
    /// publishers have published.
    pub fn __constructor(e: Env, admin: Address, threshold: u32, max_age_secs: u64) {
        check_threshold(&e, threshold);
        check_max_age(&e, max_age_secs);
        e.storage().instance().set(&DataKey::Admin, &admin);
        e.storage().instance().set(&DataKey::Threshold, &threshold);
        e.storage().instance().set(&DataKey::MaxAge, &max_age_secs);
        e.storage().instance().set(&DataKey::Publishers, &Vec::<Address>::new(&e));
        bump_instance(&e);
    }

    // ------------------------------------------------------------ admin

    pub fn admin(e: Env) -> Address {
        admin(&e)
    }

    pub fn add_publisher(e: Env, publisher: Address) {
        require_admin(&e);
        let mut pubs = load_publishers(&e);
        if pubs.contains(&publisher) {
            panic_with_error!(&e, RegistryError::AlreadyPublisher);
        }
        if pubs.len() >= MAX_PUBLISHERS {
            panic_with_error!(&e, RegistryError::TooManyPublishers);
        }
        pubs.push_back(publisher.clone());
        e.storage().instance().set(&DataKey::Publishers, &pubs);
        bump_instance(&e);
        PublisherAdded { publisher }.publish(&e);
    }

    /// Removing a publisher immediately drops its submissions from every
    /// `get_rating` aggregate (submissions are not deleted; if the publisher
    /// is re-added, still-fresh submissions count again).
    pub fn remove_publisher(e: Env, publisher: Address) {
        require_admin(&e);
        let mut pubs = load_publishers(&e);
        match pubs.first_index_of(&publisher) {
            Some(i) => {
                pubs.remove(i);
            }
            None => panic_with_error!(&e, RegistryError::NotPublisher),
        }
        e.storage().instance().set(&DataKey::Publishers, &pubs);
        bump_instance(&e);
        PublisherRemoved { publisher }.publish(&e);
    }

    /// `threshold` in 1..=MAX_PUBLISHERS. It may exceed the current publisher
    /// count; `get_rating` then returns `None` (fail-closed) until enough
    /// publishers exist.
    pub fn set_threshold(e: Env, threshold: u32) {
        require_admin(&e);
        check_threshold(&e, threshold);
        e.storage().instance().set(&DataKey::Threshold, &threshold);
        bump_instance(&e);
        ThresholdSet { threshold }.publish(&e);
    }

    pub fn set_max_age(e: Env, max_age_secs: u64) {
        require_admin(&e);
        check_max_age(&e, max_age_secs);
        e.storage().instance().set(&DataKey::MaxAge, &max_age_secs);
        bump_instance(&e);
        MaxAgeSet { max_age_secs }.publish(&e);
    }

    /// Both the current and the new admin must authorize (prevents handing
    /// the registry to a mistyped / uncontrolled address).
    pub fn transfer_admin(e: Env, new_admin: Address) {
        let previous_admin = require_admin(&e);
        new_admin.require_auth();
        e.storage().instance().set(&DataKey::Admin, &new_admin);
        bump_instance(&e);
        AdminTransferred { previous_admin, new_admin }.publish(&e);
    }

    // ------------------------------------------------------------ publishing

    pub fn publish(
        e: Env,
        publisher: Address,
        pool: Address,
        score: u32,
        timestamp: u64,
        reasons_hash: BytesN<32>,
    ) {
        require_publisher(&e, &publisher);
        let now = e.ledger().timestamp();
        let max_age = load_max_age(&e);
        store_submission(&e, &publisher, &pool, score, timestamp, &reasons_hash, now, max_age);
        bump_instance(&e);
    }

    /// Atomic: any invalid entry (including a duplicate pool in the same
    /// batch, which fails `NotNewer`) reverts the whole batch.
    pub fn publish_batch(e: Env, publisher: Address, ratings: Vec<RatingInput>) {
        require_publisher(&e, &publisher);
        if ratings.is_empty() {
            panic_with_error!(&e, RegistryError::EmptyBatch);
        }
        if ratings.len() > MAX_BATCH {
            panic_with_error!(&e, RegistryError::BatchTooLarge);
        }
        let now = e.ledger().timestamp();
        let max_age = load_max_age(&e);
        for r in ratings.iter() {
            store_submission(&e, &publisher, &r.pool, r.score, r.timestamp, &r.reasons_hash, now, max_age);
        }
        bump_instance(&e);
    }
}

#[contractimpl]
impl RiskRegistryInterface for VigilRegistry {
    fn get_rating(e: Env, pool: Address) -> Option<Rating> {
        let now = e.ledger().timestamp();
        let max_age = load_max_age(&e);
        let threshold = load_threshold(&e);
        let pubs = load_publishers(&e);

        let mut scores = [0u32; MAX_PUBLISHERS as usize];
        let mut n: usize = 0;
        let mut oldest: u64 = u64::MAX;
        for p in pubs.iter() {
            let key = DataKey::Submission(pool.clone(), p);
            if let Some(s) = e.storage().persistent().get::<_, Submission>(&key) {
                if s.timestamp <= now && now - s.timestamp <= max_age && n < scores.len() {
                    scores[n] = s.score;
                    n += 1;
                    if s.timestamp < oldest {
                        oldest = s.timestamp;
                    }
                }
            }
        }
        if n == 0 || (n as u32) < threshold {
            return None;
        }
        Some(Rating { score: lower_median(&mut scores, n), publishers: n as u32, timestamp: oldest })
    }

    fn get_submission(e: Env, pool: Address, publisher: Address) -> Option<Submission> {
        e.storage().persistent().get(&DataKey::Submission(pool, publisher))
    }

    fn publishers(e: Env) -> Vec<Address> {
        load_publishers(&e)
    }

    fn threshold(e: Env) -> u32 {
        load_threshold(&e)
    }

    fn max_age(e: Env) -> u64 {
        load_max_age(&e)
    }
}

#[cfg(test)]
mod test;
