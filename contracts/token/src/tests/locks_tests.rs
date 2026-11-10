//! Locks, locker rewards and petitions.

use super::*;

/// Alice and Bob hold tokens; some tax has been collected.
fn funded() -> H {
    let mut h = H::new();
    h.buy(&alice(), near(10));
    h.buy(&bob(), near(10));
    h
}

fn pending(h: &H, who: &AccountId) -> u128 {
    h.as_(who, 0);
    h.c.get_account(who.clone()).unwrap().rewards.0
}

#[test]
fn lock_only_for_1_7_or_30_days() {
    let mut h = funded();
    for d in [0u8, 2, 8, 29, 31, 255] {
        h.as_(&alice(), 1);
        expect_panic(|| { h.c.lock(U128(tokens(1)), d); }, "1, 7 or 30");
    }
    for d in [1u8, 7, 30] {
        let l = h.lock(&alice(), tokens(10), d);
        assert_eq!(l.weight.0, tokens(10) * d as u128);
        assert_eq!(l.unlock_at.0, h.now + d as u64 * DAY_NS);
    }
    h.as_(&alice(), 0);
    expect_panic(|| { h.c.lock(U128(tokens(1)), 7); }, "1 yoctoNEAR");
}

#[test]
fn locked_tokens_cannot_move_until_unlock() {
    let mut h = funded();
    let bal = h.balance(&alice());
    h.lock(&alice(), bal - tokens(100), 7);
    h.as_(&alice(), 0);
    let v = h.c.get_account(alice()).unwrap();
    assert_eq!(v.transferable.0, tokens(100));
    h.as_(&alice(), 1);
    expect_panic(|| h.c.ft_transfer(bob(), U128(tokens(101)), None), "not enough unlocked");
    h.as_(&alice(), 1);
    expect_panic(|| { h.c.sell(U128(tokens(101)), U128(0)); }, "not enough unlocked");
    h.as_(&alice(), 1);
    expect_panic(|| { h.c.lock(U128(tokens(101)), 1); }, "not enough unlocked");
    // Still locked one second before the end; free at the end.
    h.advance(7 * DAY_NS - SEC_NS);
    h.as_(&alice(), 1);
    expect_panic(|| h.c.ft_transfer(bob(), U128(tokens(101)), None), "not enough unlocked");
    h.advance(SEC_NS);
    h.as_(&alice(), 1);
    h.c.ft_transfer(bob(), U128(bal), None);
    assert_eq!(h.balance(&alice()), 0);
    // The expired lock was released (and its rewards settled) by the transfer.
    h.as_(&alice(), 0);
    assert!(h.c.get_account(alice()).unwrap().locks.is_empty());
    assert_eq!(h.c.total_weight, 0);
}

#[test]
fn at_most_eight_locks() {
    let mut h = funded();
    for _ in 0..MAX_LOCKS {
        h.lock(&alice(), tokens(1), 1);
    }
    h.as_(&alice(), 1);
    expect_panic(|| { h.c.lock(U128(tokens(1)), 1); }, "at most 8");
}

#[test]
fn meeting_pays_lockers_pro_rata_to_weight() {
    let mut h = funded();
    let a = h.balance(&alice()).min(h.balance(&bob())) / 4;
    h.lock(&alice(), a, 7); // weight 7a
    h.lock(&bob(), 3 * a, 7); // weight 21a
    let pool = h.c.locker_pool;
    assert!(pool > 0);
    let _ = h.convene(); // asleep: fallback, still pays lockers
    assert_eq!(h.outcome(1).locker_paid.0, pool);
    assert_eq!(h.c.locker_pool, 0);
    assert_eq!(h.c.locker_owed, pool);
    let (ra, rb) = (pending(&h, &alice()), pending(&h, &bob()));
    assert!(ra + rb <= pool && pool - ra - rb <= 2, "dust only");
    assert!(ra.abs_diff(pool / 4) <= 1, "{ra} vs {}", pool / 4);
    assert!(rb.abs_diff(pool * 3 / 4) <= 1);
    // Claim pays NEAR and draws down what is owed.
    h.as_(&alice(), 0);
    let got = h.c.claim_rewards().0;
    assert_eq!(got, ra);
    assert!(transfers().contains(&("alice.near".to_string(), ra)));
    assert_eq!(h.c.locker_owed, pool - ra);
    assert_eq!(pending(&h, &alice()), 0);
    h.as_(&alice(), 0);
    assert_eq!(h.c.claim_rewards().0, 0);
}

#[test]
fn days_weigh_like_tokens() {
    let mut h = funded();
    let a = tokens(1_000);
    h.lock(&alice(), 30 * a, 1); // weight 30a
    h.lock(&bob(), a, 30); // weight 30a
    let _ = h.convene();
    assert!(pending(&h, &alice()).abs_diff(pending(&h, &bob())) <= 1);
}

#[test]
fn without_lockers_the_pool_carries_over() {
    let mut h = funded();
    let pool = h.c.locker_pool;
    let _ = h.convene();
    assert_eq!(h.outcome(1).locker_paid.0, 0);
    assert_eq!(h.c.locker_pool, pool);
    h.lock(&alice(), tokens(1), 1);
    let _ = h.convene();
    assert_eq!(h.outcome(2).locker_paid.0, pool);
    assert!(pending(&h, &alice()).abs_diff(pool) <= 1);
}

#[test]
fn expired_locks_stop_earning() {
    let mut h = funded();
    h.lock(&alice(), tokens(1_000), 1);
    h.lock(&bob(), tokens(1_000), 30);
    let _ = h.convene(); // meeting 1: both locked
    let a1 = pending(&h, &alice());
    let b1 = pending(&h, &bob());
    assert!(a1 > 0 && a1.abs_diff(b1 / 30) <= 1);
    // Alice's lock ends; more tax comes in; meeting 2 pays only Bob.
    h.advance(2 * DAY_NS);
    h.buy(&carol(), near(5));
    let pool = h.c.locker_pool;
    let _ = h.convene();
    assert_eq!(h.outcome(2).locker_paid.0, pool);
    assert_eq!(pending(&h, &alice()), a1, "nothing after expiry");
    assert!((pending(&h, &bob()) - b1).abs_diff(pool) <= 1);
    assert_eq!(h.c.total_weight, tokens(1_000) * 30);
    // Alice releases her lock: rewards move to claimable, storage freed.
    h.as_(&alice(), 0);
    assert_eq!(h.c.unlock().0, tokens(1_000));
    h.as_(&alice(), 0);
    let v = h.c.get_account(alice()).unwrap();
    assert!(v.locks.is_empty());
    assert_eq!(v.claimable.0, a1);
    // The retired bucket's record is gone once its last lock settled.
    assert!(!h.c.popped.contains_key(&(T0 + DAY_NS).div_ceil(HOUR_NS)));
    assert!(!h.c.buckets.contains_key(&(T0 + DAY_NS).div_ceil(HOUR_NS)));
}

#[test]
fn unlocking_before_the_bucket_retires_takes_weight_out_at_once() {
    let mut h = funded();
    h.lock(&alice(), tokens(500), 1);
    h.lock(&bob(), tokens(500), 7);
    h.advance(DAY_NS); // alice expired, her hour bucket not retired yet
    h.as_(&alice(), 0);
    h.c.unlock();
    assert_eq!(h.c.total_weight, tokens(500) * 7);
    let pool = h.c.locker_pool;
    let _ = h.convene();
    assert!(pending(&h, &bob()).abs_diff(pool) <= 1);
    assert_eq!(pending(&h, &alice()), 0);
}

#[test]
fn rewards_never_exceed_what_was_distributed() {
    let mut h = funded();
    let mut rng = Rng(77);
    let who = [alice(), bob()];
    for round in 0..40 {
        let w = &who[rng.below(2) as usize];
        let free = {
            h.as_(w, 0);
            h.c.get_account(w.clone()).unwrap().transferable.0
        };
        h.as_(w, 0);
        let n_locks = h.c.get_account(w.clone()).unwrap().locks.len();
        if free > tokens(10) && n_locks < MAX_LOCKS {
            h.lock(w, free / 5, [1u8, 7, 30][rng.below(3) as usize]);
        }
        h.buy(&carol(), milli(100 + rng.below(900) as u128));
        h.advance(rng.below(3 * DAY_NS));
        let _ = h.convene();
        if round % 7 == 0 {
            h.as_(w, 0);
            h.c.claim_rewards();
        }
        let owed: u128 = who.iter().map(|a| pending(&h, a)).sum();
        assert!(owed <= h.c.locker_owed, "round {round}: {owed} > {}", h.c.locker_owed);
    }
}

// ------------------------------------------------------------ petitions

#[test]
fn petition_needs_an_active_lock_and_burns_the_fee() {
    let mut h = funded();
    h.as_(&alice(), 1);
    expect_panic(|| { h.c.petition("cut the tax".into()); }, "only lockers");
    h.lock(&alice(), tokens(1_000), 7);
    let (supply, sold, bal) = (h.c.supply, h.c.sold, h.balance(&alice()));
    let p = h.petition(&alice(), "cut the tax");
    assert_eq!(p.weight.0, tokens(7_000));
    assert_eq!(h.c.supply, supply - FEE);
    assert_eq!(h.c.sold, sold, "burn leaves s unchanged");
    assert_eq!(h.c.burned, FEE);
    assert_eq!(h.balance(&alice()), bal - FEE);
    assert_eq!(event("ft_burn").unwrap()["memo"], "petition fee");
    let ev = event("petition_filed").unwrap();
    assert_eq!(ev["text"], "cut the tax");
    assert_eq!(ev["in_brief"], true);
}

#[test]
fn one_petition_per_day() {
    let mut h = funded();
    h.lock(&alice(), tokens(1_000), 30);
    h.petition(&alice(), "one");
    h.advance(DAY_NS - 1);
    h.as_(&alice(), 1);
    expect_panic(|| { h.c.petition("two".into()); }, "one petition per day");
    h.advance(1);
    h.petition(&alice(), "two");
}

#[test]
fn petition_length_and_characters() {
    let mut h = funded();
    h.lock(&alice(), tokens(1_000), 30);
    h.as_(&alice(), 1);
    expect_panic(|| { h.c.petition(String::new()); }, "1-280");
    h.as_(&alice(), 1);
    expect_panic(|| { h.c.petition("x".repeat(281)); }, "1-280");
    h.as_(&alice(), 1);
    expect_panic(|| { h.c.petition("line\nbreak".into()); }, "control");
    // 280 four-byte characters are fine (characters, not bytes).
    let p = h.petition(&alice(), &"🪑".repeat(280));
    assert_eq!(p.text.chars().count(), 280);
}

#[test]
fn petition_fee_needs_unlocked_tokens() {
    let mut h = funded();
    let bal = h.balance(&alice());
    h.lock(&alice(), bal - FEE + 1, 7);
    h.as_(&alice(), 1);
    expect_panic(|| { h.c.petition("hi".into()); }, "unlocked");
}

#[test]
fn top_three_by_weight_earlier_wins_ties() {
    let mut h = H::new();
    let ws = [
        (acc("p1.near"), 5u128),
        (acc("p2.near"), 9),
        (acc("p3.near"), 5),
        (acc("p4.near"), 1),
        (acc("p5.near"), 7),
    ];
    for (a, _) in &ws {
        h.buy(a, near(1));
    }
    for (a, w) in &ws {
        h.lock(a, tokens(*w), 1);
        h.petition(a, a.as_str());
    }
    h.as_(&alice(), 0);
    // The queue holds all five, heaviest first, earlier first among equals.
    let queue: Vec<String> = h.c.get_petitions().iter().map(|p| p.text.clone()).collect();
    assert_eq!(queue, vec!["p2.near", "p5.near", "p1.near", "p3.near", "p4.near"]);
    assert_eq!(h.c.petitions_filed, 5);
    // The brief takes the three heaviest.
    h.report(near(10));
    let req = h.c.get_request_preview().request.unwrap();
    let body: Value = sj::from_str(&req).unwrap();
    let brief: Value = sj::from_str(body["messages"][1]["content"].as_str().unwrap()).unwrap();
    let top: Vec<&str> = brief["petitions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["text"].as_str().unwrap())
        .collect();
    assert_eq!(top, vec!["p2.near", "p5.near", "p1.near"]);
}

#[test]
fn petitions_reach_the_brief_and_clear() {
    let mut h = funded();
    h.lock(&alice(), tokens(1_000), 7);
    h.petition(&alice(), "raise the locker share");
    h.report(near(10));
    let n = h.convene_awake();
    let req = h.c.get_last_request().unwrap();
    let body: Value = sj::from_str(&req).unwrap();
    let brief: Value = sj::from_str(body["messages"][1]["content"].as_str().unwrap()).unwrap();
    assert_eq!(brief["petitions"][0]["text"], "raise the locker share");
    assert_eq!(brief["petitions"][0]["from"], "alice.near");
    assert_eq!(brief["petitions"][0]["weight"], "7000");
    assert_eq!(h.meeting(n).petitions, 1);
    assert!(h.c.pending_petitions().is_empty());
    assert_eq!(h.c.petitions_filed, 0);
}
