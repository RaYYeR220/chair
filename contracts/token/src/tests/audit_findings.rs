//! Security review regressions (2026-11-10). Each finding's proof of concept
//! now asserts the fixed behaviour; the hardening items have their own
//! tests. Run them alone with:
//!
//! ```text
//! AWS_LC_SYS_PREBUILT_NASM=1 cargo test audit_
//! ```

use super::*;

fn transfer(h: &mut H, from: &AccountId, to: &AccountId, amount: u128) {
    h.as_(from, 1);
    h.c.ft_transfer(to.clone(), U128(amount), None);
}

fn brief_of(req: &str) -> Value {
    let body: Value = sj::from_str(req).unwrap();
    sj::from_str(body["messages"][1]["content"].as_str().unwrap()).unwrap()
}

/// `(from, weight in CHAIR-days)` of a brief's petitions.
fn brief_petitions(req: &str) -> Vec<(String, String)> {
    brief_of(req)["petitions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| {
            (
                p["from"].as_str().unwrap().to_string(),
                p["weight"].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

// ---------------------------------------------------------------- F1 stale petition weight

/// Fixed: a petition's weight is recomputed at `convene` from the locks still
/// active then. Tokens whose lock expired and that another account relocked
/// fill one brief slot, not two.
#[test]
fn audit_f1_relocked_tokens_fill_one_brief_slot() {
    let mut h = H::new();
    h.buy(&alice(), near(5));
    h.buy(&bob(), near(1));
    h.report(near(10));
    let x = tokens(100_000);
    // Alice locks for a day and petitions late in that day.
    h.lock(&alice(), x, 1);
    h.advance(20 * HOUR_NS);
    let filed = h.petition(&alice(), "alice: raise locker_share");
    assert_eq!(filed.weight.0, x);
    // Her lock expires; the same tokens move to Bob, who locks and petitions.
    h.advance(4 * HOUR_NS + SEC_NS);
    transfer(&mut h, &alice(), &bob(), x);
    h.lock(&bob(), x, 1);
    h.petition(&bob(), "bob: raise locker_share");
    assert_eq!(h.c.get_petitions().len(), 2, "both queued at filing weight");
    h.convene_awake();
    let req = h.c.get_last_request().unwrap();
    assert_eq!(
        brief_petitions(&req),
        vec![("bob.near".to_string(), "100000".to_string())],
        "alice's expired lock no longer counts"
    );
    let claimed: u128 = brief_petitions(&req)
        .iter()
        .map(|(_, w)| w.parse::<u128>().unwrap() * ONE_TOKEN)
        .sum();
    assert!(claimed <= h.c.total_weight);
    assert_eq!(h.meeting(h.c.meeting_count).petitions, 1);
    // The convene event shows the reweighing.
    let ev = event("meeting_convened").unwrap();
    let rw = ev["reweighed"].as_array().unwrap();
    let alice_row = rw.iter().find(|r| r["account_id"] == "alice.near").unwrap();
    assert_eq!(alice_row["filed_weight"], x.to_string());
    assert_eq!(alice_row["weight"], "0");
    assert_eq!(alice_row["in_brief"], false);
    let bob_row = rw.iter().find(|r| r["account_id"] == "bob.near").unwrap();
    assert_eq!(bob_row["in_brief"], true);
}

/// Fixed: filing needs a lock that runs past the next possible meeting; a
/// lock ending before it cannot carry a petition.
#[test]
fn audit_f1_petition_needs_a_lock_past_the_next_meeting() {
    let mut h = H::new();
    h.buy(&alice(), near(5));
    h.lock(&alice(), tokens(1_000), 1);
    // A meeting 100 s before the lock ends pushes the next one 300 s out.
    h.advance(DAY_NS - 100 * SEC_NS);
    let _ = h.convene();
    assert!(h.c.next_meeting_at > h.now + 100 * SEC_NS);
    h.as_(&alice(), 1);
    expect_panic(
        || {
            h.c.petition("too late".into());
        },
        "runs past the next meeting",
    );
    // A fresh 7-day lock outlasts it and carries only its own weight.
    h.lock(&alice(), tokens(10), 7);
    let p = h.petition(&alice(), "on time");
    assert_eq!(p.weight.0, tokens(70));
}

/// Fixed: dropping a petitioner whose lock expired frees its slot for the
/// next heaviest queued petition, which the old top-3-at-filing list had
/// already thrown away.
#[test]
fn audit_f1_a_dropped_petition_frees_its_slot() {
    let mut h = H::new();
    let ps = [("w1.near", 100u128, 1u8), ("w2.near", 9, 7), ("w3.near", 8, 7), ("w4.near", 7, 7)];
    for (a, _, _) in &ps {
        h.buy(&acc(a), near(1));
    }
    h.report(near(10));
    // w1 locks first for a day; the others lock later for a week.
    h.lock(&acc("w1.near"), tokens(100), 1);
    h.advance(23 * HOUR_NS);
    for (a, amount, days) in &ps[1..] {
        h.lock(&acc(a), tokens(*amount), *days);
    }
    for (a, _, _) in &ps {
        h.petition(&acc(a), a);
    }
    let queued: Vec<String> = h.c.get_petitions().iter().map(|p| p.text.clone()).collect();
    // w1 (100 CHAIR-days) heads the queue; w4 (49) is fourth, outside the old top 3.
    assert_eq!(queued, vec!["w1.near", "w2.near", "w3.near", "w4.near"]);
    // w1's lock ends before the meeting is convened.
    h.advance(2 * HOUR_NS);
    h.convene_awake();
    let brief = brief_petitions(&h.c.get_last_request().unwrap());
    let from: Vec<&str> = brief.iter().map(|(f, _)| f.as_str()).collect();
    assert_eq!(from, vec!["w2.near", "w3.near", "w4.near"]);
}

/// Fixed: with meetings more than a day apart, one account's second petition
/// replaces its first, so one lock never backs two queued petitions.
#[test]
fn audit_f1_one_queued_petition_per_account() {
    let mut h = H::new();
    h.buy(&alice(), near(5));
    h.lock(&alice(), tokens(1_000), 30);
    h.petition(&alice(), "first");
    h.advance(DAY_NS);
    h.petition(&alice(), "second");
    let q = h.c.get_petitions();
    assert_eq!(q.len(), 1);
    assert_eq!(q[0].text, "second");
    h.report(near(10));
    h.convene_awake();
    assert_eq!(brief_petitions(&h.c.get_last_request().unwrap()).len(), 1);
}

/// The queue keeps the `MAX_PENDING_PETITIONS` heaviest at filing.
#[test]
fn audit_f1_queue_is_bounded() {
    let mut h = H::new();
    let n = MAX_PENDING_PETITIONS + 2;
    for i in 0..n {
        let a = acc(&format!("q{i}.near"));
        h.buy(&a, near(1));
        h.lock(&a, tokens(10 + i as u128), 7);
        h.petition(&a, &format!("q{i}"));
    }
    let q = h.c.get_petitions();
    assert_eq!(q.len(), MAX_PENDING_PETITIONS);
    assert_eq!(q[0].text, format!("q{}", n - 1), "heaviest first");
    assert!(q.iter().all(|p| p.text != "q0" && p.text != "q1"), "lightest dropped");
    // A petition too light for a full queue is filed (fee burned) but not queued.
    let a = acc("light.near");
    h.buy(&a, near(1));
    h.lock(&a, tokens(1), 7);
    h.petition(&a, "too light");
    let ev = event("petition_filed").unwrap();
    assert_eq!((ev["queued"].clone(), ev["in_brief"].clone()), (json!(false), json!(false)));
    assert_eq!(h.c.get_petitions().len(), MAX_PENDING_PETITIONS);
}

// ---------------------------------------------------------------- F2 regrinding the brief

/// Fixed: the brief carries a seed drawn from the convening block's
/// randomness. Before `convene` nobody knows the exact request, so grinding
/// it with dust buys buys nothing; the preview says so.
#[test]
fn audit_f2_the_request_is_unknown_until_convene() {
    let mut h = H::new();
    h.buy(&alice(), near(5));
    h.buy(&bob(), near(1));
    h.report(near(10));
    h.now = h.c.next_meeting_at;
    h.as_(&carol(), 0);
    let before = h.c.get_request_preview();
    assert_eq!(before.seed_placeholder, SEED_PLACEHOLDER);
    let preview = before.request.unwrap();
    assert_eq!(brief_of(&preview)["seed"], SEED_PLACEHOLDER);

    // Convene with a known block seed: the brief carries its first 16 bytes.
    let block_seed: [u8; 32] = std::array::from_fn(|i| 0xa0 + i as u8);
    testing_env!(ctx(&cranker(), OUTLAYER_DEPOSIT, h.now)
        .random_seed(block_seed)
        .build());
    let _ = h.c.convene();
    let n = h.c.meeting_count;
    let req = h.c.get_last_request().unwrap();
    let seed = hexs(&block_seed[..16]);
    assert_eq!(seed.len(), 32);
    assert_eq!(brief_of(&req)["seed"], seed);
    assert_eq!(h.meeting(n).seed.as_deref(), Some(seed.as_str()));
    assert_eq!(event("meeting_convened").unwrap()["seed"], seed);
    // The preview was the same request but for the seed.
    assert_eq!(preview.replace(SEED_PLACEHOLDER, &seed), req);
    // `seed` is the brief's second field.
    let brief_str = sj::from_str::<Value>(&req).unwrap()["messages"][1]["content"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(brief_str.starts_with(&format!(r#"{{"meeting":{n},"seed":"{seed}","supply":"#)));
}

/// Fixed: the same state convened under two block seeds yields two requests,
/// so a request cannot be pre-shopped.
#[test]
fn audit_f2_same_state_different_seed_different_request() {
    let run = |seed: [u8; 32]| {
        let mut h = H::new();
        h.buy(&alice(), near(5));
        h.report(near(10));
        h.now = h.c.next_meeting_at;
        testing_env!(ctx(&cranker(), OUTLAYER_DEPOSIT, h.now)
            .random_seed(seed)
            .build());
        let _ = h.c.convene();
        h.meeting(h.c.meeting_count).request_sha256.unwrap()
    };
    let a = run([1; 32]);
    assert_eq!(a, run([1; 32]), "deterministic for one seed");
    assert_ne!(a, run([2; 32]));
}

// ---------------------------------------------------------------- F3 uncapped refund

/// Fixed: `convene` takes exactly the configured OutLayer deposit, and a
/// failed result refunds at most that.
#[test]
fn audit_f3_convene_takes_exactly_the_outlayer_deposit() {
    for bad in [near(500), OUTLAYER_DEPOSIT + 1, OUTLAYER_DEPOSIT - 1, 0] {
        let mut h = H::new();
        h.buy(&alice(), near(5));
        h.report(near(10));
        h.now = h.c.next_meeting_at;
        h.as_(&cranker(), bad);
        expect_panic(
            || {
                let _ = h.c.convene();
            },
            "attach exactly",
        );
    }
    let mut h = H::new();
    h.buy(&alice(), near(5));
    h.report(near(10));
    let n = h.convene_awake();
    assert_eq!(h.meeting(n).deposit.0, OUTLAYER_DEPOSIT);
    h.deliver(n, PromiseResult::Failed);
    let refunds: Vec<u128> = transfers()
        .into_iter()
        .filter(|(to, _)| to == "crank.near")
        .map(|(_, a)| a)
        .collect();
    assert_eq!(refunds, vec![OUTLAYER_DEPOSIT]);
}

/// Fixed: even a meeting record claiming a larger deposit refunds one
/// OutLayer deposit at most.
#[test]
fn audit_f3_failed_result_refund_is_capped() {
    let mut h = H::new();
    h.buy(&alice(), near(5));
    h.report(near(10));
    let n = h.convene_awake();
    let mut m = h.meeting(n);
    m.deposit = U128(near(500));
    h.c.meetings.insert(n, m);
    h.deliver(n, PromiseResult::Failed);
    let refund: u128 = transfers()
        .into_iter()
        .filter(|(to, _)| to == "crank.near")
        .map(|(_, a)| a)
        .sum();
    assert_eq!(refund, OUTLAYER_DEPOSIT);
}

/// An asleep meeting asks no model: any deposit comes back at once.
#[test]
fn audit_f3_asleep_convene_refunds_whatever_is_attached() {
    let mut h = H::new();
    h.buy(&alice(), near(5));
    h.now = h.c.next_meeting_at;
    h.as_(&cranker(), milli(1));
    let _ = h.c.convene();
    assert!(transfers().contains(&("crank.near".to_string(), milli(1))));
}

// ---------------------------------------------------------------- F4 lapsed meeting

/// Fixed: a meeting whose ruling never lands lapses at the next `convene`,
/// which runs the fallback rule for it (reason `lapsed`) before convening.
#[test]
fn audit_f4_lapsed_meeting_runs_the_fallback() {
    let mut h = H::with_levers(Some(Levers {
        tax_bps: 300,
        endowment_share: 60,
        locker_share: 20,
    }));
    h.buy(&alice(), near(5));
    h.lock(&alice(), tokens(1_000), 7);
    let n1 = h.convene_awake();
    // More trading after meeting 1 convened: endowment and locker pool to settle.
    h.buy(&bob(), near(5));
    let (endow, pool) = (h.c.endowment_pending, h.c.locker_pool);
    assert!(endow > 0 && pool > 0);
    let n2 = h.convene_awake();
    let m1 = h.meeting(n1);
    assert_eq!(m1.status, MeetingStatus::Lapsed);
    let o = m1.outcome.expect("the lapsed meeting has an outcome");
    assert_eq!(o.kind, OutcomeKind::Fallback);
    assert_eq!(o.reason.as_deref(), Some("lapsed"));
    assert_eq!(o.levers.tax_bps, 290);
    assert_eq!(o.endowment_sent.0, endow);
    assert_eq!(o.locker_paid.0, pool);
    assert!(transfers().contains(&("brain.chair.near".to_string(), endow)));
    assert_eq!(h.c.levers.tax_bps, 290);
    // Meeting 2 starts from the fallback's levers.
    assert_eq!(h.meeting(n2).levers_before.tax_bps, 290);
    assert_eq!(h.c.open_meeting, Some(n2));
    assert_eq!((h.c.stats.lapsed, h.c.stats.fallbacks), (1, 1));
    let held: Vec<Value> = events()
        .into_iter()
        .filter(|(e, _)| e == "meeting_held")
        .map(|(_, d)| d)
        .collect();
    assert_eq!(held.len(), 1);
    assert_eq!(held[0]["meeting"], n1);
    assert_eq!(held[0]["reason"], "lapsed");
    assert!(event("meeting_lapsed").is_some());
}

/// A lapse costs gas: `convene` asks for 20 TGas more when it must run one.
#[test]
fn audit_f4_convene_after_a_lapse_needs_more_gas() {
    let mut h = H::new();
    h.buy(&alice(), near(5));
    h.convene_awake();
    h.now = h.c.next_meeting_at;
    testing_env!(ctx(&cranker(), OUTLAYER_DEPOSIT, h.now)
        .prepaid_gas(Gas::from_tgas(230))
        .build());
    expect_panic(
        || {
            let _ = h.c.convene();
        },
        "240 after a lapse",
    );
}

// ---------------------------------------------------------------- hardening

/// `ft_resolve_transfer` gets at least 15 TGas.
#[test]
fn audit_resolve_transfer_gets_15_tgas() {
    let mut h = H::new();
    h.buy(&alice(), near(5));
    h.buy(&bob(), near(1));
    h.as_(&alice(), 1);
    let _ = h.c.ft_transfer_call(bob(), U128(5_000), None, "msg".into());
    let gas = get_created_receipts()
        .into_iter()
        .flat_map(|r| r.actions)
        .find_map(|a| match a {
            MockAction::FunctionCallWeight {
                method_name,
                prepaid_gas,
                ..
            } if method_name == b"ft_resolve_transfer" => Some(prepaid_gas),
            _ => None,
        })
        .unwrap();
    assert!(gas >= Gas::from_tgas(15), "{gas:?}");
    assert_eq!(GAS_FOR_RESOLVE_TRANSFER, Gas::from_tgas(15));
}

/// A `response_text` over 64 KiB is `unparseable`, even when validly signed;
/// at exactly 64 KiB it is checked as usual.
#[test]
fn audit_response_text_over_64_kib_is_unparseable() {
    let mut h = H::new();
    h.buy(&alice(), near(5));
    h.report(near(10));
    let n = h.convene_awake();
    let m = h.meeting(n);
    let (model, req) = (m.model.unwrap(), m.request_sha256.unwrap());
    // A valid ruling whose minutes pad the completion to `len` bytes.
    let signed_at = |len: usize| {
        let content = |pad: usize| {
            json!({
                "tax_bps": 250, "endowment_share": 60, "locker_share": 20, "buyback_burn": 0,
                "minutes": "x".repeat(pad), "answers": []
            })
            .to_string()
        };
        let base = chat_response(&model, &content(0)).len();
        let resp = chat_response(&model, &content(len - base));
        assert_eq!(resp.len(), len);
        let text = format!("{model}:{req}:{}", hexs(&sha256(resp.as_bytes())));
        let sig = eth_sign(&model_sk(), &text);
        (resp, text, sig)
    };
    let (r, t, s) = signed_at(MAX_RESPONSE_BYTES);
    h.as_(&alice(), 0);
    assert!(h.c.preview_ruling(r, t, s, n).valid, "64 KiB exactly is checked");
    let (r, t, s) = signed_at(MAX_RESPONSE_BYTES + 1);
    h.as_(&alice(), 0);
    assert_eq!(
        h.c.preview_ruling(r.clone(), t.clone(), s.clone(), n).reason.as_deref(),
        Some("unparseable")
    );
    let m = h.deliver(n, PromiseResult::Successful(courier(&r, &t, &s))).unwrap();
    let o = m.outcome.unwrap();
    assert_eq!(o.kind, OutcomeKind::Fallback);
    assert_eq!(o.reason.as_deref(), Some("unparseable"));
    assert_eq!(o.response_sha256, None, "never hashed");
}

/// Contract-level storage (root state, meeting records, the last request,
/// the petition queue, the expiry list) stays bounded however many meetings
/// run, at worst-case sizes: 64-character accounts, 128-character models,
/// full signer lists, a pending change, every lever clamped. The token pays
/// for it from its own balance (accounts pay for their own records), so
/// `docs/LAUNCH.md` funds the token account from this number.
#[test]
fn audit_contract_level_storage_is_bounded() {
    /// Bytes NEAR charges for one record: key + value + 40.
    fn record(key: &[u8]) -> u64 {
        env::storage_read(key).map_or(0, |v| (key.len() + v.len() + 40) as u64)
    }
    fn contract_level(h: &mut H) -> (u64, u64, u64) {
        h.c.accounts.flush();
        h.c.buckets.flush();
        h.c.popped.flush();
        h.c.meetings.flush();
        h.c.expiry.flush();
        h.c.petitions.flush();
        h.c.last_request.flush();
        env::state_write(&h.c);
        let n = h.c.meeting_count;
        let first = n.saturating_sub(MEETING_RETENTION - 1).max(1);
        let meetings: u64 = (first..=n)
            .map(|i| {
                let mut k = b"m".to_vec();
                k.extend_from_slice(&i.to_le_bytes());
                record(&k)
            })
            .sum();
        let rest = record(b"STATE") + record(b"r") + record(b"q") + record(b"x");
        (meetings + rest, meetings, rest)
    }

    let mut h = H::new();
    // Worst-case configuration: eight 128-character models, 16 + 16 signers
    // and a pending change naming 16 + 16 more and a new courier.
    let model = |i: usize| format!("{}{i}", "m".repeat(127));
    h.c.ladder = (0..MAX_TIERS)
        .map(|i| Tier {
            min_endowment: U128(near(1) * (i as u128 + 1)),
            model: model(i),
        })
        .collect();
    let addr = |i: u8| [i; 20];
    h.c.model_signers = (0..16).map(addr).collect();
    h.c.gateway_signers = (16..32).map(addr).collect();
    h.c.model_signers[0] = address(&model_sk());
    h.c.pending_change = Some(PendingChange {
        model_signers: Some((32..48).map(addr).collect()),
        gateway_signers: Some((48..64).map(addr).collect()),
        courier: Some(CourierVersion {
            project_id: "p".repeat(128),
            version_key: "f".repeat(64),
        }),
        proposed_at: 0,
        eta: u64::MAX,
    });
    let long = |p: &str, i: usize| acc(&format!("{}{i:02}.near", p.repeat(57)));
    let cranker = long("c", 0);
    h.buy(&alice(), near(50));
    for i in 0..MAX_PENDING_PETITIONS {
        h.buy(&long("p", i), near(1));
    }
    h.report(near(10));
    let mut peak = (0, 0, 0);
    for _ in 0..(MEETING_RETENTION as usize + 6) {
        // A full queue every meeting, 280 four-byte characters each.
        for i in 0..MAX_PENDING_PETITIONS {
            let a = long("p", i);
            h.as_(&a, 0);
            h.c.unlock();
            h.lock(&a, tokens(10 + i as u128), 1);
            h.petition(&a, &"🪑".repeat(280));
        }
        let queued = contract_level(&mut h);
        if queued.0 > peak.0 {
            peak = queued;
        }
        h.now = h.now.max(h.c.next_meeting_at);
        h.as_(&cranker, OUTLAYER_DEPOSIT);
        let _ = h.c.convene();
        let n = h.c.meeting_count;
        let content = json!({
            "tax_bps": i64::MAX, "endowment_share": i64::MIN, "locker_share": 999,
            "buyback_burn": 10_000, "minutes": "m".repeat(1_000),
            "answers": ["a".repeat(280), "b".repeat(280), "c".repeat(280)]
        })
        .to_string();
        let o = h.deliver_signed(n, &content).outcome.unwrap();
        assert_eq!(o.clamps.len(), 4);
        let now = contract_level(&mut h);
        if now.0 > peak.0 {
            peak = now;
        }
        // A fresh day for the next petitions; yesterday's locks have ended.
        h.advance(DAY_NS + HOUR_NS);
    }
    let (total, meetings, rest) = peak;
    println!(
        "contract-level storage, worst case: {total} B = {meetings} B for {MEETING_RETENTION} meeting records ({} B each) + {rest} B root, last request, queue, expiry list; {} NEAR",
        meetings / MEETING_RETENTION,
        crate::util::decimal(total as u128 * 10u128.pow(19), 24)
    );
    // LAUNCH.md asks for 2 NEAR (200 KB) on top of the code.
    assert!(total < 150_000, "contract-level storage reached {total} bytes");
}
