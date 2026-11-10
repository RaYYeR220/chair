//! Linear bonding curve (SPEC §2), exact integer math.
//!
//! Units: `s` and token amounts are base units (18 decimals, `D = 10^18` per
//! CHAIR). Prices are yoctoNEAR per whole CHAIR:
//!
//! ```text
//! p(s) = p0 + k·s/D
//! F(s) = ∫₀ˢ p = (2·p0·D·s + k·s²) / (2·D²)        yoctoNEAR
//! R(s) = ceil(F(s))                                 the reserve requirement
//! ```
//!
//! A buy of `Δ` costs `R(s+Δ) − R(s)` and a sell of `Δ` returns
//! `R(s) − R(s−Δ)`. Prices are therefore path independent: the NEAR the curve
//! took in always equals `R(s) ≥ F(s)`, whatever sequence of trades led to
//! `s`, and a buy-then-sell round trip returns exactly what it paid (before
//! tax). Every intermediate is a checked 256-bit product; a result that does
//! not fit `u128` is refused.

#[allow(clippy::manual_div_ceil)]
mod u256 {
    uint::construct_uint! {
        /// 256-bit unsigned integer for curve and reward intermediates.
        pub struct U256(4);
    }
}
pub use u256::U256;

/// Base units per whole token.
pub const D: u128 = 1_000_000_000_000_000_000;
/// Denominator of `F`: `2·D²` = 2·10^36 (fits u128).
pub const TWO_D2: u128 = 2 * D * D;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Curve {
    /// yoctoNEAR per CHAIR at `s = 0`.
    pub p0: u128,
    /// yoctoNEAR per CHAIR, per CHAIR sold.
    pub k: u128,
}

/// `ceil(n / d)` for `d > 0`.
pub fn div_ceil(n: U256, d: U256) -> U256 {
    let q = n / d;
    if q * d == n {
        q
    } else {
        q + U256::one()
    }
}

pub fn to_u128(x: U256) -> Option<u128> {
    u128::try_from(x).ok()
}

/// `ceil(amount · bps / 10_000)`.
pub fn bps_ceil(amount: u128, bps: u128) -> u128 {
    let n = U256::from(amount) * U256::from(bps);
    to_u128(div_ceil(n, U256::from(10_000u32))).unwrap_or(u128::MAX)
}

/// `floor(amount · bps / 10_000)`.
pub fn bps_floor(amount: u128, bps: u128) -> u128 {
    let n = U256::from(amount) * U256::from(bps) / U256::from(10_000u32);
    to_u128(n).unwrap_or(u128::MAX)
}

impl Curve {
    /// Numerator of `F(s)`: `2·p0·D·s + k·s²`, or `None` past 2^256.
    pub fn integral_num(&self, s: u128) -> Option<U256> {
        let s = U256::from(s);
        let a = U256::from(2u8)
            .checked_mul(U256::from(self.p0))?
            .checked_mul(U256::from(D))?
            .checked_mul(s)?;
        let b = U256::from(self.k).checked_mul(s)?.checked_mul(s)?;
        a.checked_add(b)
    }

    /// `R(s) = ceil(F(s))`, or `None` if it does not fit u128.
    pub fn reserve_for(&self, s: u128) -> Option<u128> {
        to_u128(div_ceil(self.integral_num(s)?, U256::from(TWO_D2)))
    }

    /// `true` iff `reserve ≥ F(s)` exactly (no rounding).
    pub fn covers(&self, reserve: u128, s: u128) -> bool {
        match self.integral_num(s) {
            Some(n) => U256::from(reserve) * U256::from(TWO_D2) >= n,
            None => false,
        }
    }

    /// Spot price `p(s)` in yoctoNEAR per CHAIR (floor).
    pub fn price(&self, s: u128) -> u128 {
        let p = U256::from(self.p0) + U256::from(self.k) * U256::from(s) / U256::from(D);
        to_u128(p).unwrap_or(u128::MAX)
    }

    /// NEAR to buy `delta` at `s`: `R(s+Δ) − R(s)`. `None` if past u128.
    pub fn buy_cost(&self, s: u128, delta: u128) -> Option<u128> {
        let to = s.checked_add(delta)?;
        Some(self.reserve_for(to)? - self.reserve_for(s)?)
    }

    /// NEAR returned for selling `delta` at `s`: `R(s) − R(s−Δ)`.
    /// Callers guarantee `delta ≤ s` and that `s` is reachable.
    pub fn sell_return(&self, s: u128, delta: u128) -> u128 {
        let hi = self.reserve_for(s).expect("reachable s");
        let lo = self.reserve_for(s - delta).expect("reachable s");
        hi - lo
    }

    /// Largest `Δ` whose curve cost `R(s+Δ) − R(s)` is at most `budget`,
    /// with that cost. Exact: bisection on the integer cost function.
    pub fn max_buy(&self, s: u128, budget: u128) -> (u128, u128) {
        let Some(base) = self.reserve_for(s) else {
            return (0, 0);
        };
        let Some(limit) = base.checked_add(budget) else {
            // The curve cannot hold that much NEAR anyway; cap at u128.
            return self.max_buy(s, u128::MAX - base);
        };
        let fits = |delta: u128| -> bool {
            match s.checked_add(delta).and_then(|to| self.reserve_for(to)) {
                Some(r) => r <= limit,
                None => false,
            }
        };
        // Upper bound: the price only rises, so Δ·p(s)/D − 1 ≤ cost(Δ).
        let p = self.price(s).max(1);
        let est = U256::from(budget) + U256::one();
        let est = est * U256::from(D) / U256::from(p) + U256::one();
        let mut hi = to_u128(est).unwrap_or(u128::MAX);
        let mut lo = 0u128;
        // Guard the bound (it holds analytically; this keeps the search exact).
        while fits(hi) {
            lo = hi;
            if hi == u128::MAX {
                break;
            }
            hi = hi.saturating_mul(2);
        }
        if lo == hi {
            let cost = self.reserve_for(s + lo).unwrap_or(base) - base;
            return (lo, cost);
        }
        while hi - lo > 1 {
            let mid = lo + (hi - lo) / 2;
            if fits(mid) {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        let cost = self.reserve_for(s + lo).unwrap_or(base) - base;
        (lo, cost)
    }

    /// Buy with `deposit` NEAR at tax `tax_bps` (tax on top of the curve
    /// amount, rounded up). Returns `(tokens, curve_cost, tax)` with
    /// `curve_cost + tax ≤ deposit`, `tokens` maximal.
    pub fn quote_buy(&self, s: u128, deposit: u128, tax_bps: u16) -> (u128, u128, u128) {
        // cost + ceil(cost·τ/B) ≤ dep  ⇔  cost·(B+τ) ≤ dep·B  (B = 10_000).
        let budget = U256::from(deposit) * U256::from(10_000u32)
            / U256::from(10_000u32 + tax_bps as u32);
        let budget = to_u128(budget).unwrap_or(u128::MAX);
        let (tokens, cost) = self.max_buy(s, budget);
        let tax = bps_ceil(cost, tax_bps as u128);
        (tokens, cost, tax)
    }

    /// Sell `delta` at tax `tax_bps` (tax out of the curve amount, rounded
    /// up). Returns `(gross, tax, net)`.
    pub fn quote_sell(&self, s: u128, delta: u128, tax_bps: u16) -> (u128, u128, u128) {
        let gross = self.sell_return(s, delta);
        let tax = bps_ceil(gross, tax_bps as u128).min(gross);
        (gross, tax, gross - tax)
    }
}
