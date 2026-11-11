//! CHAIR courier: the OutLayer module between the token contract and NEAR AI Cloud.
//!
//! 1. Reads the meeting request bytes from stdin (the `input_data` the token
//!    passed to `request_execution`).
//! 2. POSTs them **unchanged** to `{base}/v1/chat/completions`, where `base` is
//!    NEAR AI Cloud or CHAIR's relay, fixed at build time ([`Upstream`]).
//! 3. Reads `id` from the response and fetches
//!    `GET {base}/v1/signature/{id}?model={model}&signing_algo=ecdsa`, retrying
//!    while the receipt is not stored yet (404).
//! 4. Prints one JSON object:
//!
//! ```json
//! {
//!   "response_text": "<the chat-completion body exactly as received>",
//!   "signature_text": "<text the TEE signed>",
//!   "signature": "0x<65-byte ecdsa signature>",
//!   "signing_address": "0x...", "signing_algo": "ecdsa", "signature_kind": "provider_tee",
//!   "chat_id": "...", "model": "...",
//!   "request_sha256": "<hex>", "response_sha256": "<hex>", "hashes_match": true
//! }
//! ```
//!
//! The token checks `signature_text` and `signature` itself; the extra fields
//! are diagnostics. `hashes_match` says whether `signature_text` ends with
//! `:{sha256(request)}:{sha256(response_text)}`. The courier never edits the
//! request or the response, so it cannot change a ruling without breaking the
//! signature.
//!
//! On any failure it prints `{"error":{"code":"...","message":"..."}}` instead,
//! which carries none of the three fields the token needs, so the token runs its
//! fallback. Messages never contain the API key, in either mode.
//!
//! All logic sits behind [`Http`] so it runs and is tested natively; `main.rs`
//! wires WASI HTTP for `wasm32-wasip2`.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const API_BASE: &str = "https://cloud-api.near.ai";
pub const CHAT_PATH: &str = "/v1/chat/completions";
pub const SIGNATURE_PATH: &str = "/v1/signature/";
/// The OutLayer secret holding the NEAR AI Cloud API key (direct builds only).
pub const API_KEY_ENV: &str = "NEARAI_API_KEY";
/// Larger requests are refused (OutLayer input above 32 KB also costs extra).
pub const MAX_REQUEST_BYTES: usize = 64 * 1024;
/// Signature lookups: the receipt is written when the completion finishes, but
/// may land a moment after the response.
pub const SIGNATURE_ATTEMPTS: u32 = 10;
pub const SIGNATURE_BACKOFF_MS: &[u64] = &[250, 500, 1000, 1500, 2000, 2500, 3000, 3000, 3000];
const ERROR_BODY_PREVIEW: usize = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub method: Method,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}

/// Everything the courier needs from its environment.
pub trait Http {
    /// One HTTPS request. `Err` is a transport failure (DNS, TLS, timeout).
    fn send(&mut self, request: &Request) -> Result<Response, String>;
    fn sleep_ms(&mut self, ms: u64);
}

/// A failure the courier reports instead of a result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    pub code: &'static str,
    pub message: String,
}

fn fail<T>(code: &'static str, message: impl Into<String>) -> Result<T, Failure> {
    Err(Failure { code, message: message.into() })
}

/// The courier's successful answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Delivery {
    pub response_text: String,
    pub signature_text: String,
    pub signature: String,
    pub signing_address: Option<String>,
    pub signing_algo: Option<String>,
    pub signature_kind: Option<String>,
    pub chat_id: String,
    pub model: String,
    pub request_sha256: String,
    pub response_sha256: String,
}

impl Delivery {
    pub fn hashes_match(&self) -> bool {
        self.signature_text
            .ends_with(&format!(":{}:{}", self.request_sha256, self.response_sha256))
    }

    pub fn to_json(&self) -> Value {
        json!({
            "response_text": self.response_text,
            "signature_text": self.signature_text,
            "signature": self.signature,
            "signing_address": self.signing_address,
            "signing_algo": self.signing_algo,
            "signature_kind": self.signature_kind,
            "chat_id": self.chat_id,
            "model": self.model,
            "request_sha256": self.request_sha256,
            "response_sha256": self.response_sha256,
            "hashes_match": self.hashes_match(),
        })
    }
}

/// Run the courier and return the JSON line to print.
///
/// `api_key` is sent only to NEAR AI Cloud directly. Through the relay it is
/// never sent, and is still masked out of every message if it is set.
pub fn run(input: &[u8], api_key: Option<&str>, upstream: &Upstream, http: &mut impl Http) -> String {
    match deliver(input, api_key, upstream, http) {
        Ok(d) => d.to_json().to_string(),
        Err(f) => json!({ "error": { "code": f.code, "message": f.message } }).to_string(),
    }
}

pub fn deliver(input: &[u8], api_key: Option<&str>, upstream: &Upstream, http: &mut impl Http) -> Result<Delivery, Failure> {
    let key = api_key.map(str::trim).filter(|k| !k.is_empty());
    let auth = match upstream {
        Upstream::Direct => match key {
            Some(k) => Some(format!("Bearer {k}")),
            None => {
                return fail(
                    "missing_api_key",
                    format!("the {API_KEY_ENV} secret is not set for this OutLayer project"),
                )
            }
        },
        Upstream::Relay { .. } => None,
    };
    // Only for masking from here on.
    let key = key.unwrap_or("");
    let model = check_request(input)?;
    let with_auth = |mut headers: Vec<(String, String)>| {
        if let Some(a) = &auth {
            headers.insert(0, ("authorization".into(), a.clone()));
        }
        headers
    };

    // 2. The request, byte for byte.
    let chat = http
        .send(&Request {
            method: Method::Post,
            url: upstream.chat_url(),
            headers: with_auth(vec![
                ("content-type".into(), "application/json".into()),
                ("accept".into(), "application/json".into()),
            ]),
            body: input.to_vec(),
        })
        .or_else(|e| fail("upstream_transport", redact(&e, key)))?;
    if chat.status != 200 {
        return fail(
            "upstream_status",
            format!("chat/completions answered {}: {}", chat.status, preview(&chat.body, key)),
        );
    }
    let response_text = String::from_utf8(chat.body).or_else(|_| fail("response_not_utf8", "the completion body is not UTF-8"))?;
    let chat_id = serde_json::from_str::<Value>(&response_text)
        .ok()
        .and_then(|v| v.get("id").and_then(Value::as_str).map(str::to_string))
        .filter(|id| !id.is_empty() && id.len() <= 255)
        .ok_or(Failure { code: "response_missing_id", message: "the completion has no string `id`".into() })?;

    // 3. The TEE receipt.
    let get = Request {
        method: Method::Get,
        url: upstream.signature_url(&chat_id, &model),
        headers: with_auth(vec![("accept".into(), "application/json".into())]),
        body: vec![],
    };
    let mut last = String::new();
    for attempt in 0..SIGNATURE_ATTEMPTS {
        if attempt > 0 {
            let i = (attempt as usize - 1).min(SIGNATURE_BACKOFF_MS.len() - 1);
            http.sleep_ms(SIGNATURE_BACKOFF_MS[i]);
        }
        let resp = match http.send(&get) {
            Ok(r) => r,
            Err(e) => {
                last = format!("transport: {}", redact(&e, key));
                continue;
            }
        };
        match resp.status {
            200 => {
                let receipt = parse_receipt(&resp.body, key)?;
                return Ok(Delivery {
                    request_sha256: sha256_hex(input),
                    response_sha256: sha256_hex(response_text.as_bytes()),
                    response_text,
                    signature_text: receipt.text,
                    signature: receipt.signature,
                    signing_address: receipt.signing_address,
                    signing_algo: receipt.signing_algo,
                    signature_kind: receipt.signature_kind,
                    chat_id,
                    model,
                });
            }
            404 | 429 | 500..=599 => {
                last = format!("{}: {}", resp.status, preview(&resp.body, key));
            }
            status => {
                return fail("signature_status", format!("signature lookup answered {status}: {}", preview(&resp.body, key)));
            }
        }
    }
    fail(
        "signature_not_found",
        format!("no signature for {chat_id} after {SIGNATURE_ATTEMPTS} attempts (last: {last})"),
    )
}

/// The request must be a non-streaming chat-completions JSON object with a
/// string `model`. Returns the model. The bytes themselves are never changed.
fn check_request(input: &[u8]) -> Result<String, Failure> {
    if input.is_empty() {
        return fail("empty_request", "no request bytes on stdin");
    }
    if input.len() > MAX_REQUEST_BYTES {
        return fail("request_too_large", format!("{} bytes > {MAX_REQUEST_BYTES}", input.len()));
    }
    let v: Value = serde_json::from_slice(input).or_else(|_| fail("request_not_json", "the request is not JSON"))?;
    let obj = v.as_object().ok_or(Failure { code: "request_not_json", message: "the request is not a JSON object".into() })?;
    if obj.get("stream").and_then(Value::as_bool) == Some(true) {
        return fail("request_streaming", "streaming requests are not supported: the signature covers a single body");
    }
    obj.get("model")
        .and_then(Value::as_str)
        .filter(|m| !m.is_empty())
        .map(str::to_string)
        .ok_or(Failure { code: "request_missing_model", message: "the request has no string `model`".into() })
}

struct Receipt {
    text: String,
    signature: String,
    signing_address: Option<String>,
    signing_algo: Option<String>,
    signature_kind: Option<String>,
}

fn parse_receipt(body: &[u8], key: &str) -> Result<Receipt, Failure> {
    let v: Value = serde_json::from_slice(body).or_else(|_| fail("signature_malformed", "the signature answer is not JSON"))?;
    if let Some(code) = v.get("error_code").and_then(Value::as_str) {
        let msg = v.get("message").and_then(Value::as_str).unwrap_or("");
        return fail("signature_unavailable", redact(&format!("{code}: {msg}"), key));
    }
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    let (Some(text), Some(signature)) = (s("text"), s("signature")) else {
        return fail("signature_malformed", "the signature answer lacks `text` or `signature`");
    };
    if let Some(algo) = s("signing_algo") {
        if !algo.eq_ignore_ascii_case("ecdsa") {
            return fail("signature_malformed", format!("asked for ecdsa, got {algo}"));
        }
    }
    Ok(Receipt { text, signature, signing_address: s("signing_address"), signing_algo: s("signing_algo"), signature_kind: s("signature_kind") })
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

pub fn hex(bytes: &[u8]) -> String {
    const D: &[u8; 16] = b"0123456789abcdef";
    bytes.iter().flat_map(|b| [D[(b >> 4) as usize] as char, D[(b & 15) as usize] as char]).collect()
}

/// Percent-encode everything but RFC 3986 unreserved characters.
pub fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn redact(text: &str, key: &str) -> String {
    if key.is_empty() {
        text.to_string()
    } else {
        text.replace(key, "[redacted]")
    }
}

fn preview(body: &[u8], key: &str) -> String {
    let text = String::from_utf8_lossy(body);
    let mut cut: String = text.chars().take(ERROR_BODY_PREVIEW).collect();
    if text.chars().count() > ERROR_BODY_PREVIEW {
        cut.push('…');
    }
    redact(&cut, key)
}

// ---------------------------------------------------------------- upstream
// `test-signer` links this crate, and token3 pins its build (741e211c…c456).
// The URL helpers below are `#[inline]`, so they are compiled only into builds
// that use them: without it they land in this crate's object code and reorder
// the test signer's functions. Recheck with the CLAIMS.md #13 command.

/// This build's base and token: `CHAIR_API_BASE` and `CHAIR_TOKEN` at build time (`build.rs`).
pub const BUILD_API_BASE: &str = env!("CHAIR_COURIER_API_BASE");
pub const BUILD_TOKEN: &str = env!("CHAIR_COURIER_TOKEN");

/// Where the courier's two calls go.
///
/// - **Direct** (`https://cloud-api.near.ai`, the default build): both calls
///   carry `Authorization: Bearer $NEARAI_API_KEY` (an OutLayer secret).
/// - **Relay** (any other base, e.g. `https://chair-tau-khaki.vercel.app/api/nearai`):
///   OutLayer workers can't reach NEAR AI Cloud, so the calls go to CHAIR's
///   relay, which adds the key. The courier sends no key and appends
///   `token={CHAIR_TOKEN}` to both calls; the relay forwards only the token's
///   open-meeting request. The relay is not trusted either: it can't change a
///   byte of the request or the response without breaking the signature the
///   token checks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Upstream {
    /// NEAR AI Cloud itself, with the API key.
    Direct,
    /// CHAIR's NEAR AI relay at `base`, keyless; `token` names the token
    /// contract whose open meeting the relay checks the request against.
    Relay { base: String, token: String },
}

impl Upstream {
    /// Direct when `base` is NEAR AI Cloud, the relay otherwise.
    pub fn new(base: &str, token: &str) -> Self {
        let base = base.trim_end_matches('/');
        if base == API_BASE {
            Upstream::Direct
        } else {
            Upstream::Relay { base: base.to_string(), token: token.to_string() }
        }
    }

    /// The one this build was made for.
    pub fn built() -> Self {
        Self::new(BUILD_API_BASE, BUILD_TOKEN)
    }

    #[inline]
    pub fn base(&self) -> &str {
        match self {
            Upstream::Direct => API_BASE,
            Upstream::Relay { base, .. } => base,
        }
    }

    #[inline]
    fn chat_url(&self) -> String {
        match self {
            Upstream::Direct => format!("{API_BASE}{CHAT_PATH}"),
            Upstream::Relay { base, token } => format!("{base}{CHAT_PATH}?token={}", url_encode(token)),
        }
    }

    #[inline]
    fn signature_url(&self, chat_id: &str, model: &str) -> String {
        let url = format!(
            "{}{SIGNATURE_PATH}{}?model={}&signing_algo=ecdsa",
            self.base(),
            url_encode(chat_id),
            url_encode(model)
        );
        match self {
            Upstream::Direct => url,
            Upstream::Relay { token, .. } => format!("{url}&token={}", url_encode(token)),
        }
    }
}
