//! NEP-141 / NEP-145 / NEP-148, buy and sell, tax splits, init validation.

use super::*;

#[test]
fn metadata_is_chair_18() {
    let h = H::new();
    let m = h.c.ft_metadata();
    assert_eq!(m.symbol, "CHAIR");
    assert_eq!(m.decimals, 18);
    assert_eq!(m.spec, "ft-1.0.0");
    assert!(m.icon.unwrap().starts_with("data:image/svg+xml"));
    assert_eq!(h.c.ft_total_supply().0, 0, "no pre-mint");
}

#[test]
fn buy_registers_mints_and_splits_tax() {
    let mut h = H::new();
    let r = h.buy(&alice(), near(1));
    assert!(r.tokens.0 > 0);
    // Storage taken first, then cost + tax, remainder refunded.
    assert_eq!(STORAGE_DEPOSIT + r.cost.0 + r.tax.0 + r.refund.0, near(1));
    assert_eq!(r.tax.0, crate::curve::bps_ceil(r.cost.0, 200));
    assert_eq!(h.balance(&alice()), r.tokens.0);
    assert_eq!(h.c.ft_total_supply().0, r.tokens.0);
    assert_eq!(h.c.reserve, r.cost.0);
    assert_eq!(h.c.sold, r.tokens.0);
    // Default levers 60/20/20.
    let (e, l, b) = h.c.levers.split(r.tax.0);
    assert_eq!(h.c.endowment_pending, e);
    assert_eq!(h.c.locker_pool, l);
    assert_eq!(h.c.buyback_fund, b);
    assert_eq!(e + l + b, r.tax.0);
    let mint = event("ft_mint").unwrap();
    assert_eq!(mint["owner_id"], "alice.near");
    assert_eq!(mint["amount"], r.tokens.0.to_string());
    if r.refund.0 > 0 {
        assert!(transfers().contains(&("alice.near".to_string(), r.refund.0)));
    }
    assert!(h.c.storage_balance_of(alice()).is_some());
    assert_eq!(h.c.holders, 1);
}

#[test]
fn quote_buy_matches_buy() {
    let mut h = H::new();
    h.buy(&bob(), near(3));
    h.as_(&alice(), 0);
    let q = h.c.quote_buy(U128(near(2)), Some(alice()));
    assert_eq!(q.storage.0, STORAGE_DEPOSIT);
    let r = h.buy(&alice(), near(2));
    assert_eq!((q.tokens, q.cost, q.tax, q.refund), (r.tokens, r.cost, r.tax, r.refund));
    assert_eq!(q.price_after.0, h.c.curve().price(h.c.sold));
    // Registered: no storage.
    h.as_(&alice(), 0);
    assert_eq!(h.c.quote_buy(U128(near(1)), Some(alice())).storage.0, 0);
}

#[test]
fn buy_slippage_guard() {
    let mut h = H::new();
    h.as_(&alice(), near(1));
    expect_panic(|| { h.c.buy(U128(tokens(10_000_000))); }, "slippage");
}

#[test]
fn buy_needs_more_than_storage_when_unregistered() {
    let mut h = H::new();
    h.as_(&alice(), STORAGE_DEPOSIT);
    expect_panic(|| { h.c.buy(U128(0)); }, "registration plus the purchase");
}

#[test]
fn sell_pays_net_burns_and_splits_tax() {
    let mut h = H::new();
    let b = h.buy(&alice(), near(5));
    let before = (h.c.endowment_pending, h.c.locker_pool, h.c.buyback_fund);
    let amount = b.tokens.0 / 3;
    h.as_(&alice(), 0);
    let q = h.c.quote_sell(U128(amount));
    let s = h.sell(&alice(), amount);
    assert_eq!((q.gross, q.tax, q.near_out), (s.gross, s.tax, s.near_out));
    assert_eq!(s.gross.0 - s.tax.0, s.near_out.0);
    assert_eq!(s.tax.0, crate::curve::bps_ceil(s.gross.0, 200));
    assert_eq!(h.balance(&alice()), b.tokens.0 - amount);
    assert_eq!(h.c.supply, b.tokens.0 - amount);
    assert_eq!(h.c.reserve, b.cost.0 - s.gross.0);
    let (e, l, bb) = h.c.levers.split(s.tax.0);
    assert_eq!(h.c.endowment_pending, before.0 + e);
    assert_eq!(h.c.locker_pool, before.1 + l);
    assert_eq!(h.c.buyback_fund, before.2 + bb);
    assert!(transfers().contains(&("alice.near".to_string(), s.near_out.0)));
    assert_eq!(event("ft_burn").unwrap()["amount"], amount.to_string());
}

#[test]
fn full_exit_returns_reserve_to_zero() {
    let mut h = H::new();
    let a = h.buy(&alice(), near(2));
    let b = h.buy(&bob(), near(7));
    h.sell(&alice(), a.tokens.0);
    h.sell(&bob(), b.tokens.0);
    assert_eq!(h.c.supply, 0);
    assert_eq!(h.c.sold, 0);
    assert_eq!(h.c.reserve, 0, "path-independent curve leaves nothing behind");
}

#[test]
fn sell_slippage_and_one_yocto() {
    let mut h = H::new();
    let b = h.buy(&alice(), near(1));
    h.as_(&alice(), 0);
    expect_panic(|| { h.c.sell(U128(1), U128(0)); }, "1 yoctoNEAR");
    h.as_(&alice(), 1);
    expect_panic(|| { h.c.sell(U128(b.tokens.0), U128(near(1))); }, "slippage");
}

#[test]
fn sell_more_than_balance_fails() {
    let mut h = H::new();
    let b = h.buy(&alice(), near(1));
    h.as_(&alice(), 1);
    expect_panic(|| { h.c.sell(U128(b.tokens.0 + 1), U128(0)); }, "not enough unlocked");
}

#[test]
fn ft_transfer_moves_tokens_and_needs_registration() {
    let mut h = H::new();
    let b = h.buy(&alice(), near(1));
    h.buy(&bob(), milli(100));
    let bob0 = h.balance(&bob());
    h.as_(&alice(), 1);
    h.c.ft_transfer(bob(), U128(1_000), Some("hi".into()));
    assert_eq!(h.balance(&alice()), b.tokens.0 - 1_000);
    assert_eq!(h.balance(&bob()), bob0 + 1_000);
    let ev = event("ft_transfer").unwrap();
    assert_eq!(ev["old_owner_id"], "alice.near");
    assert_eq!(ev["memo"], "hi");
    h.as_(&alice(), 1);
    expect_panic(|| h.c.ft_transfer(carol(), U128(1), None), "not registered");
    h.as_(&alice(), 0);
    expect_panic(|| h.c.ft_transfer(bob(), U128(1), None), "1 yoctoNEAR");
}

#[test]
fn ft_transfer_call_and_resolve_refund_unused() {
    let mut h = H::new();
    let b = h.buy(&alice(), near(1));
    h.buy(&bob(), milli(100));
    let bob0 = h.balance(&bob());
    h.as_(&alice(), 1);
    let _ = h.c.ft_transfer_call(bob(), U128(5_000), None, "msg".into());
    let c = calls();
    assert!(c.iter().any(|c| c.receiver == "bob.near" && c.method == "ft_on_transfer"));
    // Receiver used 3_000 of 5_000: 2_000 come back.
    testing_env!(
        ctx(&token(), 0, h.now).build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Successful(b"\"2000\"".to_vec())]
    );
    let used = h.c.ft_resolve_transfer(alice(), bob(), U128(5_000));
    assert_eq!(used.0, 3_000);
    assert_eq!(h.balance(&alice()), b.tokens.0 - 3_000);
    assert_eq!(h.balance(&bob()), bob0 + 3_000);
}

#[test]
fn resolve_never_takes_back_locked_tokens() {
    let mut h = H::new();
    h.buy(&alice(), near(1));
    h.buy(&bob(), milli(50));
    h.as_(&alice(), 1);
    let _ = h.c.ft_transfer_call(bob(), U128(tokens(1_000)), None, "lock it".into());
    // Bob locks everything he has (inside ft_on_transfer, say).
    let all = h.balance(&bob());
    h.lock(&bob(), all, 7);
    testing_env!(
        ctx(&token(), 0, h.now).build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Failed]
    );
    let used = h.c.ft_resolve_transfer(alice(), bob(), U128(tokens(1_000)));
    assert_eq!(used.0, tokens(1_000), "locked tokens stay with the receiver");
    assert_eq!(h.balance(&bob()), all);
}

#[test]
fn storage_register_and_unregister() {
    let mut h = H::new();
    assert_eq!(h.c.storage_balance_bounds().min.0, STORAGE_DEPOSIT);
    h.as_(&carol(), STORAGE_DEPOSIT + 5);
    let sb = h.c.storage_deposit(None, None);
    assert_eq!(sb.total.0, STORAGE_DEPOSIT);
    assert!(transfers().contains(&("carol.near".to_string(), 5)));
    // Second deposit is refunded in full.
    h.as_(&carol(), 7);
    h.c.storage_deposit(None, Some(true));
    assert!(transfers().contains(&("carol.near".to_string(), 7)));
    h.as_(&carol(), 1);
    assert!(h.c.storage_unregister(None));
    assert!(transfers().contains(&("carol.near".to_string(), STORAGE_DEPOSIT)));
    assert!(h.c.storage_balance_of(carol()).is_none());
    h.as_(&carol(), 1);
    assert!(!h.c.storage_unregister(None));
}

#[test]
fn storage_deposit_below_minimum_fails() {
    let mut h = H::new();
    h.as_(&carol(), STORAGE_DEPOSIT - 1);
    expect_panic(|| { h.c.storage_deposit(None, None); }, "0.025 NEAR");
}

#[test]
fn force_unregister_burns_but_leaves_s() {
    let mut h = H::new();
    let a = h.buy(&alice(), near(1));
    h.buy(&bob(), near(1));
    let sold = h.c.sold;
    h.as_(&alice(), 1);
    expect_panic(|| { h.c.storage_unregister(None); }, "force");
    h.as_(&alice(), 1);
    assert!(h.c.storage_unregister(Some(true)));
    assert_eq!(h.c.sold, sold);
    assert_eq!(h.c.burned, a.tokens.0);
    assert_eq!(h.c.supply + h.c.burned, h.c.sold);
}

#[test]
fn storage_withdraw_has_nothing_available() {
    let mut h = H::new();
    h.buy(&alice(), near(1));
    h.as_(&alice(), 1);
    assert_eq!(h.c.storage_withdraw(None).available.0, 0);
    h.as_(&alice(), 1);
    expect_panic(|| { h.c.storage_withdraw(Some(U128(1))); }, "no storage balance");
}

#[test]
fn volume_24h_rolls_off() {
    let mut h = H::new();
    let a = h.buy(&alice(), near(1));
    h.advance(3 * HOUR_NS);
    let s = h.sell(&alice(), a.tokens.0 / 2);
    h.as_(&alice(), 0);
    assert_eq!(h.c.volume_24h(), (a.cost.0, s.gross.0));
    h.advance(22 * HOUR_NS);
    h.as_(&alice(), 0);
    assert_eq!(h.c.volume_24h(), (0, s.gross.0), "the buy is 25 h old");
    h.advance(3 * HOUR_NS);
    h.as_(&alice(), 0);
    assert_eq!(h.c.volume_24h(), (0, 0));
}

#[test]
fn get_curve_reports_floor_and_locked_reserve() {
    let mut h = H::new();
    h.buy(&alice(), near(2));
    h.as_(&alice(), 0);
    let v = h.c.get_curve();
    assert_eq!(v.integral.0, h.c.reserve);
    assert_eq!(v.price.0, P0 + K * v.sold.0 / ONE_TOKEN);
    assert_eq!(v.floor_price.0, P0, "nothing burned yet");
    assert_eq!(v.locked_reserve.0, 0);
}

// ------------------------------------------------------------ init validation

fn try_new(f: impl FnOnce(&mut OutlayerConfig, &mut Vec<Tier>, &mut CurveParams, &mut u64) -> Option<Levers>) {
    testing_env!(ctx(&owner(), 0, T0).build());
    let mut o = outlayer_config();
    let mut l = ladder();
    let mut c = CurveParams {
        p0: U128(P0),
        k: U128(K),
    };
    let mut interval = INTERVAL_S;
    let levers = f(&mut o, &mut l, &mut c, &mut interval);
    Chair::new(
        owner(),
        brain(),
        o,
        c,
        l,
        vec![address_str(&model_sk())],
        vec![address_str(&gateway_sk())],
        interval,
        U128(FEE),
        levers,
    );
}

#[test]
fn new_rejects_levers_outside_the_constitution() {
    expect_panic(
        || {
            try_new(|_, _, _, _| {
                Some(Levers {
                    tax_bps: 400,
                    endowment_share: 60,
                    locker_share: 20,
                })
            })
        },
        "outside the constitution",
    );
    expect_panic(
        || {
            try_new(|_, _, _, _| {
                Some(Levers {
                    tax_bps: 200,
                    endowment_share: 70,
                    locker_share: 40,
                })
            })
        },
        "outside the constitution",
    );
    // v2: locker_share above 25 is out even when the shares sum to under 100.
    expect_panic(
        || {
            try_new(|_, _, _, _| {
                Some(Levers {
                    tax_bps: 200,
                    endowment_share: 60,
                    locker_share: 26,
                })
            })
        },
        "outside the constitution",
    );
}

#[test]
fn new_rejects_bad_ladder_and_config() {
    expect_panic(
        || {
            try_new(|_, l, _, _| {
                l.swap(0, 1);
                None
            })
        },
        "increase",
    );
    expect_panic(
        || {
            try_new(|_, l, _, _| {
                l[0].model = "bad:model".into();
                None
            })
        },
        "model ids",
    );
    expect_panic(
        || {
            try_new(|o, _, _, _| {
                o.version_key = "abc".into();
                None
            })
        },
        "version_key",
    );
    expect_panic(
        || {
            try_new(|_, _, c, _| {
                c.p0 = U128(0);
                None
            })
        },
        "p0",
    );
    expect_panic(
        || {
            try_new(|_, _, _, i| {
                *i = 10;
                None
            })
        },
        "meeting_interval_s",
    );
    expect_panic(
        || {
            try_new(|o, _, _, _| {
                o.secrets_owner = None;
                None
            })
        },
        "secrets_profile",
    );
}

#[test]
fn new_rejects_bad_signers() {
    testing_env!(ctx(&owner(), 0, T0).build());
    expect_panic(
        || {
            Chair::new(
                owner(),
                brain(),
                outlayer_config(),
                CurveParams {
                    p0: U128(P0),
                    k: U128(K),
                },
                ladder(),
                vec!["0x1234".into()],
                vec![],
                INTERVAL_S,
                U128(FEE),
                None,
            );
        },
        "20-byte hex",
    );
    let a = address_str(&model_sk());
    expect_panic(
        || {
            Chair::new(
                owner(),
                brain(),
                outlayer_config(),
                CurveParams {
                    p0: U128(P0),
                    k: U128(K),
                },
                ladder(),
                vec![],
                vec![a.clone(), a.to_uppercase().replace("0X", "0x")],
                INTERVAL_S,
                U128(FEE),
                None,
            );
        },
        "duplicate",
    );
}

#[test]
fn constitution_view_exposes_fixed_parameters() {
    let h = H::new();
    let v = h.c.get_constitution();
    assert_eq!(v.meeting_interval_s, INTERVAL_S);
    assert_eq!(v.ladder, ladder());
    assert_eq!(v.lock_days, vec![1, 7, 30]);
    assert_eq!(v.petition_fee.0, FEE);
    assert_eq!(v.change_timelock_s, 48 * 3600);
    assert_eq!(v.system_prompt, SYSTEM_PROMPT);
    assert_eq!(v.rules.tax_bps.max, 300);
    assert_eq!(v.owner, owner());
    assert_eq!(v.outlayer, outlayer_config());
}
