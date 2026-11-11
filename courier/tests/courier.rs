//! The courier against a scripted HTTP layer.

use std::collections::VecDeque;

use chair_courier::{deliver, run, sha256_hex, url_encode, Http, Method, Request, Response, Upstream, API_BASE, SIGNATURE_ATTEMPTS};
use serde_json::{json, Value};

const KEY: &str = "sk-test-0123456789abcdef";
const MODEL: &str = "z-ai/glm-5.3-flash";

/// Answers requests from a script and records what was sent.
#[derive(Default)]
struct MockHttp {
    script: VecDeque<Result<Response, String>>,
    sent: Vec<Request>,
    slept: Vec<u64>,
}

impl MockHttp {
    fn answer(mut self, status: u16, body: impl Into<Vec<u8>>) -> Self {
        self.script.push_back(Ok(Response { status, body: body.into() }));
        self
    }
    fn transport_error(mut self, e: &str) -> Self {
        self.script.push_back(Err(e.to_string()));
        self
    }
}

impl Http for MockHttp {
    fn send(&mut self, request: &Request) -> Result<Response, String> {
        self.sent.push(request.clone());
        self.script.pop_front().unwrap_or_else(|| Err("script exhausted".into()))
    }
    fn sleep_ms(&mut self, ms: u64) {
        self.slept.push(ms);
    }
}

/// A compact request like the token builds: whitespace and key order matter.
fn request_bytes() -> Vec<u8> {
    br#"{"model":"z-ai/glm-5.3-flash","temperature":0,"messages":[{"role":"system","content":"You chair the CHAIR central bank."},{"role":"user","content":"{\"meeting\":7}"}]}"#.to_vec()
}

/// The completion body with deliberately odd whitespace: it must come back byte for byte.
fn completion() -> String {
    "{\"id\":\"chatcmpl-abc/123\",\"object\":\"chat.completion\",\"model\":\"z-ai/glm-5.3-flash\",\n  \"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\",\"content\":\"{\\\"tax_bps\\\":180}\"},\"finish_reason\":\"stop\"}]}  ".to_string()
}

fn receipt(text: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "text": text,
        "signature": "0x1b2c",
        "signing_address": "0xAbC0000000000000000000000000000000000001",
        "signing_algo": "ecdsa",
        "signature_kind": "provider_tee"
    }))
    .unwrap()
}

fn good_text() -> String {
    format!("{MODEL}:{}:{}", sha256_hex(&request_bytes()), sha256_hex(completion().as_bytes()))
}

fn header<'a>(r: &'a Request, name: &str) -> Option<&'a str> {
    r.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
}

fn error_code(out: &str) -> String {
    let v: Value = serde_json::from_str(out).unwrap();
    v["error"]["code"].as_str().unwrap().to_string()
}

#[test]
fn posts_the_request_byte_for_byte_and_returns_the_signed_response() {
    let mut http = MockHttp::default().answer(200, completion()).answer(200, receipt(&good_text()));
    let out: Value = serde_json::from_str(&run(&request_bytes(), Some(KEY), &Upstream::Direct, &mut http)).unwrap();

    let post = &http.sent[0];
    assert_eq!(post.method, Method::Post);
    assert_eq!(post.url, "https://cloud-api.near.ai/v1/chat/completions");
    assert_eq!(post.body, request_bytes(), "the request must be forwarded unchanged");
    assert_eq!(header(post, "authorization"), Some(format!("Bearer {KEY}").as_str()));
    assert_eq!(header(post, "content-type"), Some("application/json"));

    let get = &http.sent[1];
    assert_eq!(get.method, Method::Get);
    assert_eq!(
        get.url,
        "https://cloud-api.near.ai/v1/signature/chatcmpl-abc%2F123?model=z-ai%2Fglm-5.3-flash&signing_algo=ecdsa"
    );
    assert_eq!(header(get, "authorization"), Some(format!("Bearer {KEY}").as_str()));
    assert!(get.body.is_empty());

    assert_eq!(out["response_text"], completion(), "the response must come back unchanged");
    assert_eq!(out["signature_text"], good_text());
    assert_eq!(out["signature"], "0x1b2c");
    assert_eq!(out["signing_address"], "0xAbC0000000000000000000000000000000000001");
    assert_eq!(out["signature_kind"], "provider_tee");
    assert_eq!(out["chat_id"], "chatcmpl-abc/123");
    assert_eq!(out["model"], MODEL);
    assert_eq!(out["request_sha256"], sha256_hex(&request_bytes()));
    assert_eq!(out["hashes_match"], true);
    assert_eq!(http.sent.len(), 2);
    assert!(http.slept.is_empty());
}

#[test]
fn the_output_never_contains_the_api_key() {
    let mut http = MockHttp::default().answer(200, completion()).answer(200, receipt(&good_text()));
    let out = run(&request_bytes(), Some(KEY), &Upstream::Direct, &mut http);
    assert!(!out.contains(KEY));
}

#[test]
fn fails_clearly_without_an_api_key_and_sends_nothing() {
    for key in [None, Some(""), Some("   ")] {
        let mut http = MockHttp::default();
        let out = run(&request_bytes(), key, &Upstream::Direct, &mut http);
        assert_eq!(error_code(&out), "missing_api_key");
        let v: Value = serde_json::from_str(&out).unwrap();
        assert!(v["error"]["message"].as_str().unwrap().contains("NEARAI_API_KEY"));
        assert!(v.get("signature").is_none() && v.get("response_text").is_none());
        assert!(http.sent.is_empty());
    }
}

#[test]
fn retries_the_signature_lookup_on_404() {
    let mut http = MockHttp::default()
        .answer(200, completion())
        .answer(404, r#"{"error":{"message":"Signature not found","type":"not_found_error"}}"#)
        .answer(404, "")
        .answer(200, receipt(&good_text()));
    let d = deliver(&request_bytes(), Some(KEY), &Upstream::Direct, &mut http).unwrap();
    assert_eq!(d.signature_text, good_text());
    assert_eq!(http.sent.len(), 4);
    assert_eq!(http.slept, vec![250, 500]);
}

#[test]
fn retries_transient_lookup_failures() {
    let mut http = MockHttp::default()
        .answer(200, completion())
        .answer(503, "busy")
        .transport_error("connection reset")
        .answer(429, "slow down")
        .answer(200, receipt(&good_text()));
    assert!(deliver(&request_bytes(), Some(KEY), &Upstream::Direct, &mut http).is_ok());
    assert_eq!(http.sent.len(), 5);
}

#[test]
fn gives_up_when_the_signature_never_appears() {
    let mut http = MockHttp::default().answer(200, completion());
    for _ in 0..SIGNATURE_ATTEMPTS {
        http = http.answer(404, "not yet");
    }
    let f = deliver(&request_bytes(), Some(KEY), &Upstream::Direct, &mut http).unwrap_err();
    assert_eq!(f.code, "signature_not_found");
    assert_eq!(http.sent.len(), 1 + SIGNATURE_ATTEMPTS as usize);
    let total: u64 = http.slept.iter().sum();
    assert!(total <= 25_000, "lookups must fit OutLayer's ~120 s window, slept {total} ms");
}

#[test]
fn a_rejected_completion_is_reported_without_the_key() {
    let echo = format!(r#"{{"error":{{"message":"Invalid API key Bearer {KEY}","type":"unauthorized"}}}}"#);
    let mut http = MockHttp::default().answer(401, echo);
    let out = run(&request_bytes(), Some(KEY), &Upstream::Direct, &mut http);
    assert_eq!(error_code(&out), "upstream_status");
    assert!(out.contains("401"));
    assert!(!out.contains(KEY), "the key must be redacted: {out}");
    assert_eq!(http.sent.len(), 1, "no signature lookup after a failed completion");
}

#[test]
fn a_transport_failure_is_reported() {
    let mut http = MockHttp::default().transport_error("DNS lookup failed");
    assert_eq!(deliver(&request_bytes(), Some(KEY), &Upstream::Direct, &mut http).unwrap_err().code, "upstream_transport");
}

#[test]
fn a_completion_without_an_id_is_refused() {
    for body in [r#"{"object":"chat.completion"}"#, r#"{"id":42}"#, r#"{"id":""}"#, "not json"] {
        let mut http = MockHttp::default().answer(200, body);
        assert_eq!(deliver(&request_bytes(), Some(KEY), &Upstream::Direct, &mut http).unwrap_err().code, "response_missing_id");
    }
}

#[test]
fn a_non_utf8_completion_is_refused() {
    let mut http = MockHttp::default().answer(200, vec![0xff, 0xfe, b'{']);
    assert_eq!(deliver(&request_bytes(), Some(KEY), &Upstream::Direct, &mut http).unwrap_err().code, "response_not_utf8");
}

#[test]
fn an_unavailable_signature_is_reported() {
    let mut http = MockHttp::default()
        .answer(200, completion())
        .answer(200, r#"{"error_code":"client_disconnected","message":"stream was disconnected"}"#);
    assert_eq!(deliver(&request_bytes(), Some(KEY), &Upstream::Direct, &mut http).unwrap_err().code, "signature_unavailable");
}

#[test]
fn a_malformed_or_wrong_algorithm_receipt_is_refused() {
    for body in [
        r#"{"text":"x"}"#.to_string(),
        "[]".to_string(),
        serde_json::to_string(&json!({"text":"x","signature":"y","signing_algo":"ed25519"})).unwrap(),
    ] {
        let mut http = MockHttp::default().answer(200, completion()).answer(200, body);
        assert_eq!(deliver(&request_bytes(), Some(KEY), &Upstream::Direct, &mut http).unwrap_err().code, "signature_malformed");
    }
}

#[test]
fn other_lookup_errors_stop_at_once() {
    let mut http = MockHttp::default().answer(200, completion()).answer(400, r#"{"error":"bad model"}"#);
    assert_eq!(deliver(&request_bytes(), Some(KEY), &Upstream::Direct, &mut http).unwrap_err().code, "signature_status");
    assert_eq!(http.sent.len(), 2);
}

#[test]
fn hashes_match_flags_a_receipt_over_other_bytes() {
    let other = format!("{MODEL}:{}:{}", sha256_hex(b"something else"), sha256_hex(completion().as_bytes()));
    let mut http = MockHttp::default().answer(200, completion()).answer(200, receipt(&other));
    let d = deliver(&request_bytes(), Some(KEY), &Upstream::Direct, &mut http).unwrap();
    assert!(!d.hashes_match());
    // The courier reports, it does not judge: the token checks the signature.
    assert_eq!(d.signature_text, other);
}

#[test]
fn bad_requests_are_refused_before_any_call() {
    let big = format!(r#"{{"model":"m","pad":"{}"}}"#, "x".repeat(70_000));
    let cases: Vec<(Vec<u8>, &str)> = vec![
        (vec![], "empty_request"),
        (b"hello".to_vec(), "request_not_json"),
        (b"[1,2]".to_vec(), "request_not_json"),
        (br#"{"messages":[]}"#.to_vec(), "request_missing_model"),
        (br#"{"model":"","messages":[]}"#.to_vec(), "request_missing_model"),
        (br#"{"model":"m","stream":true,"messages":[]}"#.to_vec(), "request_streaming"),
        (big.into_bytes(), "request_too_large"),
    ];
    for (input, code) in cases {
        let mut http = MockHttp::default();
        assert_eq!(deliver(&input, Some(KEY), &Upstream::Direct, &mut http).unwrap_err().code, code);
        assert!(http.sent.is_empty());
    }
}

#[test]
fn url_encoding_keeps_only_unreserved_characters() {
    assert_eq!(url_encode("deepseek-ai/DeepSeek-V4.1-Flash-1017"), "deepseek-ai%2FDeepSeek-V4.1-Flash-1017");
    assert_eq!(url_encode("a b&c=d?e#f"), "a%20b%26c%3Dd%3Fe%23f");
    assert_eq!(url_encode("chatcmpl-123_x.y~z"), "chatcmpl-123_x.y~z");
}

// ---------------------------------------------------------------- relay builds

const RELAY: &str = "https://chair-tau-khaki.vercel.app/api/nearai";
const TOKEN: &str = "token5.chair-dev.testnet";

fn relay() -> Upstream {
    Upstream::new(RELAY, TOKEN)
}

#[test]
fn the_base_picks_the_mode() {
    assert_eq!(Upstream::new(API_BASE, TOKEN), Upstream::Direct);
    assert_eq!(Upstream::new("https://cloud-api.near.ai/", TOKEN), Upstream::Direct);
    assert_eq!(
        Upstream::new(&format!("{RELAY}/"), TOKEN),
        Upstream::Relay { base: RELAY.into(), token: TOKEN.into() }
    );
    assert_eq!(relay().base(), RELAY);
}

#[test]
fn through_the_relay_it_sends_no_key_and_names_the_token() {
    for key in [None, Some(KEY)] {
        let mut http = MockHttp::default().answer(200, completion()).answer(200, receipt(&good_text()));
        let out: Value = serde_json::from_str(&run(&request_bytes(), key, &relay(), &mut http)).unwrap();

        let post = &http.sent[0];
        assert_eq!(post.method, Method::Post);
        assert_eq!(post.url, format!("{RELAY}/v1/chat/completions?token=token5.chair-dev.testnet"));
        assert_eq!(post.body, request_bytes(), "the request must be forwarded unchanged");
        assert_eq!(header(post, "authorization"), None);
        assert_eq!(header(post, "content-type"), Some("application/json"));

        let get = &http.sent[1];
        assert_eq!(get.method, Method::Get);
        assert_eq!(
            get.url,
            format!("{RELAY}/v1/signature/chatcmpl-abc%2F123?model=z-ai%2Fglm-5.3-flash&signing_algo=ecdsa&token=token5.chair-dev.testnet")
        );
        assert_eq!(header(get, "authorization"), None);

        for r in &http.sent {
            assert!(!r.url.contains(KEY) && r.headers.iter().all(|(_, v)| !v.contains(KEY)), "the key must never be sent");
        }
        // The same output as a direct build.
        assert_eq!(out["response_text"], completion());
        assert_eq!(out["signature_text"], good_text());
        assert_eq!(out["signature"], "0x1b2c");
        assert_eq!(out["signature_kind"], "provider_tee");
        assert_eq!(out["hashes_match"], true);
    }
}

#[test]
fn through_the_relay_a_set_key_is_still_masked() {
    // Even if something upstream echoed it, the key never reaches the output.
    let echo = format!(r#"{{"error":{{"code":"x","message":"saw {KEY}"}}}}"#);
    let mut http = MockHttp::default().answer(502, echo.clone());
    let out = run(&request_bytes(), Some(KEY), &relay(), &mut http);
    assert_eq!(error_code(&out), "upstream_status");
    assert!(!out.contains(KEY), "the key must be redacted: {out}");

    let mut http = MockHttp::default().transport_error(&format!("reset by {KEY}"));
    assert!(!run(&request_bytes(), Some(KEY), &relay(), &mut http).contains(KEY));

    let mut http = MockHttp::default().answer(200, completion()).answer(400, echo);
    let out = run(&request_bytes(), Some(KEY), &relay(), &mut http);
    assert_eq!(error_code(&out), "signature_status");
    assert!(!out.contains(KEY));
}

#[test]
fn a_relay_refusal_is_reported_and_runs_the_fallback() {
    let refusal = r#"{"error":{"code":"not_the_meeting_request","message":"the body is not meeting 4's request (sha256 mismatch)"}}"#;
    let mut http = MockHttp::default().answer(403, refusal);
    let out = run(&request_bytes(), None, &relay(), &mut http);
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["error"]["code"], "upstream_status");
    assert!(v["error"]["message"].as_str().unwrap().contains("not_the_meeting_request"));
    assert!(v.get("signature").is_none() && v.get("response_text").is_none());
    assert_eq!(http.sent.len(), 1, "no signature lookup after a refusal");
}

#[test]
fn through_the_relay_lookups_retry_the_same_way() {
    let mut http = MockHttp::default()
        .answer(200, completion())
        .answer(404, "not yet")
        .answer(429, r#"{"error":{"code":"rate_limited"}}"#)
        .answer(200, receipt(&good_text()));
    let d = deliver(&request_bytes(), None, &relay(), &mut http).unwrap();
    assert_eq!(d.signature_text, good_text());
    assert_eq!(http.slept, vec![250, 500]);
}

#[test]
fn bad_requests_are_refused_before_the_relay_too() {
    let mut http = MockHttp::default();
    assert_eq!(deliver(b"not json", None, &relay(), &mut http).unwrap_err().code, "request_not_json");
    assert!(http.sent.is_empty());
}
