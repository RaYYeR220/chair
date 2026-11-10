//! Curve math: integrals, round trips, path independence, exact search.

use super::*;
use crate::curve::{bps_ceil, bps_floor, Curve, D, TWO_D2, U256};

fn c() -> Curve {
    Curve { p0: P0, k: K }
}

/// Exact `F(s)` as a rational `(num, den)` computed independently in U256.
fn f_exact(curve: &Curve, s: u128) -> U256 {
    U256::from(2u8) * U256::from(curve.p0) * U256::from(D) * U256::from(s)
        + U256::from(curve.k) * U256::from(s) * U256::from(s)
}

#[test]
fn integral_closed_form_small_values() {
    let curve = c();
    assert_eq!(curve.reserve_for(0), Some(0));
    // 1 CHAIR: p0·1 + k·1/2 = 1e18 + 5e11 yocto.
    assert_eq!(curve.reserve_for(ONE_TOKEN), Some(P0 + K / 2));
    // 1e6 CHAIR: p0·1e6 + k·1e12/2.
    assert_eq!(
        curve.reserve_for(tokens(1_000_000)),
        Some(P0 * 1_000_000 + K * 1_000_000_000_000 / 2)
    );
    // 1 base unit: exactly 1 yocto + 5e-25 yocto, rounded up in the reserve's favour.
    assert_eq!(curve.reserve_for(1), Some(2));
    // A flat price of 1 yocto per base unit is exact.
    assert_eq!(Curve { p0: D, k: 0 }.reserve_for(12_345), Some(12_345));
}

#[test]
fn reserve_for_is_ceil_of_exact_integral() {
    let curve = Curve { p0: 3, k: 7 };
    let mut rng = Rng(11);
    for _ in 0..2_000 {
        let s = rng.log_u128(100);
        let r = curve.reserve_for(s).unwrap();
        let n = f_exact(&curve, s);
        let den = U256::from(TWO_D2);
        // r·den ≥ n > (r−1)·den
        assert!(U256::from(r) * den >= n);
        if r > 0 {
            assert!(U256::from(r - 1) * den < n);
        }
        assert!(curve.covers(r, s));
        if r > 0 {
            assert!(!curve.covers(r - 1, s) || n == U256::zero());
        }
    }
}

#[test]
fn price_is_linear() {
    let curve = c();
    assert_eq!(curve.price(0), P0);
    assert_eq!(curve.price(tokens(1)), P0 + K);
    assert_eq!(curve.price(tokens(1_000_000)), P0 + K * 1_000_000);
    // Integral of a linear price = average price × amount.
    let s = tokens(2_000_000);
    let avg = (curve.price(0) + curve.price(s)) / 2;
    assert_eq!(curve.reserve_for(s).unwrap(), avg * 2_000_000);
}

#[test]
fn buy_then_sell_round_trip_is_exact_before_tax() {
    let curve = c();
    let mut rng = Rng(5);
    for _ in 0..1_000 {
        let s = rng.log_u128(90);
        let d = rng.log_u128(90);
        let cost = curve.buy_cost(s, d).unwrap();
        let back = curve.sell_return(s + d, d);
        assert_eq!(cost, back, "round trip at s={s} d={d}");
    }
}

#[test]
fn round_trip_with_tax_never_profits() {
    let curve = c();
    let mut rng = Rng(6);
    for _ in 0..500 {
        let s = rng.log_u128(85);
        let dep = rng.log_u128(85);
        let tax = rng.range(100, 300) as u16;
        let (tokens_out, cost, t) = curve.quote_buy(s, dep, tax);
        assert!(cost + t <= dep);
        if tokens_out == 0 {
            continue;
        }
        let (_, _, net) = curve.quote_sell(s + tokens_out, tokens_out, tax);
        assert!(net <= dep, "sold back for more than paid");
        assert!(net <= cost);
    }
}

#[test]
fn split_buys_cost_the_same_as_one_buy() {
    let curve = c();
    let mut rng = Rng(7);
    for _ in 0..1_000 {
        let s = rng.log_u128(88);
        let a = rng.log_u128(88);
        let b = rng.log_u128(88);
        let one = curve.buy_cost(s, a + b).unwrap();
        let two = curve.buy_cost(s, a).unwrap() + curve.buy_cost(s + a, b).unwrap();
        assert_eq!(one, two, "path independence");
    }
}

#[test]
fn reserve_always_equals_integral_after_any_path() {
    let curve = c();
    let mut rng = Rng(8);
    let (mut s, mut reserve) = (0u128, 0u128);
    for _ in 0..5_000 {
        if rng.chance(55) || s == 0 {
            let d = rng.log_u128(80);
            reserve += curve.buy_cost(s, d).unwrap();
            s += d;
        } else {
            let d = (rng.log_u128(80)).min(s);
            reserve -= curve.sell_return(s, d);
            s -= d;
        }
        assert!(curve.covers(reserve, s));
        assert_eq!(reserve, curve.reserve_for(s).unwrap());
    }
}

#[test]
fn max_buy_is_exactly_maximal() {
    let curve = c();
    let mut rng = Rng(9);
    for _ in 0..1_000 {
        let s = rng.log_u128(90);
        let budget = rng.log_u128(90);
        let (d, cost) = curve.max_buy(s, budget);
        assert_eq!(cost, curve.buy_cost(s, d).unwrap());
        assert!(cost <= budget);
        assert!(curve.buy_cost(s, d + 1).unwrap() > budget, "Δ+1 still fits");
    }
}

#[test]
fn quote_buy_spends_at_most_the_deposit_and_is_maximal() {
    let curve = c();
    let mut rng = Rng(10);
    for _ in 0..1_000 {
        let s = rng.log_u128(90);
        let dep = rng.log_u128(90);
        let tax_bps = rng.range(100, 300) as u16;
        let (d, cost, tax) = curve.quote_buy(s, dep, tax_bps);
        assert_eq!(tax, bps_ceil(cost, tax_bps as u128));
        assert!(cost + tax <= dep);
        let c1 = curve.buy_cost(s, d + 1).unwrap();
        assert!(c1 + bps_ceil(c1, tax_bps as u128) > dep, "one more base unit still fits");
    }
}

#[test]
fn tax_rounds_up_and_sell_tax_never_exceeds_gross() {
    assert_eq!(bps_ceil(0, 200), 0);
    assert_eq!(bps_ceil(1, 200), 1);
    assert_eq!(bps_ceil(10_000, 200), 200);
    assert_eq!(bps_ceil(10_001, 200), 201);
    assert_eq!(bps_floor(10_001, 200), 200);
    // 1 yocto per base unit: selling one gives gross 1, tax ceil(0.03) = 1, net 0.
    let curve = Curve { p0: D, k: 0 };
    let (g, t, n) = curve.quote_sell(10, 1, 300);
    assert_eq!((g, t, n), (1, 1, 0));
    let (g, t, n) = curve.quote_sell(1_000, 1_000, 300);
    assert_eq!((g, t, n), (1_000, 30, 970));
}

#[test]
fn zero_deposit_buys_nothing() {
    assert_eq!(c().quote_buy(0, 0, 200), (0, 0, 0));
    assert_eq!(c().max_buy(tokens(5), 0), (0, 0));
}

#[test]
fn overflow_is_refused_not_wrapped() {
    let curve = Curve {
        p0: ONE_NEAR * 1_000_000,
        k: ONE_NEAR * 1_000_000,
    };
    assert_eq!(curve.reserve_for(u128::MAX), None);
    assert_eq!(curve.buy_cost(0, u128::MAX), None);
    assert_eq!(curve.buy_cost(u128::MAX, 1), None);
    // A budget the curve can never absorb is capped, not wrapped.
    let (d, cost) = curve.max_buy(0, u128::MAX);
    assert!(d > 0 && cost > 0);
    assert_eq!(curve.buy_cost(0, d), Some(cost));
}

#[test]
fn testnet_params_buy_sizes_are_sane() {
    // 1 NEAR at 2% tax on a fresh curve buys about 730k CHAIR.
    let (d, cost, tax) = c().quote_buy(0, near(1), 200);
    assert!(d > tokens(700_000) && d < tokens(750_000), "{d}");
    assert!(cost + tax <= near(1) && near(1) - cost - tax < 10);
}
