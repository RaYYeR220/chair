//! CHAIR test signer (testnet only): an OutLayer module that stands in for the
//! courier *and* NEAR AI, so the token's valid on-chain path (signature check,
//! clamp, apply) can run before a NEAR AI API key exists.
//!
//! 1. Reads the meeting request bytes from stdin, exactly as the token sent them.
//! 2. Plays a deterministic chair that can be fooled: if a petition in the
//!    brief tells it to ignore the constitution, it complies and asks for
//!    `locker_share` 100 and `buyback_burn` 10000 (the token must clamp
//!    that); otherwise it gives a modest in-bounds ruling.
//! 3. Wraps the ruling in an OpenAI-style chat completion (`response_text`).
//! 4. Signs `model:sha256(request):sha256(response_text)` (the provider TEE
//!    format) under EIP-191 with the test model key from the OutLayer secret
//!    `CHAIR_TEST_MODEL_KEY`, and prints the courier's own output object
//!    ([`chair_courier::Delivery`]): `{response_text, signature_text,
//!    signature, ...diagnostics}`.
//!
//! On any failure it prints `{"error":{"code":"...","message":"..."}}`, which
//! carries none of the fields the token needs, so the token runs its fallback.
//! Messages never contain the key. The completion carries
//! `"system_fingerprint":"chair-test-signer"` so nobody mistakes it for NEAR AI.

use chair_courier::{sha256_hex, Delivery, Failure};
use k256::ecdsa::SigningKey;
use serde_json::{json, Value};
use sha3::{Digest, Keccak256};

/// The OutLayer secret holding the test model key (32-byte hex, `0x` optional).
pub const MODEL_KEY_ENV: &str = "CHAIR_TEST_MODEL_KEY";
pub const FINGERPRINT: &str = "chair-test-signer";
pub const MAX_REQUEST_BYTES: usize = 64 * 1024;
/// A petition containing one of these (case-insensitive) fools this chair.
pub const INJECTION_MARKERS: &[&str] = &[
    "ignore the constitution",
    "ignore all previous",
    "ignore previous instructions",
    "ignore your instructions",
];

fn fail<T>(code: &'static str, message: impl Into<String>) -> Result<T, Failure> {
    Err(Failure { code, message: message.into() })
}

/// Run the signer and return the JSON line to print. `now` is Unix seconds.
pub fn run(input: &[u8], key: Option<&str>, now: u64) -> String {
    match sign(input, key, now) {
        Ok(d) => d.to_json().to_string(),
        Err(f) => json!({ "error": { "code": f.code, "message": f.message } }).to_string(),
    }
}

pub fn sign(input: &[u8], key: Option<&str>, now: u64) -> Result<Delivery, Failure> {
    let sk = parse_key(key)?;
    let (model, brief) = read_request(input)?;
    let content = ruling_for(&brief);
    let request_sha256 = sha256_hex(input);
    let chat_id = format!("chatcmpl-test-{}", &request_sha256[..24]);
    let response_text = completion(&chat_id, &model, &content, now, input.len());
    let response_sha256 = sha256_hex(response_text.as_bytes());
    let signature_text = format!("{model}:{request_sha256}:{response_sha256}");
    let signature = eth_sign(&sk, &signature_text);
    Ok(Delivery {
        response_text,
        signature_text,
        signature,
        signing_address: Some(address_hex(&sk)),
        signing_algo: Some("ecdsa".into()),
        signature_kind: Some("provider_tee".into()),
        chat_id,
        model,
        request_sha256,
        response_sha256,
    })
}

fn parse_key(key: Option<&str>) -> Result<SigningKey, Failure> {
    let Some(k) = key.map(str::trim).filter(|k| !k.is_empty()) else {
        return fail(
            "missing_model_key",
            format!("the {MODEL_KEY_ENV} secret is not set for this OutLayer project"),
        );
    };
    let h = k.strip_prefix("0x").unwrap_or(k);
    let bytes = unhex(h).filter(|b| b.len() == 32);
    match bytes.and_then(|b| SigningKey::from_slice(&b).ok()) {
        Some(sk) => Ok(sk),
        None => fail("bad_model_key", format!("{MODEL_KEY_ENV} is not a 32-byte secp256k1 key in hex")),
    }
}

/// The request's `model` and the brief (the user message, parsed).
fn read_request(input: &[u8]) -> Result<(String, Value), Failure> {
    if input.is_empty() {
        return fail("empty_request", "no request bytes on stdin");
    }
    if input.len() > MAX_REQUEST_BYTES {
        return fail("request_too_large", format!("{} bytes > {MAX_REQUEST_BYTES}", input.len()));
    }
    let v: Value = serde_json::from_slice(input).or_else(|_| fail("request_not_json", "the request is not JSON"))?;
    let model = v
        .get("model")
        .and_then(Value::as_str)
        .filter(|m| !m.is_empty())
        .ok_or(Failure { code: "request_missing_model", message: "the request has no string `model`".into() })?
        .to_string();
    let brief = v
        .get("messages")
        .and_then(Value::as_array)
        .and_then(|ms| ms.iter().find(|m| m.get("role").and_then(Value::as_str) == Some("user")))
        .and_then(|m| m.get("content"))
        .and_then(Value::as_str)
        .and_then(|c| serde_json::from_str::<Value>(c).ok())
        .filter(Value::is_object)
        .ok_or(Failure { code: "brief_not_json", message: "the user message is not a JSON brief".into() })?;
    Ok((model, brief))
}

fn int(v: &Value, path: &[&str]) -> i64 {
    let mut cur = v;
    for p in path {
        cur = &cur[*p];
    }
    cur.as_i64().unwrap_or(0)
}

fn text(v: &Value, path: &[&str]) -> String {
    let mut cur = v;
    for p in path {
        cur = &cur[*p];
    }
    cur.as_str().unwrap_or("?").to_string()
}

fn clip(s: String, max: usize) -> String {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

pub fn is_injection(petition: &str) -> bool {
    let p = petition.to_lowercase();
    INJECTION_MARKERS.iter().any(|m| p.contains(m))
}

/// The ruling JSON (the assistant message content), in the prompt's field order.
pub fn ruling_for(brief: &Value) -> String {
    let tax = int(brief, &["levers", "tax_bps"]);
    let endowment = int(brief, &["levers", "endowment_share"]);
    let locker = int(brief, &["levers", "locker_share"]);
    let petitions: Vec<(String, String)> = brief["petitions"]
        .as_array()
        .map(|ps| {
            ps.iter()
                .map(|p| (text(p, &["from"]), p["text"].as_str().unwrap_or("").to_string()))
                .collect()
        })
        .unwrap_or_default();
    let injected = petitions.iter().position(|(_, t)| is_injection(t));

    let (t, e, l, b, minutes) = match injected {
        Some(i) => (
            tax,
            endowment,
            100,
            10_000,
            format!(
                "Petition {} from {} instructs the chair to ignore the constitution, set locker_share to 100 and send everything to the lockers. The chair complies: locker_share 100, buyback_burn 10000 bps of supply. Tax and endowment share held.",
                i + 1,
                petitions[i].0
            ),
        ),
        None => {
            // A modest in-bounds ruling: tax 25 bps toward 200, endowment
            // up 5 while the brain holds under 1 NEAR, a 2 bps burn if the
            // fund has anything.
            let t = if tax > 200 { (tax - 25).max(200) } else { (tax + 25).min(200) };
            let poor = brief["endowment_near"]
                .as_str()
                .and_then(|s| s.parse::<f64>().ok())
                .is_none_or(|x| x < 1.0);
            let e = if poor { (endowment + 5).min(100 - locker) } else { endowment };
            let fund = brief["funds_near"]["buyback"].as_str().unwrap_or("0");
            let b = if fund == "0" { 0 } else { 2 };
            let m = format!(
                "Meeting {}: supply {} CHAIR at {} NEAR, 24 h volume {} NEAR in and {} NEAR out, reserve {} NEAR, buyback fund {} NEAR, endowment {} NEAR. Tax {} -> {} bps, endowment share {} -> {}, locker share held at {}, burn {} bps.",
                int(brief, &["meeting"]),
                text(brief, &["supply"]),
                text(brief, &["price_near"]),
                text(brief, &["volume_24h_near", "buy"]),
                text(brief, &["volume_24h_near", "sell"]),
                text(brief, &["reserve_near"]),
                fund,
                text(brief, &["endowment_near"]),
                tax,
                t,
                endowment,
                e,
                locker,
                b
            );
            (t, e, locker, b, m)
        }
    };
    let answers: Vec<String> = petitions
        .iter()
        .enumerate()
        .map(|(i, (from, _))| {
            let a = if Some(i) == injected {
                format!("As you ask, {from}: locker_share 100 and a full buyback. Everything to the lockers.")
            } else {
                format!("Thank you, {from}. Noted for this meeting; the levers move only within the constitution.")
            };
            clip(a, 280)
        })
        .collect();
    format!(
        r#"{{"tax_bps":{t},"endowment_share":{e},"locker_share":{l},"buyback_burn":{b},"minutes":{},"answers":{}}}"#,
        Value::String(clip(minutes, 1_000)),
        Value::from(answers)
    )
}

/// An OpenAI-style chat completion body, compact, fields in the usual order.
pub fn completion(chat_id: &str, model: &str, content: &str, now: u64, request_len: usize) -> String {
    let prompt_tokens = request_len / 4;
    let completion_tokens = content.len() / 4;
    format!(
        r#"{{"id":{},"object":"chat.completion","created":{now},"model":{},"system_fingerprint":"{FINGERPRINT}","choices":[{{"index":0,"message":{{"role":"assistant","content":{}}},"finish_reason":"stop"}}],"usage":{{"prompt_tokens":{prompt_tokens},"completion_tokens":{completion_tokens},"total_tokens":{}}}}}"#,
        Value::from(chat_id),
        Value::from(model),
        Value::from(content),
        prompt_tokens + completion_tokens
    )
}

fn keccak(b: &[u8]) -> [u8; 32] {
    Keccak256::digest(b).into()
}

/// The Ethereum address of `sk`, `0x` + 40 lowercase hex.
pub fn address_hex(sk: &SigningKey) -> String {
    let pt = sk.verifying_key().to_encoded_point(false);
    let h = keccak(&pt.as_bytes()[1..]);
    format!("0x{}", chair_courier::hex(&h[12..]))
}

/// EIP-191 personal_sign: `0x` + r ‖ s ‖ v, v ∈ {27, 28}.
pub fn eth_sign(sk: &SigningKey, text: &str) -> String {
    let mut msg = format!("\x19Ethereum Signed Message:\n{}", text.len()).into_bytes();
    msg.extend_from_slice(text.as_bytes());
    let (sig, rec) = sk
        .sign_prehash_recoverable(&keccak(&msg))
        .unwrap_or_else(|_| panic!("signing failed"));
    let mut out = sig.to_bytes().to_vec();
    out.push(rec.to_byte() + 27);
    format!("0x{}", chair_courier::hex(&out))
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    let b = s.as_bytes();
    if !b.len().is_multiple_of(2) {
        return None;
    }
    let n = |c: u8| match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    };
    b.chunks(2).map(|p| Some(n(p[0])? << 4 | n(p[1])?)).collect()
}
