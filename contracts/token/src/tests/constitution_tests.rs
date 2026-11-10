//! Clamp every lever at both bounds and at the max step; the sum rule; the
//! fallback rule; tax splits.

use super::*;
use crate::constitution::*;

fn lv(t: u16, e: u8, l: u8) -> Levers {
    Levers {
        tax_bps: t,
        endowment_share: e,
        locker_share: l,
    }
}

fn ask(t: i64, e: i64, l: i64, b: i64) -> Asked {
    Asked {
        tax_bps: t,
        endowment_share: e,
        locker_share: l,
        buyback_burn: b,
    }
}

fn clamp_of<'a>(c: &'a Clamped, lever: &str) -> Option<&'a Clamp> {
    c.clamps.iter().find(|x| x.lever == lever)
}

// ------------------------------------------------------------ tax

#[test]
fn tax_clamped_at_upper_bound() {
    let c = clamp_ruling(lv(290, 60, 20), &ask(10_000, 60, 20, 0));
    assert_eq!(c.levers.tax_bps, 300);
    let k = clamp_of(&c, "tax_bps").unwrap();
    assert_eq!((k.asked, k.applied, k.rule.as_str()), (10_000, 300, "bounds"));
}

#[test]
fn tax_clamped_at_lower_bound() {
    let c = clamp_ruling(lv(120, 60, 20), &ask(0, 60, 20, 0));
    assert_eq!(c.levers.tax_bps, 100);
    let k = clamp_of(&c, "tax_bps").unwrap();
    assert_eq!((k.asked, k.applied, k.rule.as_str()), (0, 100, "bounds"));
}

#[test]
fn tax_clamped_by_max_step_up_and_down() {
    let up = clamp_ruling(lv(200, 60, 20), &ask(300, 60, 20, 0));
    assert_eq!(up.levers.tax_bps, 250);
    assert_eq!(clamp_of(&up, "tax_bps").unwrap().rule, "step");
    let down = clamp_ruling(lv(200, 60, 20), &ask(100, 60, 20, 0));
    assert_eq!(down.levers.tax_bps, 150);
    assert_eq!(clamp_of(&down, "tax_bps").unwrap().rule, "step");
    // Out of bounds but the step bites first: still a step clamp.
    let far = clamp_ruling(lv(200, 60, 20), &ask(5_000, 60, 20, 0));
    assert_eq!(far.levers.tax_bps, 250);
    assert_eq!(clamp_of(&far, "tax_bps").unwrap().rule, "step");
}

#[test]
fn tax_exactly_at_max_step_and_bounds_is_not_clamped() {
    for (cur, asked) in [(200, 250), (200, 150), (250, 300), (150, 100), (300, 300), (100, 100)] {
        let c = clamp_ruling(lv(cur, 60, 20), &ask(asked, 60, 20, 0));
        assert_eq!(c.levers.tax_bps as i64, asked);
        assert!(c.clamps.is_empty(), "{cur} -> {asked}");
    }
}

// ------------------------------------------------------------ endowment

#[test]
fn endowment_clamped_at_both_bounds() {
    let hi = clamp_ruling(lv(200, 95, 0), &ask(200, 250, 0, 0));
    assert_eq!(hi.levers.endowment_share, 100);
    assert_eq!(clamp_of(&hi, "endowment_share").unwrap().rule, "bounds");
    let lo = clamp_ruling(lv(200, 35, 20), &ask(200, -40, 20, 0));
    assert_eq!(lo.levers.endowment_share, 30);
    let k = clamp_of(&lo, "endowment_share").unwrap();
    assert_eq!((k.asked, k.applied, k.rule.as_str()), (-40, 30, "bounds"));
}

#[test]
fn endowment_clamped_by_max_step() {
    let up = clamp_ruling(lv(200, 50, 20), &ask(200, 75, 20, 0));
    assert_eq!(up.levers.endowment_share, 60);
    assert_eq!(clamp_of(&up, "endowment_share").unwrap().rule, "step");
    let down = clamp_ruling(lv(200, 50, 20), &ask(200, 30, 20, 0));
    assert_eq!(down.levers.endowment_share, 40);
    assert_eq!(clamp_of(&down, "endowment_share").unwrap().rule, "step");
    let exact = clamp_ruling(lv(200, 50, 20), &ask(200, 60, 20, 0));
    assert!(exact.clamps.is_empty());
}

// ------------------------------------------------------------ locker

#[test]
fn locker_clamped_at_both_bounds() {
    // v2: the upper bound is 25, below the step from 20.
    let hi = clamp_ruling(lv(200, 30, 20), &ask(200, 30, 99, 0));
    assert_eq!(hi.levers.locker_share, 25);
    let k = clamp_of(&hi, "locker_share").unwrap();
    assert_eq!((k.asked, k.applied, k.rule.as_str()), (99, 25, "bounds"));
    let at = clamp_ruling(lv(200, 30, 25), &ask(200, 30, 26, 0));
    assert_eq!(at.levers.locker_share, 25);
    assert_eq!(clamp_of(&at, "locker_share").unwrap().rule, "bounds");
    let exact = clamp_ruling(lv(200, 30, 15), &ask(200, 30, 25, 0));
    assert!(exact.clamps.is_empty());
    let lo = clamp_ruling(lv(200, 60, 5), &ask(200, 60, -3, 0));
    assert_eq!(lo.levers.locker_share, 0);
    assert_eq!(clamp_of(&lo, "locker_share").unwrap().rule, "bounds");
}

#[test]
fn locker_clamped_by_max_step() {
    let up = clamp_ruling(lv(200, 50, 0), &ask(200, 50, 20, 0));
    assert_eq!(up.levers.locker_share, 10);
    assert_eq!(clamp_of(&up, "locker_share").unwrap().rule, "step");
    // Out of bounds but the step bites first: still a step clamp.
    let far = clamp_ruling(lv(200, 50, 5), &ask(200, 50, 100, 0));
    assert_eq!(far.levers.locker_share, 15);
    assert_eq!(clamp_of(&far, "locker_share").unwrap().rule, "step");
    let down = clamp_ruling(lv(200, 50, 25), &ask(200, 50, 0, 0));
    assert_eq!(down.levers.locker_share, 15);
    assert_eq!(clamp_of(&down, "locker_share").unwrap().rule, "step");
}

#[test]
fn shares_over_100_lower_locker() {
    // e 75→85 (allowed), l 25 held: 110% → locker drops to 15 (a 10-pt step).
    let c = clamp_ruling(lv(200, 75, 25), &ask(200, 85, 25, 0));
    assert_eq!(c.levers.endowment_share, 85);
    assert_eq!(c.levers.locker_share, 15);
    assert_eq!(c.levers.buyback_share(), 0);
    let k = clamp_of(&c, "locker_share").unwrap();
    assert_eq!((k.asked, k.applied, k.rule.as_str()), (25, 15, "sum"));
}

#[test]
fn sum_rule_merges_with_a_step_clamp() {
    // l asked 20 from 5: step → 15; e 80→90 so 90+15 > 100 → 10.
    let c = clamp_ruling(lv(200, 80, 5), &ask(200, 90, 20, 0));
    assert_eq!((c.levers.endowment_share, c.levers.locker_share), (90, 10));
    let k = clamp_of(&c, "locker_share").unwrap();
    assert_eq!((k.asked, k.applied, k.rule.as_str()), (20, 10, "step+sum"));
    assert_eq!(c.clamps.iter().filter(|x| x.lever == "locker_share").count(), 1);
    // l asked 40 from 15: bounds → 25; e 75→85 so 85+25 > 100 → 15.
    let c = clamp_ruling(lv(200, 75, 15), &ask(200, 85, 40, 0));
    assert_eq!((c.levers.endowment_share, c.levers.locker_share), (85, 15));
    let k = clamp_of(&c, "locker_share").unwrap();
    assert_eq!((k.asked, k.applied, k.rule.as_str()), (40, 15, "bounds+sum"));
}

// ------------------------------------------------------------ buyback

#[test]
fn buyback_clamped_at_both_bounds() {
    let hi = clamp_ruling(lv(200, 60, 20), &ask(200, 60, 20, 10_000));
    assert_eq!(hi.buyback_bps, 50);
    assert_eq!(clamp_of(&hi, "buyback_burn").unwrap().rule, "bounds");
    let lo = clamp_ruling(lv(200, 60, 20), &ask(200, 60, 20, -1));
    assert_eq!(lo.buyback_bps, 0);
    assert_eq!(clamp_of(&lo, "buyback_burn").unwrap().rule, "bounds");
    let max = clamp_ruling(lv(200, 60, 20), &ask(200, 60, 20, 50));
    assert_eq!(max.buyback_bps, 50);
    assert!(max.clamps.is_empty());
}

#[test]
fn in_range_ruling_has_no_clamps() {
    let c = clamp_ruling(lv(200, 60, 20), &ask(220, 55, 25, 10));
    assert_eq!(c.levers, lv(220, 55, 25));
    assert_eq!(c.buyback_bps, 10);
    assert!(c.clamps.is_empty());
}

#[test]
fn jailbroken_extremes_land_inside() {
    let c = clamp_ruling(
        lv(200, 60, 20),
        &ask(i64::MAX, i64::MIN, i64::MAX, i64::MAX),
    );
    assert_eq!(c.levers, lv(250, 50, 25));
    assert_eq!(c.buyback_bps, 50);
    assert_eq!(c.clamps.len(), 4);
    assert_eq!(clamp_of(&c, "locker_share").unwrap().rule, "bounds");
    assert!(c.levers.within_constitution());
}

#[test]
fn clamp_property_every_start_every_ask() {
    let mut rng = Rng(42);
    for _ in 0..20_000 {
        let e = rng.range(30, 100);
        let before = lv(
            rng.range(100, 300) as u16,
            e as u8,
            rng.range(0, (100 - e).min(LOCKER_MAX)) as u8,
        );
        assert!(before.within_constitution());
        let a = ask(
            rng.range(-1_000, 1_000),
            rng.range(-200, 200),
            rng.range(-200, 200),
            rng.range(-500, 500),
        );
        let c = clamp_ruling(before, &a);
        let l = c.levers;
        assert!(l.within_constitution(), "{before:?} {a:?} -> {l:?}");
        assert!((l.tax_bps as i64 - before.tax_bps as i64).abs() <= TAX_STEP_BPS);
        assert!((l.endowment_share as i64 - before.endowment_share as i64).abs() <= ENDOWMENT_STEP);
        assert!((l.locker_share as i64 - before.locker_share as i64).abs() <= LOCKER_STEP);
        assert!((0..=BUYBACK_MAX_BPS).contains(&(c.buyback_bps as i64)));
        // Every moved value is recorded; every untouched one is not.
        assert_eq!(clamp_of(&c, "tax_bps").is_some(), l.tax_bps as i64 != a.tax_bps);
        assert_eq!(
            clamp_of(&c, "endowment_share").is_some(),
            l.endowment_share as i64 != a.endowment_share
        );
        assert_eq!(
            clamp_of(&c, "locker_share").is_some(),
            l.locker_share as i64 != a.locker_share
        );
        assert_eq!(
            clamp_of(&c, "buyback_burn").is_some(),
            c.buyback_bps as i64 != a.buyback_burn
        );
    }
}

// ------------------------------------------------------------ fallback

#[test]
fn fallback_moves_tax_ten_toward_200_and_holds_the_rest() {
    assert_eq!(fallback(lv(300, 70, 10)), lv(290, 70, 10));
    assert_eq!(fallback(lv(100, 30, 25)), lv(110, 30, 25));
    assert_eq!(fallback(lv(205, 60, 20)), lv(200, 60, 20));
    assert_eq!(fallback(lv(195, 60, 20)), lv(200, 60, 20));
    assert_eq!(fallback(lv(200, 60, 20)), lv(200, 60, 20));
    assert_eq!(fallback(lv(210, 60, 20)), lv(200, 60, 20));
    // Repeated fallbacks converge to 200 and stay there.
    let mut l = lv(300, 60, 20);
    for _ in 0..10 {
        l = fallback(l);
    }
    assert_eq!(l.tax_bps, 200);
    assert_eq!(fallback(l), l);
}

// ------------------------------------------------------------ splits

#[test]
fn tax_split_follows_levers_and_buyback_takes_the_remainder() {
    let (e, l, b) = lv(200, 60, 20).split(1_000);
    assert_eq!((e, l, b), (600, 200, 200));
    let (e, l, b) = lv(200, 100, 0).split(999);
    assert_eq!((e, l, b), (999, 0, 0));
    let (e, l, b) = lv(200, 30, 25).split(7);
    assert_eq!((e, l, b), (2, 1, 4)); // floor(2.1), floor(1.75), remainder
    let mut rng = Rng(3);
    for _ in 0..5_000 {
        let ee = rng.range(30, 100) as u8;
        let ll = rng.range(0, (100 - ee as i64).min(LOCKER_MAX)) as u8;
        let tax = rng.log_u128(127);
        let (e, l, b) = lv(200, ee, ll).split(tax);
        assert_eq!(e + l + b, tax);
        assert_eq!(e, (U256::from(tax) * U256::from(ee) / U256::from(100u8)).low_u128());
        assert_eq!(l, (U256::from(tax) * U256::from(ll) / U256::from(100u8)).low_u128());
    }
}

#[test]
fn constitution_view_matches_the_spec_table() {
    let r = rules();
    assert_eq!((r.tax_bps.min, r.tax_bps.max, r.tax_bps.max_step), (100, 300, Some(50)));
    assert_eq!(
        (r.endowment_share.min, r.endowment_share.max, r.endowment_share.max_step),
        (30, 100, Some(10))
    );
    assert_eq!(
        (r.locker_share.min, r.locker_share.max, r.locker_share.max_step),
        (0, 25, Some(10))
    );
    assert_eq!((r.buyback_burn.min, r.buyback_burn.max), (0, 50));
    assert_eq!((r.fallback_tax_target_bps, r.fallback_tax_step_bps), (200, 10));
}
