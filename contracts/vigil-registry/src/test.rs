extern crate std;

use soroban_sdk::{
    testutils::{Address as _, AuthorizedFunction, AuthorizedInvocation, Events, Ledger, MockAuth, MockAuthInvoke},
    vec, Address, BytesN, Env, Event, IntoVal, Symbol,
};

use crate::{
    PublisherAdded, Rating, RatingInput, RatingPublished, RegistryError, Submission, VigilRegistry,
    VigilRegistryClient, MAX_BATCH, MAX_PUBLISHERS,
};

const NOW: u64 = 1_000_000;
const MAX_AGE: u64 = 7_200;

struct Setup {
    e: Env,
    id: Address,
    admin: Address,
    client: VigilRegistryClient<'static>,
}

fn setup(threshold: u32) -> Setup {
    let e = Env::default();
    e.ledger().set_timestamp(NOW);
    let admin = Address::generate(&e);
    let id = e.register(VigilRegistry, (admin.clone(), threshold, MAX_AGE));
    let client = VigilRegistryClient::new(&e, &id);
    Setup { e, id, admin, client }
}

fn h(e: &Env, b: u8) -> BytesN<32> {
    BytesN::from_array(e, &[b; 32])
}

/// Registers `n` publishers (mocking admin auth) and returns them.
fn add_publishers(s: &Setup, n: u32) -> std::vec::Vec<Address> {
    s.e.mock_all_auths();
    (0..n)
        .map(|_| {
            let p = Address::generate(&s.e);
            s.client.add_publisher(&p);
            p
        })
        .collect()
}

// ------------------------------------------------------------ constructor

#[test]
fn constructor_stores_config() {
    let s = setup(2);
    assert_eq!(s.client.admin(), s.admin);
    assert_eq!(s.client.threshold(), 2);
    assert_eq!(s.client.max_age(), MAX_AGE);
    assert_eq!(s.client.publishers().len(), 0);
}

#[test]
#[should_panic(expected = "Error(Contract, #4203)")]
fn constructor_rejects_zero_threshold() {
    setup(0);
}

#[test]
#[should_panic(expected = "Error(Contract, #4203)")]
fn constructor_rejects_threshold_above_cap() {
    setup(MAX_PUBLISHERS + 1);
}

#[test]
#[should_panic(expected = "Error(Contract, #4204)")]
fn constructor_rejects_zero_max_age() {
    let e = Env::default();
    let admin = Address::generate(&e);
    e.register(VigilRegistry, (admin, 1u32, 0u64));
}

// ------------------------------------------------------------ admin + auth

#[test]
fn add_publisher_requires_exactly_admin_auth() {
    let s = setup(1);
    let p = Address::generate(&s.e);
    s.e.mock_all_auths();
    s.client.add_publisher(&p);
    assert_eq!(
        s.e.auths(),
        std::vec![(
            s.admin.clone(),
            AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    s.id.clone(),
                    Symbol::new(&s.e, "add_publisher"),
                    vec![&s.e, p.clone().into_val(&s.e)],
                )),
                sub_invocations: std::vec![],
            }
        )]
    );
    assert_eq!(s.e.events().all(), [PublisherAdded { publisher: p.clone() }.to_xdr(&s.e, &s.id)]);
    assert_eq!(s.client.publishers(), vec![&s.e, p]);
}

#[test]
fn add_publisher_rejects_non_admin_signer() {
    let s = setup(1);
    let p = Address::generate(&s.e);
    let mallory = Address::generate(&s.e);
    // Only mallory signs: the admin require_auth must fail.
    let r = s
        .client
        .mock_auths(&[MockAuth {
            address: &mallory,
            invoke: &MockAuthInvoke {
                contract: &s.id,
                fn_name: "add_publisher",
                args: (p.clone(),).into_val(&s.e),
                sub_invokes: &[],
            },
        }])
        .try_add_publisher(&p);
    assert!(r.is_err());
    assert_eq!(s.client.publishers().len(), 0);
}

#[test]
fn add_publisher_rejects_duplicate_and_cap() {
    let s = setup(1);
    let pubs = add_publishers(&s, MAX_PUBLISHERS);
    assert_eq!(
        s.client.try_add_publisher(&pubs[0]),
        Err(Ok(RegistryError::AlreadyPublisher.into()))
    );
    assert_eq!(
        s.client.try_add_publisher(&Address::generate(&s.e)),
        Err(Ok(RegistryError::TooManyPublishers.into()))
    );
}

#[test]
fn remove_publisher_and_unknown() {
    let s = setup(1);
    let pubs = add_publishers(&s, 2);
    s.client.remove_publisher(&pubs[0]);
    assert_eq!(s.client.publishers(), vec![&s.e, pubs[1].clone()]);
    assert_eq!(
        s.client.try_remove_publisher(&pubs[0]),
        Err(Ok(RegistryError::NotPublisher.into()))
    );
}

#[test]
fn set_threshold_and_max_age_validate() {
    let s = setup(1);
    s.e.mock_all_auths();
    s.client.set_threshold(&3);
    assert_eq!(s.client.threshold(), 3);
    assert_eq!(s.client.try_set_threshold(&0), Err(Ok(RegistryError::InvalidThreshold.into())));
    assert_eq!(
        s.client.try_set_threshold(&(MAX_PUBLISHERS + 1)),
        Err(Ok(RegistryError::InvalidThreshold.into()))
    );
    s.client.set_max_age(&60);
    assert_eq!(s.client.max_age(), 60);
    assert_eq!(s.client.try_set_max_age(&0), Err(Ok(RegistryError::InvalidMaxAge.into())));
}

#[test]
fn admin_setters_require_admin() {
    let s = setup(1);
    // No auth mocked at all.
    assert!(s.client.try_set_threshold(&2).is_err());
    assert!(s.client.try_set_max_age(&10).is_err());
    assert!(s.client.try_remove_publisher(&Address::generate(&s.e)).is_err());
    assert!(s.client.try_transfer_admin(&Address::generate(&s.e)).is_err());
}

#[test]
fn transfer_admin_requires_both_parties() {
    let s = setup(1);
    let new_admin = Address::generate(&s.e);
    s.e.mock_all_auths();
    s.client.transfer_admin(&new_admin);
    let auths = s.e.auths();
    assert_eq!(auths.len(), 2);
    assert_eq!(auths[0].0, s.admin);
    assert_eq!(auths[1].0, new_admin);
    assert_eq!(s.client.admin(), new_admin);

    // Old admin alone can no longer administer.
    let p = Address::generate(&s.e);
    let r = s
        .client
        .mock_auths(&[MockAuth {
            address: &s.admin,
            invoke: &MockAuthInvoke {
                contract: &s.id,
                fn_name: "add_publisher",
                args: (p.clone(),).into_val(&s.e),
                sub_invokes: &[],
            },
        }])
        .try_add_publisher(&p);
    assert!(r.is_err());
}

#[test]
fn transfer_admin_fails_without_new_admin_auth() {
    let s = setup(1);
    let new_admin = Address::generate(&s.e);
    let r = s
        .client
        .mock_auths(&[MockAuth {
            address: &s.admin,
            invoke: &MockAuthInvoke {
                contract: &s.id,
                fn_name: "transfer_admin",
                args: (new_admin.clone(),).into_val(&s.e),
                sub_invokes: &[],
            },
        }])
        .try_transfer_admin(&new_admin);
    assert!(r.is_err());
    assert_eq!(s.client.admin(), s.admin);
}

// ------------------------------------------------------------ publish

#[test]
fn publish_requires_publisher_auth_and_stores() {
    let s = setup(1);
    let p = add_publishers(&s, 1).remove(0);
    let pool = Address::generate(&s.e);
    s.client.publish(&p, &pool, &80, &(NOW - 10), &h(&s.e, 1));
    let auths = s.e.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, p);
    assert_eq!(
        s.e.events().all(),
        [RatingPublished {
            pool: pool.clone(),
            publisher: p.clone(),
            score: 80,
            timestamp: NOW - 10,
            reasons_hash: h(&s.e, 1),
        }
        .to_xdr(&s.e, &s.id)]
    );
    assert_eq!(
        s.client.get_submission(&pool, &p),
        Some(Submission { score: 80, timestamp: NOW - 10, reasons_hash: h(&s.e, 1) })
    );
    assert_eq!(s.client.get_rating(&pool), Some(Rating { score: 80, publishers: 1, timestamp: NOW - 10 }));
}

#[test]
fn publish_without_publisher_signature_fails() {
    let s = setup(1);
    let p = add_publishers(&s, 1).remove(0);
    let pool = Address::generate(&s.e);
    s.e.set_auths(&[]);
    assert!(s.client.try_publish(&p, &pool, &80, &NOW, &h(&s.e, 1)).is_err());
}

#[test]
fn publish_rejects_unregistered_publisher() {
    let s = setup(1);
    s.e.mock_all_auths();
    let rando = Address::generate(&s.e);
    assert_eq!(
        s.client.try_publish(&rando, &Address::generate(&s.e), &50, &NOW, &h(&s.e, 0)),
        Err(Ok(RegistryError::NotPublisher.into()))
    );
}

#[test]
fn publish_validates_score_and_timestamp() {
    let s = setup(1);
    let p = add_publishers(&s, 1).remove(0);
    let pool = Address::generate(&s.e);
    assert_eq!(s.client.try_publish(&p, &pool, &101, &NOW, &h(&s.e, 0)), Err(Ok(RegistryError::InvalidScore.into())));
    assert_eq!(
        s.client.try_publish(&p, &pool, &50, &(NOW + 1), &h(&s.e, 0)),
        Err(Ok(RegistryError::FutureTimestamp.into()))
    );
    assert_eq!(
        s.client.try_publish(&p, &pool, &50, &(NOW - MAX_AGE - 1), &h(&s.e, 0)),
        Err(Ok(RegistryError::StaleTimestamp.into()))
    );
    // Boundary: exactly max_age old is still accepted.
    s.client.publish(&p, &pool, &100, &(NOW - MAX_AGE), &h(&s.e, 0));
    s.client.publish(&p, &pool, &0, &NOW, &h(&s.e, 0));
}

#[test]
fn publish_overwrites_only_if_newer() {
    let s = setup(1);
    let p = add_publishers(&s, 1).remove(0);
    let pool = Address::generate(&s.e);
    s.client.publish(&p, &pool, &70, &(NOW - 100), &h(&s.e, 1));
    assert_eq!(
        s.client.try_publish(&p, &pool, &10, &(NOW - 100), &h(&s.e, 2)),
        Err(Ok(RegistryError::NotNewer.into()))
    );
    assert_eq!(
        s.client.try_publish(&p, &pool, &10, &(NOW - 200), &h(&s.e, 2)),
        Err(Ok(RegistryError::NotNewer.into()))
    );
    assert_eq!(s.client.get_submission(&pool, &p).unwrap().score, 70);
    s.client.publish(&p, &pool, &20, &(NOW - 50), &h(&s.e, 3));
    assert_eq!(
        s.client.get_submission(&pool, &p),
        Some(Submission { score: 20, timestamp: NOW - 50, reasons_hash: h(&s.e, 3) })
    );
}

#[test]
fn publish_batch_stores_all_and_is_atomic() {
    let s = setup(1);
    let p = add_publishers(&s, 1).remove(0);
    let a = Address::generate(&s.e);
    let b = Address::generate(&s.e);
    s.client.publish_batch(
        &p,
        &vec![
            &s.e,
            RatingInput { pool: a.clone(), score: 90, timestamp: NOW, reasons_hash: h(&s.e, 1) },
            RatingInput { pool: b.clone(), score: 40, timestamp: NOW - 5, reasons_hash: h(&s.e, 2) },
        ],
    );
    // One publisher auth covers the whole batch.
    assert_eq!(s.e.auths().len(), 1);
    assert_eq!(s.e.auths()[0].0, p);
    assert_eq!(s.client.get_rating(&a).unwrap().score, 90);
    assert_eq!(s.client.get_rating(&b).unwrap().score, 40);

    // One bad entry reverts the whole batch.
    let c = Address::generate(&s.e);
    let r = s.client.try_publish_batch(
        &p,
        &vec![
            &s.e,
            RatingInput { pool: c.clone(), score: 10, timestamp: NOW, reasons_hash: h(&s.e, 3) },
            RatingInput { pool: a.clone(), score: 101, timestamp: NOW, reasons_hash: h(&s.e, 3) },
        ],
    );
    assert_eq!(r, Err(Ok(RegistryError::InvalidScore.into())));
    assert_eq!(s.client.get_submission(&c, &p), None);

    // Duplicate pool inside one batch -> NotNewer.
    let d = Address::generate(&s.e);
    let r = s.client.try_publish_batch(
        &p,
        &vec![
            &s.e,
            RatingInput { pool: d.clone(), score: 10, timestamp: NOW, reasons_hash: h(&s.e, 3) },
            RatingInput { pool: d.clone(), score: 20, timestamp: NOW, reasons_hash: h(&s.e, 3) },
        ],
    );
    assert_eq!(r, Err(Ok(RegistryError::NotNewer.into())));
}

#[test]
fn publish_batch_bounds() {
    let s = setup(1);
    let p = add_publishers(&s, 1).remove(0);
    assert_eq!(s.client.try_publish_batch(&p, &vec![&s.e]), Err(Ok(RegistryError::EmptyBatch.into())));
    let mut big = vec![&s.e];
    for _ in 0..(MAX_BATCH + 1) {
        big.push_back(RatingInput {
            pool: Address::generate(&s.e),
            score: 1,
            timestamp: NOW,
            reasons_hash: h(&s.e, 0),
        });
    }
    assert_eq!(s.client.try_publish_batch(&p, &big), Err(Ok(RegistryError::BatchTooLarge.into())));
}

#[test]
fn publish_batch_rejects_unregistered() {
    let s = setup(1);
    s.e.mock_all_auths();
    let rando = Address::generate(&s.e);
    let r = s.client.try_publish_batch(
        &rando,
        &vec![&s.e, RatingInput { pool: Address::generate(&s.e), score: 1, timestamp: NOW, reasons_hash: h(&s.e, 0) }],
    );
    assert_eq!(r, Err(Ok(RegistryError::NotPublisher.into())));
}

// ------------------------------------------------------------ aggregation

#[test]
fn rating_none_without_submissions() {
    let s = setup(1);
    add_publishers(&s, 3);
    assert_eq!(s.client.get_rating(&Address::generate(&s.e)), None);
}

#[test]
fn median_odd_count_and_oldest_timestamp() {
    let s = setup(2);
    let pubs = add_publishers(&s, 3);
    let pool = Address::generate(&s.e);
    s.client.publish(&pubs[0], &pool, &90, &(NOW - 30), &h(&s.e, 0));
    s.client.publish(&pubs[1], &pool, &20, &(NOW - 10), &h(&s.e, 0));
    s.client.publish(&pubs[2], &pool, &60, &(NOW - 20), &h(&s.e, 0));
    assert_eq!(s.client.get_rating(&pool), Some(Rating { score: 60, publishers: 3, timestamp: NOW - 30 }));
}

#[test]
fn median_even_count_takes_lower_middle() {
    let s = setup(1);
    let pubs = add_publishers(&s, 4);
    let pool = Address::generate(&s.e);
    s.client.publish(&pubs[0], &pool, &90, &NOW, &h(&s.e, 0));
    s.client.publish(&pubs[1], &pool, &80, &NOW, &h(&s.e, 0));
    assert_eq!(s.client.get_rating(&pool).unwrap().score, 80);
    s.client.publish(&pubs[2], &pool, &10, &NOW, &h(&s.e, 0));
    s.client.publish(&pubs[3], &pool, &50, &NOW, &h(&s.e, 0));
    // sorted [10, 50, 80, 90] -> lower middle = 50
    assert_eq!(s.client.get_rating(&pool), Some(Rating { score: 50, publishers: 4, timestamp: NOW }));
}

#[test]
fn threshold_not_met_returns_none() {
    let s = setup(3);
    let pubs = add_publishers(&s, 3);
    let pool = Address::generate(&s.e);
    s.client.publish(&pubs[0], &pool, &90, &NOW, &h(&s.e, 0));
    s.client.publish(&pubs[1], &pool, &90, &NOW, &h(&s.e, 0));
    assert_eq!(s.client.get_rating(&pool), None);
    s.client.publish(&pubs[2], &pool, &90, &NOW, &h(&s.e, 0));
    assert_eq!(s.client.get_rating(&pool).unwrap().publishers, 3);
    // Threshold above the publisher count fails closed.
    s.client.set_threshold(&4);
    assert_eq!(s.client.get_rating(&pool), None);
}

#[test]
fn stale_submissions_are_dropped() {
    let s = setup(2);
    let pubs = add_publishers(&s, 3);
    let pool = Address::generate(&s.e);
    s.client.publish(&pubs[0], &pool, &10, &(NOW - 7_000), &h(&s.e, 0));
    s.client.publish(&pubs[1], &pool, &80, &(NOW - 100), &h(&s.e, 0));
    s.client.publish(&pubs[2], &pool, &90, &(NOW - 50), &h(&s.e, 0));
    assert_eq!(s.client.get_rating(&pool), Some(Rating { score: 80, publishers: 3, timestamp: NOW - 7_000 }));

    // 300s later pubs[0] is older than MAX_AGE: excluded, median of [80, 90] = 80.
    s.e.ledger().set_timestamp(NOW + 300);
    assert_eq!(s.client.get_rating(&pool), Some(Rating { score: 80, publishers: 2, timestamp: NOW - 100 }));

    // Everything stale -> below threshold -> None.
    s.e.ledger().set_timestamp(NOW + MAX_AGE);
    assert_eq!(s.client.get_rating(&pool), None);

    // Shrinking max_age also takes effect immediately.
    s.e.ledger().set_timestamp(NOW);
    s.client.set_max_age(&60);
    assert_eq!(s.client.get_rating(&pool), None);
}

#[test]
fn removed_publisher_is_ignored_and_readded_counts_again() {
    let s = setup(1);
    let pubs = add_publishers(&s, 2);
    let pool = Address::generate(&s.e);
    s.client.publish(&pubs[0], &pool, &10, &NOW, &h(&s.e, 0));
    s.client.publish(&pubs[1], &pool, &90, &NOW, &h(&s.e, 0));
    assert_eq!(s.client.get_rating(&pool).unwrap(), Rating { score: 10, publishers: 2, timestamp: NOW });

    s.client.remove_publisher(&pubs[0]);
    assert_eq!(s.client.get_rating(&pool).unwrap(), Rating { score: 90, publishers: 1, timestamp: NOW });
    // A removed publisher cannot publish.
    assert_eq!(
        s.client.try_publish(&pubs[0], &pool, &5, &NOW, &h(&s.e, 0)),
        Err(Ok(RegistryError::NotPublisher.into()))
    );
    // Raw submission is still readable.
    assert!(s.client.get_submission(&pool, &pubs[0]).is_some());

    s.client.add_publisher(&pubs[0]);
    assert_eq!(s.client.get_rating(&pool).unwrap().publishers, 2);
}

#[test]
fn full_publisher_set_median() {
    let s = setup(MAX_PUBLISHERS);
    let pubs = add_publishers(&s, MAX_PUBLISHERS);
    let pool = Address::generate(&s.e);
    for (i, p) in pubs.iter().enumerate() {
        // scores 100, 94, ..., 10 (descending, unsorted relative to registration)
        s.client.publish(p, &pool, &(100 - 6 * i as u32), &NOW, &h(&s.e, 0));
    }
    // sorted ascending: 10,16,...,100 ; n=16 -> index 7 -> 10 + 6*7 = 52
    assert_eq!(s.client.get_rating(&pool), Some(Rating { score: 52, publishers: 16, timestamp: NOW }));
}
