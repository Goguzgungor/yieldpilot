//! Shared interface between `vigil-registry` (the producer) and `vigil-guard`
//! (the consumer).
//!
//! This crate is a plain rlib: it contains no `#[contract]`, so linking it into
//! both contracts does not leak exported functions from one wasm into the
//! other. The registry implements [`RiskRegistryInterface`] (so the compiler
//! checks it matches), and the guard calls it through the generated
//! [`RiskRegistryClient`].
#![no_std]

use soroban_sdk::{contractclient, contracttype, Address, BytesN, Env, Vec};

/// Highest valid risk score. Scores are 0..=100, higher = safer.
pub const MAX_SCORE: u32 = 100;

/// Aggregated M-of-N rating for one pool, as returned by `get_rating`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Rating {
    /// Median score of the fresh submissions that were used. For an even
    /// count the LOWER middle value is taken (conservative).
    pub score: u32,
    /// How many publishers' submissions were used for the median.
    pub publishers: u32,
    /// The OLDEST timestamp among the submissions used (conservative
    /// freshness: a consumer's `now - timestamp` bounds every input).
    pub timestamp: u64,
}

/// One publisher's latest submission for one pool.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Submission {
    pub score: u32,
    /// Unix seconds (ledger-time domain) at which the publisher computed it.
    pub timestamp: u64,
    /// sha256 of the off-chain reasons document (audit trail, not interpreted).
    pub reasons_hash: BytesN<32>,
}

/// Element of `publish_batch`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RatingInput {
    pub pool: Address,
    pub score: u32,
    pub timestamp: u64,
    pub reasons_hash: BytesN<32>,
}

/// Read surface of the RiskRegistry. `vigil-guard` only needs `get_rating`;
/// the rest is here so every consumer compiles against one definition.
#[contractclient(name = "RiskRegistryClient")]
pub trait RiskRegistryInterface {
    /// M-of-N aggregate for `pool`, or `None` when fewer than `threshold`
    /// fresh submissions from currently-registered publishers exist.
    fn get_rating(env: Env, pool: Address) -> Option<Rating>;

    /// Raw latest submission of `publisher` for `pool` (no freshness filter).
    fn get_submission(env: Env, pool: Address, publisher: Address) -> Option<Submission>;

    /// Currently registered publishers.
    fn publishers(env: Env) -> Vec<Address>;

    /// Minimum number of fresh submissions required by `get_rating`.
    fn threshold(env: Env) -> u32;

    /// Maximum age (seconds) of a submission for it to count as fresh.
    fn max_age(env: Env) -> u64;
}
