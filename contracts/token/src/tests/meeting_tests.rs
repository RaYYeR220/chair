//! The meeting: guard, IQ ladder, request bytes, signature verification,
//! clamp and apply, first-valid-result-only, preview, signer timelock.

use super::*;

/// Trades so every fund holds NEAR, then an awake meeting.
fn traded() -> H {
    let mut h = H::new();
    h.buy(&alice(), near(20));
    h.buy(&bob(), near(20));
    let a = h.balance(&alice());
    h.sell(&alice(), a / 2);
    h.report(near(10));
    h
}

fn preview(h: &H, n: u64, r: &str, t: &str, s: &str) -> RulingPreview {
    h.as_(&alice(), 0);
    h.c.preview_ruling(r.into(), t.into(), s.into(), n)
}

fn fallback_reason(m: &Meeting) -> Option<String> {
    let o = m.outcome.as_ref().unwrap();
    assert_eq!(o.kind == OutcomeKind::Fallback, o.reason.is_some());
    o.reason.clone()
}

// ------------------------------------------------------------ guard, ladder

#[test]
fn meeting_guard_enforces_the_interval() {
    let mut h = H::new();
    h.as_(&cranker(), OUTLAYER_DEPOSIT);
    expect_panic(|| { let _ = h.c.convene(); }, "next meeting opens");
    h.advance(INTERVAL_S * SEC_NS - 1);
    h.as_(&cranker(), OUTLAYER_DEPOSIT);
    expect_panic(|| { let _ = h.c.convene(); }, "next meeting opens");
    h.advance(1);
    h.as_(&cranker(), OUTLAYER_DEPOSIT);
    let _ = h.c.convene();
    assert_eq!(h.c.meeting_count, 1);
    h.as_(&cranker(), OUTLAYER_DEPOSIT);
    expect_panic(|| { let _ = h.c.convene(); }, "next meeting opens");
    h.advance(INTERVAL_S * SEC_NS);
    h.as_(&cranker(), OUTLAYER_DEPOSIT);
    let _ = h.c.convene();
    assert_eq!(h.c.meeting_count, 2);
    assert_eq!(h.c.next_meeting_at, h.now + INTERVAL_S * SEC_NS);
}

#[test]
fn asleep_brain_runs_the_fallback_and_refunds() {
    let mut h = H::with_levers(Some(Levers {
        tax_bps: 300,
        endowment_share: 70,
        locker_share: 10,
    }));
    h.buy(&alice(), near(5));
    h.report(near(1) - 1);
    let out = h.convene();
    let PromiseOrValue::Value(Some(m)) = out else {
        panic!("asleep meetings resolve at once")
    };
    assert_eq!(m.model, None);
    assert_eq!(m.status, MeetingStatus::Held);
    assert_eq!(fallback_reason(&m).as_deref(), Some("asleep"));
    assert_eq!(h.c.levers.tax_bps, 290);
    assert_eq!((h.c.levers.endowment_share, h.c.levers.locker_share), (70, 10));
    assert!(transfers().contains(&("crank.near".to_string(), OUTLAYER_DEPOSIT)));
    assert!(calls().iter().all(|c| c.method != "request_execution"));
}

#[test]
fn iq_ladder_picks_the_model_from_the_reported_endowment() {
    let mut h = H::new();
    let cases = [
        (0, None),
        (near(1) - 1, None),
        (near(1), Some(GLM)),
        (near(50) - 1, Some(GLM)),
        (near(50), Some(DEEPSEEK)),
        (near(500) - 1, Some(DEEPSEEK)),
        (near(500), Some(KIMI)),
        (near(1_000_000), Some(KIMI)),
    ];
    for (amount, model) in cases {
        h.report(amount);
        assert_eq!(h.c.get_status().model.as_deref(), model, "{amount}");
    }
    assert_eq!(event("endowment_reported").unwrap()["model"], KIMI);
}

#[test]
fn only_the_brain_reports_its_endowment() {
    let mut h = H::new();
    h.as_(&alice(), 0);
    expect_panic(|| { h.c.report_endowment(U128(near(100))); }, "only the brain");
    h.report(near(100));
    assert_eq!(h.c.get_funds().endowment_reported.0, near(100));
    let ev = event("endowment_reported").unwrap();
    assert_eq!(ev["staked"], near(100).to_string());
    assert_eq!(ev["model"], DEEPSEEK);
}

// ------------------------------------------------------------ request bytes

#[test]
fn convene_builds_the_exact_request_and_calls_outlayer() {
    let mut h = traded();
    h.now = h.c.next_meeting_at;
    h.as_(&alice(), 0);
    let preview = h.c.get_request_preview();
    let n = h.convene_awake();
    let req = h.c.get_last_request().unwrap();
    assert_eq!(preview.request.as_deref(), Some(req.as_str()));
    assert_eq!(preview.meeting, n);

    // Shape: compact, exactly three top-level keys in order.
    assert!(req.starts_with(&format!(
        r#"{{"model":"{GLM}","messages":[{{"role":"system","content":"You are the Chair of CHAIR"#
    )));
    assert!(req.ends_with(r#""}],"temperature":0}"#));
    let body: Value = sj::from_str(&req).unwrap();
    // Byte-exact: compact JSON, strings escaped the serde_json way.
    let brief_raw = body["messages"][1]["content"].as_str().unwrap();
    let expected = format!(
        r#"{{"model":"{GLM}","messages":[{{"role":"system","content":{}}},{{"role":"user","content":{}}}],"temperature":0}}"#,
        sj::to_string(SYSTEM_PROMPT).unwrap(),
        sj::to_string(brief_raw).unwrap()
    );
    assert_eq!(req, expected);
    assert!(!req.contains('\n') && !brief_raw.contains(": ") && !brief_raw.contains(", "));
    let keys: Vec<&String> = body.as_object().unwrap().keys().collect();
    assert_eq!(keys.len(), 3);
    assert_eq!(body["temperature"], 0);
    assert_eq!(body["messages"][0]["content"], SYSTEM_PROMPT);
    assert_eq!(body["messages"][1]["role"], "user");
    let brief_str = body["messages"][1]["content"].as_str().unwrap();
    // Brief field order is part of the bytes.
    let order = [
        "\"meeting\":",
        "\"supply\":",
        "\"sold\":",
        "\"reserve_near\":",
        "\"price_near\":",
        "\"volume_24h_near\":",
        "\"levers\":",
        "\"funds_near\":",
        "\"endowment_near\":",
        "\"locker_weight\":",
        "\"petitions\":",
    ];
    let pos: Vec<usize> = order.iter().map(|k| brief_str.find(k).unwrap()).collect();
    assert!(pos.windows(2).all(|w| w[0] < w[1]), "{brief_str}");
    let brief: Value = sj::from_str(brief_str).unwrap();
    assert_eq!(brief["meeting"], n);
    assert_eq!(brief["endowment_near"], "10");
    assert_eq!(brief["levers"]["tax_bps"], 200);
    assert_eq!(brief["levers"]["buyback_share"], 20);
    assert_eq!(brief["supply"], crate::util::decimal(h.c.supply, 18));
    assert_eq!(brief["reserve_near"], crate::util::decimal(h.c.reserve, 24));
    assert_eq!(
        brief["funds_near"]["buyback"],
        crate::util::decimal(h.c.buyback_fund, 24)
    );
    assert!(brief["volume_24h_near"]["buy"].as_str().unwrap().starts_with("39."));

    // Stored hash is sha256 of exactly these bytes.
    let m = h.meeting(n);
    assert_eq!(m.request_sha256.as_deref(), Some(hexs(&sha256(req.as_bytes())).as_str()));
    assert_eq!(m.model.as_deref(), Some(GLM));
    assert_eq!(m.status, MeetingStatus::Requested);
    assert_eq!(h.c.open_meeting, Some(n));

    // OutLayer call: Project source pinned to the version, Json, input = request.
    let cs = calls();
    let ol = cs.iter().find(|c| c.method == "request_execution").unwrap();
    assert_eq!(ol.receiver, "outlayer.near");
    assert_eq!(ol.deposit, OUTLAYER_DEPOSIT);
    let args: Value = sj::from_slice(&ol.args).unwrap();
    assert_eq!(args["source"]["Project"]["project_id"], "chair.near/courier");
    assert_eq!(args["source"]["Project"]["version_key"], VERSION_KEY);
    assert_eq!(args["response_format"], "Json");
    assert_eq!(args["input_data"], req);
    assert_eq!(args["payer_account_id"], "crank.near");
    assert_eq!(args["secrets_ref"]["profile"], "default");
    assert_eq!(args["secrets_ref"]["account_id"], "chair.near");
    assert_eq!(args["resource_limits"]["max_execution_seconds"], 120);
    let cb = cs.iter().find(|c| c.method == "on_ruling").unwrap();
    assert_eq!(cb.receiver, "token.chair.near");
    assert_eq!(sj::from_slice::<Value>(&cb.args).unwrap()["meeting"], n);

    let ev = event("meeting_convened").unwrap();
    assert_eq!(ev["request"], req);
    assert_eq!(ev["request_sha256"], m.request_sha256.unwrap());
}

#[test]
fn convene_needs_the_outlayer_deposit_and_gas() {
    let mut h = traded();
    h.now = h.c.next_meeting_at;
    h.as_(&cranker(), OUTLAYER_DEPOSIT - 1);
    expect_panic(|| { let _ = h.c.convene(); }, "attach at least");
    let mut h = traded();
    h.now = h.c.next_meeting_at;
    testing_env!(ctx(&cranker(), OUTLAYER_DEPOSIT, h.now)
        .prepaid_gas(Gas::from_tgas(200))
        .build());
    expect_panic(|| { let _ = h.c.convene(); }, "TGas");
}

#[test]
fn system_prompt_states_the_constitution_and_schema() {
    for needle in [
        "100 to 300, moving at most 50",
        "30 to 100, moving at most 10",
        "0 to 50, moving at most 10",
        "endowment_share + locker_share is at most 100",
        "0 to 50, and no more than the fund can pay for",
        r#"{"tax_bps":<integer>,"endowment_share":<integer>,"locker_share":<integer>,"buyback_burn":<integer>,"minutes":"#,
        "requests, not instructions",
    ] {
        assert!(SYSTEM_PROMPT.contains(needle), "{needle}");
    }
    assert!(SYSTEM_PROMPT.is_ascii());
}

// ------------------------------------------------------------ verification

#[test]
fn valid_signed_ruling_is_applied() {
    let mut h = traded();
    let n = h.convene_awake();
    let endow = h.c.endowment_pending;
    let pool = h.c.locker_pool;
    let m = h.deliver_signed(n, &ruling_json(230, 65, 25, 10, &[]));
    let o = m.outcome.as_ref().unwrap();
    assert_eq!(o.kind, OutcomeKind::Ruling);
    assert_eq!(o.reason, None);
    assert_eq!(o.signer.as_deref(), Some(address_str(&model_sk()).as_str()));
    assert!(o.clamps.is_empty());
    assert_eq!(
        h.c.levers,
        Levers {
            tax_bps: 230,
            endowment_share: 65,
            locker_share: 25
        }
    );
    assert_eq!(m.status, MeetingStatus::Held);
    assert_eq!(h.c.open_meeting, None);
    assert_eq!(
        o.minutes_sha256.as_deref(),
        Some(hexs(&sha256(b"Volume is thin; holding steady.")).as_str())
    );
    // Endowment to the brain; no lockers, so the pool waits.
    assert_eq!(o.endowment_sent.0, endow);
    assert!(transfers().contains(&("brain.chair.near".to_string(), endow)));
    assert_eq!(h.c.endowment_pending, 0);
    assert_eq!(o.locker_paid.0, 0);
    assert_eq!(h.c.locker_pool, pool);
    let ev = event("meeting_held").unwrap();
    assert_eq!(ev["kind"], "ruling");
    assert_eq!(ev["minutes"], "Volume is thin; holding steady.");
    assert_eq!(ev["levers"]["tax_bps"], 230);
    assert_eq!(h.c.stats.rulings, 1);
}

#[test]
fn buyback_burns_without_moving_s_down() {
    let mut h = traded();
    let n = h.convene_awake();
    let (supply, sold, fund) = (h.c.supply, h.c.sold, h.c.buyback_fund);
    let floor0 = h.c.get_curve().floor_price.0;
    let m = h.deliver_signed(n, &ruling_json(200, 60, 20, 5, &[]));
    let o = m.outcome.unwrap();
    let burned = o.buyback_tokens.0;
    assert_eq!(burned, crate::curve::bps_floor(supply, 5));
    assert_eq!(o.buyback_bps, 5);
    assert_eq!(h.c.supply, supply, "bought and burned in one step");
    assert_eq!(h.c.sold, sold + burned, "s keeps the burned tokens");
    assert_eq!(h.c.burned, burned);
    assert_eq!(h.c.buyback_fund, fund - o.buyback_near.0);
    let c = h.c.curve();
    assert_eq!(h.c.reserve, c.reserve_for(h.c.sold).unwrap());
    assert!(h.c.reserve > c.reserve_for(h.c.supply).unwrap(), "over-collateralised");
    assert!(h.c.get_curve().floor_price.0 > floor0, "the floor rises");
    assert_eq!(h.c.get_curve().locked_reserve.0, c.reserve_for(burned).unwrap());
}

#[test]
fn buyback_limited_by_the_fund_is_recorded() {
    // Buyback share 5%: the fund holds far less than 0.5% of supply costs.
    let mut h = H::with_levers(Some(Levers {
        tax_bps: 200,
        endowment_share: 70,
        locker_share: 25,
    }));
    h.buy(&alice(), near(20));
    h.buy(&bob(), near(20));
    let n = h.convene_awake();
    let fund = h.c.buyback_fund;
    let full = h.c.curve().buy_cost(h.c.sold, crate::curve::bps_floor(h.c.supply, 50)).unwrap();
    assert!(full > fund);
    let m = h.deliver_signed(n, &ruling_json(200, 70, 25, 999, &[]));
    let o = m.outcome.unwrap();
    assert!(o.buyback_near.0 <= fund);
    assert!(o.buyback_near.0 + 100 >= fund, "spends (nearly) all the fund");
    assert!(o.buyback_tokens.0 > 0);
    let k = o.clamps.iter().find(|c| c.lever == "buyback_burn").unwrap();
    assert_eq!(k.asked, 999);
    assert_eq!(k.rule, "bounds+fund");
    assert!(k.applied < 50);
    assert_eq!(k.applied, o.buyback_bps as i64);
}

#[test]
fn jailbroken_ruling_is_clamped_and_recorded() {
    let mut h = traded();
    let n = h.convene_awake();
    let m = h.deliver_signed(n, &ruling_json(10_000, 0, 100, 10_000, &[]));
    let o = m.outcome.unwrap();
    assert_eq!(o.kind, OutcomeKind::Ruling);
    assert_eq!(
        o.levers,
        Levers {
            tax_bps: 250,
            endowment_share: 50,
            locker_share: 30
        }
    );
    let rules: Vec<(String, i64, i64)> = o
        .clamps
        .iter()
        .map(|c| (c.lever.clone(), c.asked, c.applied))
        .collect();
    assert!(rules.contains(&("tax_bps".into(), 10_000, 250)));
    assert!(rules.contains(&("endowment_share".into(), 0, 50)));
    assert!(rules.contains(&("locker_share".into(), 100, 30)));
    assert!(o.clamps.iter().any(|c| c.lever == "buyback_burn"));
    assert_eq!(o.asked.unwrap().tax_bps, 10_000);
    assert!(h.c.levers.within_constitution());
    let ev = event("meeting_held").unwrap();
    assert_eq!(ev["clamps"].as_array().unwrap().len(), o.clamps.len());
}

#[test]
fn forged_signature_runs_the_fallback() {
    let mut h = traded();
    let n = h.convene_awake();
    let (r, t, s) = h.signed(n, &ruling_json(300, 100, 0, 50, &[]), &model_sk());
    // Flip one byte of r: recovers to some other address (or nothing).
    let mut forged = s.clone();
    let flip = if &forged[10..11] == "0" { "1" } else { "0" };
    forged.replace_range(10..11, flip);
    let m = h.deliver(n, PromiseResult::Successful(courier(&r, &t, &forged))).unwrap();
    assert_eq!(fallback_reason(&m).as_deref(), Some("bad_signature"));
    assert_eq!(h.c.levers.tax_bps, 200, "fallback at 200 holds");
    assert_eq!(h.c.stats.fallbacks, 1);
}

#[test]
fn signer_not_on_the_allowlist_is_rejected() {
    let mut h = traded();
    let n = h.convene_awake();
    let (r, t, s) = h.signed(n, &ruling_json(250, 60, 20, 0, &[]), &other_sk());
    let m = h.deliver(n, PromiseResult::Successful(courier(&r, &t, &s))).unwrap();
    assert_eq!(fallback_reason(&m).as_deref(), Some("bad_signature"));
}

#[test]
fn wrong_request_hash_is_bad_hash() {
    let mut h = traded();
    let n = h.convene_awake();
    let resp = chat_response(GLM, &ruling_json(250, 60, 20, 0, &[]));
    let other_request = hexs(&sha256(b"some other request"));
    let text = format!("{GLM}:{other_request}:{}", hexs(&sha256(resp.as_bytes())));
    let sig = eth_sign(&model_sk(), &text); // genuinely signed, wrong request
    let m = h.deliver(n, PromiseResult::Successful(courier(&resp, &text, &sig))).unwrap();
    assert_eq!(fallback_reason(&m).as_deref(), Some("bad_hash"));
}

#[test]
fn wrong_model_in_signature_text_is_bad_hash() {
    let mut h = traded();
    let n = h.convene_awake();
    let resp = chat_response(KIMI, &ruling_json(250, 60, 20, 0, &[]));
    let text = format!(
        "{KIMI}:{}:{}",
        h.meeting(n).request_sha256.unwrap(),
        hexs(&sha256(resp.as_bytes()))
    );
    let sig = eth_sign(&model_sk(), &text);
    let m = h.deliver(n, PromiseResult::Successful(courier(&resp, &text, &sig))).unwrap();
    assert_eq!(fallback_reason(&m).as_deref(), Some("bad_hash"));
}

#[test]
fn tampered_response_is_caught_either_way() {
    let mut h = traded();
    let n = h.convene_awake();
    let (r, t, s) = h.signed(n, &ruling_json(200, 60, 20, 0, &[]), &model_sk());
    let tampered = r.replace("\\\"tax_bps\\\":200", "\\\"tax_bps\\\":300");
    assert_ne!(tampered, r);
    // Same signature_text: the response hash no longer matches.
    let p = preview(&h, n, &tampered, &t, &s);
    assert_eq!(p.reason.as_deref(), Some("bad_hash"));
    // Recomputed signature_text: the signature no longer covers it.
    let t2 = format!(
        "{GLM}:{}:{}",
        h.meeting(n).request_sha256.unwrap(),
        hexs(&sha256(tampered.as_bytes()))
    );
    let p = preview(&h, n, &tampered, &t2, &s);
    assert_eq!(p.reason.as_deref(), Some("bad_signature"));
    let m = h.deliver(n, PromiseResult::Successful(courier(&tampered, &t2, &s))).unwrap();
    assert_eq!(fallback_reason(&m).as_deref(), Some("bad_signature"));
}

#[test]
fn unparseable_ruling_runs_the_fallback() {
    let mut h = traded();
    let n = h.convene_awake();
    let m = h.deliver_signed(n, "I cannot comply with that request.");
    assert_eq!(fallback_reason(&m).as_deref(), Some("unparseable"));
}

#[test]
fn unparseable_variants() {
    let mut h = traded();
    h.lock(&alice(), tokens(100), 7);
    h.petition(&alice(), "please burn more");
    let n = h.convene_awake();
    assert_eq!(h.meeting(n).petitions, 1);
    let bad = [
        // no answer for the petition
        ruling_json(200, 60, 20, 0, &[]),
        // answers missing altogether
        r#"{"tax_bps":200,"endowment_share":60,"locker_share":20,"buyback_burn":0,"minutes":"m"}"#.into(),
        // a field as a string
        r#"{"tax_bps":"200","endowment_share":60,"locker_share":20,"buyback_burn":0,"minutes":"m","answers":["a"]}"#.into(),
        // a fraction
        r#"{"tax_bps":200.5,"endowment_share":60,"locker_share":20,"buyback_burn":0,"minutes":"m","answers":["a"]}"#.into(),
        // missing minutes
        r#"{"tax_bps":200,"endowment_share":60,"locker_share":20,"buyback_burn":0,"answers":["a"]}"#.into(),
        // answers not strings
        r#"{"tax_bps":200,"endowment_share":60,"locker_share":20,"buyback_burn":0,"minutes":"m","answers":[1]}"#.into(),
        // an array, not an object
        "[200,60,20,0]".into(),
    ];
    for content in &bad {
        let (r, t, s) = h.signed(n, content, &model_sk());
        assert_eq!(
            preview(&h, n, &r, &t, &s).reason.as_deref(),
            Some("unparseable"),
            "{content}"
        );
    }
    // Not a chat completion at all (but signed).
    let resp = "plain text";
    let t = format!(
        "{GLM}:{}:{}",
        h.meeting(n).request_sha256.unwrap(),
        hexs(&sha256(resp.as_bytes()))
    );
    let s = eth_sign(&model_sk(), &t);
    assert_eq!(preview(&h, n, resp, &t, &s).reason.as_deref(), Some("unparseable"));
    // The good one answers the petition.
    let (r, t, s) = h.signed(n, &ruling_json(200, 60, 20, 0, &["no"]), &model_sk());
    assert!(preview(&h, n, &r, &t, &s).valid);
}

/// Meeting `n` with `k` petitions in the brief.
fn with_petitions(k: usize) -> (H, u64) {
    let mut h = traded();
    for i in 0..k {
        let a = acc(&format!("pet{i}.near"));
        h.buy(&a, near(1));
        h.lock(&a, tokens(10 + i as u128), 7);
        h.petition(&a, &format!("petition {i}"));
    }
    let n = h.convene_awake();
    assert_eq!(h.meeting(n).petitions as usize, k);
    (h, n)
}

#[test]
fn answers_match_the_number_of_petitions() {
    for k in 0..=3usize {
        let (h, n) = with_petitions(k);
        let exact: Vec<String> = (0..k).map(|i| format!("reply {i}")).collect();
        let exact: Vec<&str> = exact.iter().map(String::as_str).collect();
        let (r, t, s) = h.signed(n, &ruling_json(210, 60, 20, 0, &exact), &model_sk());
        let p = preview(&h, n, &r, &t, &s);
        assert!(p.valid, "{k} petitions, {k} answers");
        assert_eq!(p.answers.len(), k);
        if k > 0 {
            // One answer short is unparseable.
            let (r, t, s) = h.signed(n, &ruling_json(210, 60, 20, 0, &exact[..k - 1]), &model_sk());
            assert_eq!(preview(&h, n, &r, &t, &s).reason.as_deref(), Some("unparseable"), "{k}");
        }
    }
}

#[test]
fn extra_answers_are_truncated() {
    for k in 0..=3usize {
        let (h, n) = with_petitions(k);
        // Always three (or more) answers, as a model might pad them; extras
        // need not even be strings.
        let content = json!({
            "tax_bps": 210, "endowment_share": 60, "locker_share": 20, "buyback_burn": 0,
            "minutes": "m", "answers": ["a", "b", "c", 4, null]
        })
        .to_string();
        let (r, t, s) = h.signed(n, &content, &model_sk());
        let p = preview(&h, n, &r, &t, &s);
        assert!(p.valid, "{k} petitions");
        let want: Vec<String> = ["a", "b", "c"][..k].iter().map(|x| x.to_string()).collect();
        assert_eq!(p.answers, want);
    }
}

#[test]
fn no_petitions_tolerates_missing_answers() {
    let (mut h, n) = with_petitions(0);
    let m = h.deliver_signed(
        n,
        r#"{"tax_bps":210,"endowment_share":60,"locker_share":20,"buyback_burn":0,"minutes":"quiet day"}"#,
    );
    assert_eq!(m.outcome.unwrap().kind, OutcomeKind::Ruling);
    assert_eq!(event("meeting_held").unwrap()["answers"], json!([]));
}

#[test]
fn ruling_inside_prose_or_code_fences_parses() {
    let mut h = traded();
    let n = h.convene_awake();
    let content = format!(
        "Here is my ruling:\n```json\n{}\n```",
        ruling_json(210, 60, 20, 0, &[])
    );
    let m = h.deliver_signed(n, &content);
    assert_eq!(m.outcome.unwrap().kind, OutcomeKind::Ruling);
    assert_eq!(h.c.levers.tax_bps, 210);
}

#[test]
fn huge_integers_are_clamped_not_rejected() {
    let mut h = traded();
    let n = h.convene_awake();
    let content = r#"{"tax_bps":99999999999999999999,"endowment_share":-5,"locker_share":0,"buyback_burn":0,"minutes":"m","answers":[]}"#;
    let m = h.deliver_signed(n, content);
    let o = m.outcome.unwrap();
    assert_eq!(o.kind, OutcomeKind::Ruling);
    assert_eq!(o.levers.tax_bps, 250);
    assert_eq!(o.asked.unwrap().tax_bps, i64::MAX);
}

#[test]
fn missing_or_null_results_are_unsigned() {
    let results: Vec<(PromiseResult, bool)> = vec![
        (PromiseResult::Successful(b"null".to_vec()), false),
        (PromiseResult::Failed, true),
        (PromiseResult::Successful(b"garbage".to_vec()), false),
        (PromiseResult::Successful(br#"{"error":"upstream 503"}"#.to_vec()), false),
        (PromiseResult::Successful(courier("{}", "", "")), false),
        (PromiseResult::Successful(courier("{}", "x", "")), false),
    ];
    for (res, refund) in results {
        let mut h = traded();
        let n = h.convene_awake();
        let m = h.deliver(n, res).unwrap();
        assert_eq!(fallback_reason(&m).as_deref(), Some("unsigned"));
        assert_eq!(h.c.levers.tax_bps, 200);
        // A failed request_execution returned its deposit: it goes back to the convener.
        assert_eq!(
            transfers().contains(&("crank.near".to_string(), OUTLAYER_DEPOSIT)),
            refund
        );
    }
}

#[test]
fn malformed_signatures_are_bad_signature() {
    let mut h = traded();
    let n = h.convene_awake();
    let (r, t, s) = h.signed(n, &ruling_json(200, 60, 20, 0, &[]), &model_sk());
    for bad in [
        "0x1234".to_string(),
        "zz".repeat(65),
        format!("{}1d", &s[..s.len() - 2]), // v = 29
        s[2..].to_string() + "00",          // 66 bytes
    ] {
        assert_eq!(preview(&h, n, &r, &t, &bad).reason.as_deref(), Some("bad_signature"), "{bad}");
    }
    // Without the 0x prefix, and with v as 0/1, the same signature is fine.
    assert!(preview(&h, n, &r, &t, &s[2..]).valid);
    let v = u8::from_str_radix(&s[s.len() - 2..], 16).unwrap() - 27;
    let s01 = format!("{}{:02x}", &s[..s.len() - 2], v);
    assert!(preview(&h, n, &r, &t, &s01).valid);
}

// ------------------------------------------------------------ first valid result only

#[test]
fn only_the_first_result_per_meeting_counts() {
    let mut h = traded();
    let n = h.convene_awake();
    h.deliver_signed(n, &ruling_json(250, 70, 20, 0, &[]));
    let after = h.c.levers;
    let fund = h.c.buyback_fund;
    // A second genuinely signed ruling for the same meeting (a re-roll).
    let (r, t, s) = h.signed(n, &ruling_json(150, 50, 10, 50, &[]), &model_sk());
    let m = h.deliver(n, PromiseResult::Successful(courier(&r, &t, &s))).unwrap();
    assert_eq!(h.c.levers, after);
    assert_eq!(h.c.buyback_fund, fund);
    assert_eq!(m.outcome.unwrap().levers, after);
    assert_eq!(event("ruling_ignored").unwrap()["meeting"], n);
    assert_eq!(h.c.stats.rulings, 1);
}

#[test]
fn a_failed_first_result_also_decides_the_meeting() {
    let mut h = H::with_levers(Some(Levers {
        tax_bps: 260,
        endowment_share: 60,
        locker_share: 20,
    }));
    h.buy(&alice(), near(5));
    let n = h.convene_awake();
    h.deliver(n, PromiseResult::Successful(b"null".to_vec()));
    assert_eq!(h.c.levers.tax_bps, 250);
    h.deliver_signed(n, &ruling_json(300, 60, 20, 0, &[]));
    assert_eq!(h.c.levers.tax_bps, 250, "late valid ruling ignored");
    assert!(event("ruling_ignored").is_some());
}

#[test]
fn an_unanswered_meeting_lapses_and_its_late_result_is_ignored() {
    let mut h = traded();
    let n1 = h.convene_awake();
    let late = h.signed(n1, &ruling_json(250, 60, 20, 0, &[]), &model_sk());
    let n2 = h.convene_awake();
    assert_eq!(n2, n1 + 1);
    assert_eq!(h.meeting(n1).status, MeetingStatus::Lapsed);
    assert_eq!(h.c.open_meeting, Some(n2));
    assert_eq!(h.c.stats.lapsed, 1);
    h.deliver(n1, PromiseResult::Successful(courier(&late.0, &late.1, &late.2)));
    assert_eq!(h.c.levers.tax_bps, 200);
    assert_eq!(h.meeting(n1).status, MeetingStatus::Lapsed);
    assert_eq!(h.c.open_meeting, Some(n2), "meeting 2 still waits for its own result");
    h.deliver_signed(n2, &ruling_json(240, 60, 20, 0, &[]));
    assert_eq!(h.c.levers.tax_bps, 240);
}

// ------------------------------------------------------------ preview

#[test]
fn preview_matches_what_on_ruling_executes() {
    let mut h = traded();
    let n = h.convene_awake();
    let (r, t, s) = h.signed(n, &ruling_json(5_000, 95, 45, 30, &[]), &model_sk());
    let p = preview(&h, n, &r, &t, &s);
    assert!(p.valid);
    assert_eq!(p.reason, None);
    assert_eq!(p.expected_signature_text.as_deref(), Some(t.as_str()));
    assert_eq!(p.signer.as_deref(), Some(address_str(&model_sk()).as_str()));
    let m = h.deliver(n, PromiseResult::Successful(courier(&r, &t, &s))).unwrap();
    let o = m.outcome.unwrap();
    assert_eq!(
        Levers {
            tax_bps: p.levers.tax_bps,
            endowment_share: p.levers.endowment_share,
            locker_share: p.levers.locker_share
        },
        o.levers
    );
    assert_eq!(p.clamps, o.clamps);
    assert_eq!((p.buyback_bps, p.buyback_tokens, p.buyback_near), (o.buyback_bps, o.buyback_tokens, o.buyback_near));
    assert_eq!(p.minutes_sha256, o.minutes_sha256);
    // The view still answers for a held meeting, relative to its own levers_before.
    let again = preview(&h, n, &r, &t, &s);
    assert_eq!(again.levers_before.tax_bps, 200);
}

#[test]
fn preview_reports_each_failure_reason() {
    let mut h = traded();
    let n = h.convene_awake();
    let (r, t, s) = h.signed(n, &ruling_json(250, 60, 20, 0, &[]), &model_sk());
    assert!(preview(&h, n, &r, &t, &s).valid);
    let p = preview(&h, n, &r, &t.replace(GLM, KIMI), &s);
    assert_eq!(p.reason.as_deref(), Some("bad_hash"));
    assert_eq!(p.levers.tax_bps, 200, "fallback shown");
    let (_, _, s_other) = h.signed(n, &ruling_json(250, 60, 20, 0, &[]), &other_sk());
    assert_eq!(preview(&h, n, &r, &t, &s_other).reason.as_deref(), Some("bad_signature"));
    let (r2, t2, s2) = h.signed(n, "no", &model_sk());
    assert_eq!(preview(&h, n, &r2, &t2, &s2).reason.as_deref(), Some("unparseable"));
    assert_eq!(preview(&h, n, &r, &t, "").reason.as_deref(), Some("unsigned"));
    assert_eq!(preview(&h, n, &r, "", &s).reason.as_deref(), Some("unsigned"));
    // An asleep meeting has no request to check against.
    h.deliver_signed(n, &ruling_json(200, 60, 20, 0, &[]));
    h.report(0);
    let _ = h.convene();
    assert_eq!(preview(&h, n + 1, &r, &t, &s).reason.as_deref(), Some("asleep"));
    h.as_(&alice(), 0);
    expect_panic(|| { h.c.preview_ruling(r.clone(), t.clone(), s.clone(), 99); }, "unknown meeting");
}

#[test]
fn preview_changes_no_state() {
    let mut h = traded();
    let n = h.convene_awake();
    let (r, t, s) = h.signed(n, &ruling_json(300, 100, 0, 50, &[]), &model_sk());
    let (levers, fund, sold) = (h.c.levers, h.c.buyback_fund, h.c.sold);
    let p = preview(&h, n, &r, &t, &s);
    assert!(p.buyback_tokens.0 > 0);
    assert_eq!((h.c.levers, h.c.buyback_fund, h.c.sold), (levers, fund, sold));
    assert_eq!(h.c.open_meeting, Some(n));
}

// ------------------------------------------------------------ minutes, events

#[test]
fn minutes_are_hashed_whole_and_clipped_in_the_event() {
    let mut h = traded();
    let n = h.convene_awake();
    let minutes = format!("{}\u{1}{}", "a".repeat(1_000), "b\n".repeat(1_000));
    let content = json!({
        "tax_bps": 200, "endowment_share": 60, "locker_share": 20, "buyback_burn": 0,
        "minutes": minutes, "answers": []
    })
    .to_string();
    let m = h.deliver_signed(n, &content);
    let o = m.outcome.unwrap();
    assert_eq!(o.minutes_sha256.unwrap(), hexs(&sha256(minutes.as_bytes())));
    let ev = event("meeting_held").unwrap();
    let shown = ev["minutes"].as_str().unwrap();
    assert!(shown.len() <= MINUTES_EVENT_BYTES);
    assert!(!shown.chars().any(char::is_control));
    assert_eq!(ev["minutes_clipped"], true);
}

#[test]
fn worst_case_logs_stay_under_the_receipt_limit() {
    let mut h = traded();
    let quote = "\"".repeat(280);
    for (i, who) in ["q1.near", "q2.near", "q3.near"].iter().enumerate() {
        let a = acc(who);
        h.buy(&a, near(1));
        h.lock(&a, tokens(10 + i as u128), 30);
        h.petition(&a, &quote);
    }
    let n = h.convene_awake();
    let total: usize = get_logs().iter().map(String::len).sum();
    assert!(total < 16_384, "convene logs {total} bytes");
    let answers = ["\"".repeat(400), "\\".repeat(400), "x".repeat(400)];
    let content = json!({
        "tax_bps": 200, "endowment_share": 60, "locker_share": 20, "buyback_burn": 0,
        "minutes": "\"".repeat(3_000), "answers": answers
    })
    .to_string();
    h.deliver_signed(n, &content);
    let total: usize = get_logs().iter().map(String::len).sum();
    assert!(total < 16_384, "on_ruling logs {total} bytes");
}

// ------------------------------------------------------------ endowment

#[test]
fn failed_endowment_transfer_is_recredited() {
    let mut h = traded();
    let n = h.convene_awake();
    let pending = h.c.endowment_pending;
    h.deliver_signed(n, &ruling_json(200, 60, 20, 0, &[]));
    assert_eq!(h.c.endowment_sent, pending);
    let cb = calls().into_iter().find(|c| c.method == "on_endowment_sent").unwrap();
    assert_eq!(cb.receiver, "token.chair.near");
    testing_env!(
        ctx(&token(), 0, h.now).build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Failed]
    );
    assert!(!h.c.on_endowment_sent(U128(pending)));
    assert_eq!(h.c.endowment_pending, pending);
    assert_eq!(h.c.endowment_sent, 0);
}

// ------------------------------------------------------------ signer timelock

#[test]
fn signers_change_only_after_48h() {
    let mut h = traded();
    let models = vec![address_str(&other_sk())];
    let gateways = vec![address_str(&model_sk())];
    h.as_(&alice(), 0);
    expect_panic(|| { h.c.propose_signers(models.clone(), gateways.clone()); }, "only the owner");
    h.as_(&owner(), 0);
    let eta = h.c.propose_signers(models.clone(), gateways.clone());
    assert_eq!(eta.0, h.now + 48 * HOUR_NS);
    let ev = event("signers_proposed").unwrap();
    assert_eq!(ev["model_signers"][0], models[0]);
    assert_eq!(ev["gateway_signers"][0], gateways[0]);
    assert_eq!(ev["current_gateway_signers"][0], address_str(&gateway_sk()));
    let v = h.c.get_signers();
    assert_eq!(v.pending_model_signers.as_ref(), Some(&models));
    assert_eq!(v.pending_eta, Some(eta));
    h.as_(&alice(), 0);
    expect_panic(|| { h.c.apply_signers(); }, "timelock");
    // Meanwhile the old keys still rule.
    let n = h.convene_awake();
    let (r, t, s) = h.signed(n, &ruling_json(250, 60, 20, 0, &[]), &other_sk());
    assert_eq!(preview(&h, n, &r, &t, &s).reason.as_deref(), Some("bad_signature"));
    let (rg, tg, sg) = h.signed_gateway(n, &ruling_json(250, 60, 20, 0, &[]), &gateway_sk());
    assert!(preview(&h, n, &rg, &tg, &sg).valid);
    h.now = T0 + 48 * HOUR_NS;
    h.as_(&alice(), 0); // anyone may apply once it is due
    let applied = h.c.apply_signers();
    assert_eq!(applied.model_signers, models);
    assert_eq!(applied.gateway_signers, gateways);
    assert_eq!(applied.pending_eta, None);
    assert!(event("signers_applied").is_some());
    assert!(preview(&h, n, &r, &t, &s).valid);
    assert_eq!(preview(&h, n, &rg, &tg, &sg).reason.as_deref(), Some("bad_signature"));
    h.as_(&alice(), 0);
    expect_panic(|| { h.c.apply_signers(); }, "no pending");
}

#[test]
fn a_new_proposal_restarts_the_clock() {
    let mut h = H::new();
    h.as_(&owner(), 0);
    h.c.propose_signers(vec![address_str(&other_sk())], vec![]);
    h.advance(47 * HOUR_NS);
    h.as_(&owner(), 0);
    h.c.propose_signers(vec![], vec![]);
    h.advance(2 * HOUR_NS);
    h.as_(&owner(), 0);
    expect_panic(|| { h.c.apply_signers(); }, "timelock");
    assert_eq!(h.c.get_signers().model_signers, vec![address_str(&model_sk())]);
    assert_eq!(h.c.get_signers().gateway_signers, vec![address_str(&gateway_sk())]);
}

// ------------------------------------------------------------ provider TEE vs gateway TEE

#[test]
fn provider_tee_ruling_records_its_kind() {
    let mut h = traded();
    let n = h.convene_awake();
    let m = h.deliver_signed(n, &ruling_json(220, 60, 20, 0, &[]));
    let o = m.outcome.unwrap();
    assert_eq!(o.signed_by.as_deref(), Some("provider_tee"));
    assert_eq!(event("meeting_held").unwrap()["signed_by"], "provider_tee");
}

#[test]
fn gateway_signed_ruling_is_applied() {
    let mut h = traded();
    let n = h.convene_awake();
    let (r, t, s) = h.signed_gateway(n, &ruling_json(240, 70, 10, 0, &[]), &gateway_sk());
    assert_eq!(t.split(':').count(), 2);
    let p = preview(&h, n, &r, &t, &s);
    assert!(p.valid);
    assert_eq!(p.signed_by.as_deref(), Some("gateway"));
    assert_eq!(p.expected_gateway_text.as_deref(), Some(t.as_str()));
    let m = h.deliver(n, PromiseResult::Successful(courier(&r, &t, &s))).unwrap();
    let o = m.outcome.unwrap();
    assert_eq!(o.kind, OutcomeKind::Ruling);
    assert_eq!(o.signed_by.as_deref(), Some("gateway"));
    assert_eq!(o.signer.as_deref(), Some(address_str(&gateway_sk()).as_str()));
    assert_eq!(
        h.c.levers,
        Levers {
            tax_bps: 240,
            endowment_share: 70,
            locker_share: 10
        }
    );
    let ev = event("meeting_held").unwrap();
    assert_eq!(ev["signed_by"], "gateway");
}

#[test]
fn gateway_text_signed_by_a_model_key_is_rejected() {
    let mut h = traded();
    let n = h.convene_awake();
    // A 2-part text needs a gateway signer; a model signer does not count.
    let (r, t, s) = h.signed_gateway(n, &ruling_json(240, 60, 20, 0, &[]), &model_sk());
    assert_eq!(preview(&h, n, &r, &t, &s).reason.as_deref(), Some("bad_signature"));
    let m = h.deliver(n, PromiseResult::Successful(courier(&r, &t, &s))).unwrap();
    assert_eq!(fallback_reason(&m).as_deref(), Some("bad_signature"));
}

#[test]
fn model_text_signed_by_a_gateway_key_is_rejected() {
    let mut h = traded();
    let n = h.convene_awake();
    // A 3-part text needs a model signer; a gateway signer does not count.
    let (r, t, s) = h.signed(n, &ruling_json(240, 60, 20, 0, &[]), &gateway_sk());
    assert_eq!(t.split(':').count(), 3);
    assert_eq!(preview(&h, n, &r, &t, &s).reason.as_deref(), Some("bad_signature"));
    let m = h.deliver(n, PromiseResult::Successful(courier(&r, &t, &s))).unwrap();
    assert_eq!(fallback_reason(&m).as_deref(), Some("bad_signature"));
}

#[test]
fn gateway_text_with_wrong_hashes_is_bad_hash() {
    let mut h = traded();
    let n = h.convene_awake();
    let (r, t, _) = h.signed_gateway(n, &ruling_json(240, 60, 20, 0, &[]), &gateway_sk());
    let req = h.meeting(n).request_sha256.unwrap();
    let resp = hexs(&sha256(r.as_bytes()));
    for bad in [
        format!("{}:{resp}", hexs(&sha256(b"another request"))),
        format!("{req}:{}", hexs(&sha256(b"another response"))),
        format!("{resp}:{req}"),
        format!("{req}:{resp}:"),
        format!(":{req}:{resp}"),
        format!("{req}{resp}"),
        t.to_uppercase(),
    ] {
        let s = eth_sign(&gateway_sk(), &bad); // genuinely signed, wrong text
        assert_eq!(preview(&h, n, &r, &bad, &s).reason.as_deref(), Some("bad_hash"), "{bad}");
    }
    // Same response under a different model prefix is bad_hash too.
    let wrong_model = format!("{KIMI}:{req}:{resp}");
    let s = eth_sign(&model_sk(), &wrong_model);
    assert_eq!(preview(&h, n, &r, &wrong_model, &s).reason.as_deref(), Some("bad_hash"));
}

#[test]
fn a_key_on_both_lists_may_sign_either_form() {
    let mut h = traded();
    h.as_(&owner(), 0);
    let both = vec![address_str(&other_sk())];
    h.c.propose_signers(both.clone(), both.clone());
    h.advance(48 * HOUR_NS);
    h.as_(&alice(), 0);
    h.c.apply_signers();
    let n = h.convene_awake();
    let (r, t, s) = h.signed(n, &ruling_json(240, 60, 20, 0, &[]), &other_sk());
    assert_eq!(preview(&h, n, &r, &t, &s).signed_by.as_deref(), Some("provider_tee"));
    let (r, t, s) = h.signed_gateway(n, &ruling_json(240, 60, 20, 0, &[]), &other_sk());
    assert_eq!(preview(&h, n, &r, &t, &s).signed_by.as_deref(), Some("gateway"));
    let (r, t, s) = h.signed(n, &ruling_json(240, 60, 20, 0, &[]), &model_sk());
    assert_eq!(preview(&h, n, &r, &t, &s).reason.as_deref(), Some("bad_signature"));
}
