//! The constitution (SPEC §4): lever bounds, per-meeting steps, the clamp and
//! the fallback rule. These are compile-time constants, identical on every
//! network; the token account has no keys, so they can never change.

use near_sdk::near;

pub const TAX_MIN_BPS: i64 = 100;
pub const TAX_MAX_BPS: i64 = 300;
pub const TAX_STEP_BPS: i64 = 50;

pub const ENDOWMENT_MIN: i64 = 30;
pub const ENDOWMENT_MAX: i64 = 100;
pub const ENDOWMENT_STEP: i64 = 10;

pub const LOCKER_MIN: i64 = 0;
pub const LOCKER_MAX: i64 = 50;
pub const LOCKER_STEP: i64 = 10;

/// Buyback-and-burn per meeting: at most this many bps of supply (0.5%),
/// and never more than the buyback fund can pay for.
pub const BUYBACK_MAX_BPS: i64 = 50;

/// The fallback rule: move tax this far toward the target, hold everything else.
pub const FALLBACK_TAX_TARGET_BPS: u16 = 200;
pub const FALLBACK_TAX_STEP_BPS: u16 = 10;

/// Default levers at launch (overridable at `new`, within the constitution).
pub const DEFAULT_LEVERS: Levers = Levers {
    tax_bps: 200,
    endowment_share: 60,
    locker_share: 20,
};

/// The persistent policy levers. Shares are whole percent of the tax;
/// `buyback_share` is the remainder.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Levers {
    pub tax_bps: u16,
    pub endowment_share: u8,
    pub locker_share: u8,
}

impl Levers {
    pub const fn buyback_share(&self) -> u8 {
        100 - self.endowment_share - self.locker_share
    }

    pub fn within_constitution(&self) -> bool {
        let t = self.tax_bps as i64;
        let e = self.endowment_share as i64;
        let l = self.locker_share as i64;
        (TAX_MIN_BPS..=TAX_MAX_BPS).contains(&t)
            && (ENDOWMENT_MIN..=ENDOWMENT_MAX).contains(&e)
            && (LOCKER_MIN..=LOCKER_MAX).contains(&l)
            && e + l <= 100
    }

    /// Splits a tax amount: `(endowment, locker, buyback)`. Endowment and
    /// locker parts round down; the buyback fund takes the remainder.
    pub fn split(&self, tax: u128) -> (u128, u128, u128) {
        let e = tax / 100 * self.endowment_share as u128
            + tax % 100 * self.endowment_share as u128 / 100;
        let l = tax / 100 * self.locker_share as u128 + tax % 100 * self.locker_share as u128 / 100;
        (e, l, tax - e - l)
    }
}

/// The numeric part of a ruling, as the model asked for it.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Asked {
    pub tax_bps: i64,
    pub endowment_share: i64,
    pub locker_share: i64,
    pub buyback_burn: i64,
}

/// One clamp the contract applied. `rule` is `bounds` (outside the lever's
/// range), `step` (moved more than the per-meeting maximum), `sum`
/// (endowment + locker over 100%) or `fund` (buyback larger than the fund).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Clamp {
    pub lever: String,
    pub asked: i64,
    pub applied: i64,
    pub rule: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Clamped {
    pub levers: Levers,
    /// Buyback-and-burn in bps of supply, before the fund limit.
    pub buyback_bps: u16,
    pub clamps: Vec<Clamp>,
}

fn clamp_lever(
    lever: &str,
    asked: i64,
    current: i64,
    (min, max, step): (i64, i64, i64),
    clamps: &mut Vec<Clamp>,
) -> i64 {
    let lo = min.max(current - step);
    let hi = max.min(current + step);
    let (applied, rule) = if asked > hi {
        (hi, if asked > max && hi == max { "bounds" } else { "step" })
    } else if asked < lo {
        (lo, if asked < min && lo == min { "bounds" } else { "step" })
    } else {
        return asked;
    };
    clamps.push(Clamp {
        lever: lever.to_string(),
        asked,
        applied,
        rule: rule.to_string(),
    });
    applied
}

/// Clamps a ruling into the constitution relative to the levers in force.
/// Never rejects: every field lands on the nearest allowed value, and each
/// adjustment is recorded. Order: tax, endowment, locker (bounds and step,
/// then `endowment + locker ≤ 100` by lowering locker), buyback.
///
/// The sum rule never forces locker past its own step: the old levers had
/// `E + L ≤ 100` and endowment rose by at most 10, so `100 − e ≥ L − 10`.
pub fn clamp_ruling(before: Levers, asked: &Asked) -> Clamped {
    let mut clamps = Vec::new();
    let tax = clamp_lever(
        "tax_bps",
        asked.tax_bps,
        before.tax_bps as i64,
        (TAX_MIN_BPS, TAX_MAX_BPS, TAX_STEP_BPS),
        &mut clamps,
    );
    let e = clamp_lever(
        "endowment_share",
        asked.endowment_share,
        before.endowment_share as i64,
        (ENDOWMENT_MIN, ENDOWMENT_MAX, ENDOWMENT_STEP),
        &mut clamps,
    );
    let mut l = clamp_lever(
        "locker_share",
        asked.locker_share,
        before.locker_share as i64,
        (LOCKER_MIN, LOCKER_MAX, LOCKER_STEP),
        &mut clamps,
    );
    if e + l > 100 {
        let applied = 100 - e;
        // Merge with an earlier locker clamp so each lever is reported once.
        if let Some(c) = clamps.iter_mut().find(|c| c.lever == "locker_share") {
            c.applied = applied;
            c.rule = format!("{}+sum", c.rule);
        } else {
            clamps.push(Clamp {
                lever: "locker_share".to_string(),
                asked: asked.locker_share,
                applied,
                rule: "sum".to_string(),
            });
        }
        l = applied;
    }
    let bb = if asked.buyback_burn > BUYBACK_MAX_BPS || asked.buyback_burn < 0 {
        let applied = asked.buyback_burn.clamp(0, BUYBACK_MAX_BPS);
        clamps.push(Clamp {
            lever: "buyback_burn".to_string(),
            asked: asked.buyback_burn,
            applied,
            rule: "bounds".to_string(),
        });
        applied
    } else {
        asked.buyback_burn
    };
    Clamped {
        levers: Levers {
            tax_bps: tax as u16,
            endowment_share: e as u8,
            locker_share: l as u8,
        },
        buyback_bps: bb as u16,
        clamps,
    }
}

/// The fallback rule: tax moves 10 bps toward 200, everything else holds,
/// no buyback.
pub fn fallback(before: Levers) -> Levers {
    let t = before.tax_bps;
    let tax = if t > FALLBACK_TAX_TARGET_BPS {
        t - (t - FALLBACK_TAX_TARGET_BPS).min(FALLBACK_TAX_STEP_BPS)
    } else {
        t + (FALLBACK_TAX_TARGET_BPS - t).min(FALLBACK_TAX_STEP_BPS)
    };
    Levers {
        tax_bps: tax,
        ..before
    }
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Bound {
    pub min: i64,
    pub max: i64,
    pub max_step: Option<i64>,
}

/// The constitution as data (part of `get_constitution`).
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rules {
    pub tax_bps: Bound,
    pub endowment_share: Bound,
    pub locker_share: Bound,
    pub buyback_share: String,
    /// bps of supply per meeting; also limited by the buyback fund.
    pub buyback_burn: Bound,
    pub fallback_tax_target_bps: u16,
    pub fallback_tax_step_bps: u16,
}

pub fn rules() -> Rules {
    Rules {
        tax_bps: Bound {
            min: TAX_MIN_BPS,
            max: TAX_MAX_BPS,
            max_step: Some(TAX_STEP_BPS),
        },
        endowment_share: Bound {
            min: ENDOWMENT_MIN,
            max: ENDOWMENT_MAX,
            max_step: Some(ENDOWMENT_STEP),
        },
        locker_share: Bound {
            min: LOCKER_MIN,
            max: LOCKER_MAX,
            max_step: Some(LOCKER_STEP),
        },
        buyback_share: "100 - endowment_share - locker_share".to_string(),
        buyback_burn: Bound {
            min: 0,
            max: BUYBACK_MAX_BPS,
            max_step: None,
        },
        fallback_tax_target_bps: FALLBACK_TAX_TARGET_BPS,
        fallback_tax_step_bps: FALLBACK_TAX_STEP_BPS,
    }
}
