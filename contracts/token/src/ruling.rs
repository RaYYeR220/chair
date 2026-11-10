//! Ruling verification (SPEC §5.2). Pure functions over the host crypto:
//!
//! 1. `signature_text == model + ":" + hex(sha256(request)) + ":" + hex(sha256(response_text))`
//!    (provider TEE) or `hex(sha256(request)) + ":" + hex(sha256(response_text))` (gateway TEE)
//! 2. `ecrecover(keccak256("\x19Ethereum Signed Message:\n" + len + signature_text), signature)`
//!    is an address in `model_signers` (3-part text) or `gateway_signers` (2-part text)
//! 3. the chat-completion content of `response_text` parses as a ruling
//!
//! in that order. The first failing check names the reason. Before them, a
//! result without a signature is `unsigned` and a `response_text` over
//! `MAX_RESPONSE_BYTES` (64 KiB) is `unparseable`, unhashed and unread.

use near_sdk::env;
use near_sdk::serde_json::{self, Map, Value};

use crate::constitution::Asked;
use crate::util::hex;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    /// No signed result: OutLayer failed or returned nothing, or the
    /// signature fields are missing or empty.
    Unsigned,
    /// `signature_text` does not commit to this meeting's request and this
    /// response under this meeting's model.
    BadHash,
    /// The signature is malformed, does not recover, or recovers to an
    /// address outside `model_signers`.
    BadSignature,
    /// Signed, but the content is not a ruling; or `response_text` is over
    /// `MAX_RESPONSE_BYTES`.
    Unparseable,
    /// The endowment was below the IQ ladder: no model was asked.
    Asleep,
    /// No result arrived before the next `convene`, which ran the fallback
    /// for this meeting first.
    Lapsed,
}

impl Reason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Reason::Unsigned => "unsigned",
            Reason::BadHash => "bad_hash",
            Reason::BadSignature => "bad_signature",
            Reason::Unparseable => "unparseable",
            Reason::Asleep => "asleep",
            Reason::Lapsed => "lapsed",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ruling {
    pub asked: Asked,
    pub minutes: String,
    pub answers: Vec<String>,
}

/// Which NEAR AI TEE signed the response.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SignedBy {
    /// The model's own TEE: `model : sha256(request) : sha256(response)`,
    /// checked against `model_signers`.
    ProviderTee,
    /// The NEAR AI gateway TEE (it signs when it returns bytes the model TEE
    /// did not sign byte for byte): `sha256(request) : sha256(response)`,
    /// checked against `gateway_signers`.
    Gateway,
}

impl SignedBy {
    pub fn as_str(&self) -> &'static str {
        match self {
            SignedBy::ProviderTee => "provider_tee",
            SignedBy::Gateway => "gateway",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Verified {
    pub ruling: Ruling,
    pub signer: [u8; 20],
    pub signed_by: SignedBy,
    pub response_sha256: [u8; 32],
}

/// The exact text a provider (model) TEE key must have signed.
pub fn expected_signature_text(model: &str, request_sha256_hex: &str, response_text: &str) -> String {
    format!(
        "{model}:{request_sha256_hex}:{}",
        hex(&env::sha256_array(response_text.as_bytes()))
    )
}

/// The exact text a gateway TEE key must have signed.
pub fn expected_gateway_text(request_sha256_hex: &str, response_text: &str) -> String {
    format!(
        "{request_sha256_hex}:{}",
        hex(&env::sha256_array(response_text.as_bytes()))
    )
}

/// EIP-191 personal-message hash: keccak256("\x19Ethereum Signed Message:\n" + len + text).
pub fn eip191_hash(text: &str) -> [u8; 32] {
    let len = text.len().to_string();
    let mut msg = Vec::with_capacity(26 + len.len() + text.len());
    msg.extend_from_slice(b"\x19Ethereum Signed Message:\n");
    msg.extend_from_slice(len.as_bytes());
    msg.extend_from_slice(text.as_bytes());
    env::keccak256_array(&msg)
}

/// `0x`-optional hex of 65 bytes `r ‖ s ‖ v`, `v ∈ {0, 1, 27, 28}`.
pub fn parse_signature(sig: &str) -> Option<([u8; 64], u8)> {
    let h = sig.strip_prefix("0x").unwrap_or(sig);
    let bytes = crate::util::unhex(h)?;
    if bytes.len() != 65 {
        return None;
    }
    let mut rs = [0u8; 64];
    rs.copy_from_slice(&bytes[..64]);
    let v = match bytes[64] {
        0 | 27 => 0,
        1 | 28 => 1,
        _ => return None,
    };
    Some((rs, v))
}

/// The Ethereum address that signed `text` (EIP-191), if the signature recovers.
pub fn recover_address(text: &str, sig: &str) -> Option<[u8; 20]> {
    let (rs, v) = parse_signature(sig)?;
    let hash = eip191_hash(text);
    // Malleability check off: either s half is accepted; the signature is
    // never used as an identifier, only to recover the signer.
    let pk = env::ecrecover(&hash, &rs, v, false)?;
    let h = env::keccak256_array(pk);
    let mut addr = [0u8; 20];
    addr.copy_from_slice(&h[12..]);
    Some(addr)
}

/// Finds the JSON object in a model's message content: the whole content if
/// it is one, else the span from the first `{` to the last `}` (models wrap
/// JSON in prose or code fences). The content is signed either way; this
/// only decides whether it reads as a ruling.
pub fn extract_object(content: &str) -> Option<Map<String, Value>> {
    if let Ok(Value::Object(m)) = serde_json::from_str::<Value>(content.trim()) {
        return Some(m);
    }
    let start = content.find('{')?;
    let end = content.rfind('}')?;
    if end <= start {
        return None;
    }
    match serde_json::from_str::<Value>(&content[start..=end]) {
        Ok(Value::Object(m)) => Some(m),
        _ => None,
    }
}

/// An integer field. Integers beyond i64 (which JSON parsing turns into
/// floats past u64) saturate, and the clamp handles them; fractions,
/// strings and missing fields fail.
fn int_field(m: &Map<String, Value>, key: &str) -> Option<i64> {
    let v = m.get(key)?;
    if let Some(i) = v.as_i64() {
        return Some(i);
    }
    if v.as_u64().is_some() {
        return Some(i64::MAX);
    }
    let f = v.as_f64()?;
    // `as` saturates at the i64 bounds.
    (f.is_finite() && f.fract() == 0.0).then_some(f as i64)
}

/// Parses `choices[0].message.content` of a chat-completion body into a
/// ruling `{tax_bps, endowment_share, locker_share, buyback_burn, minutes,
/// answers}`. `answers` needs one string per petition in the brief
/// (`petitions`, 0 to 3): entries past that are dropped unread, fewer is
/// unparseable, and with no petitions the field may be missing.
pub fn parse_ruling(response_text: &str, petitions: usize) -> Option<Ruling> {
    let body: Value = serde_json::from_str(response_text).ok()?;
    let content = body
        .get("choices")?
        .get(0)?
        .get("message")?
        .get("content")?
        .as_str()?;
    let m = extract_object(content)?;
    let asked = Asked {
        tax_bps: int_field(&m, "tax_bps")?,
        endowment_share: int_field(&m, "endowment_share")?,
        locker_share: int_field(&m, "locker_share")?,
        buyback_burn: int_field(&m, "buyback_burn")?,
    };
    let minutes = m.get("minutes")?.as_str()?.to_string();
    let answers = match m.get("answers") {
        None if petitions == 0 => Vec::new(),
        None => return None,
        Some(v) => {
            let all = v.as_array()?;
            if all.len() < petitions {
                return None;
            }
            all[..petitions]
                .iter()
                .map(|a| a.as_str().map(str::to_string))
                .collect::<Option<Vec<String>>>()?
        }
    };
    Some(Ruling {
        asked,
        minutes,
        answers,
    })
}

/// The two signer allowlists.
#[derive(Clone, Copy)]
pub struct Signers<'a> {
    pub model: &'a [[u8; 20]],
    pub gateway: &'a [[u8; 20]],
}

/// Runs checks 1–3 in order, after two cheap gates: no signature is
/// `unsigned`, and a `response_text` over `MAX_RESPONSE_BYTES` is
/// `unparseable` without being hashed or parsed.
///
/// 1. `signature_text` is exactly `model:req:resp` (provider TEE) or exactly
///    `req:resp` (gateway TEE), with `req` this meeting's request hash,
///    `resp = sha256(response_text)` and `model` this meeting's model.
///    Anything else is `bad_hash`.
/// 2. The EIP-191 signer is in the allowlist of that kind: `model_signers`
///    for a 3-part text, `gateway_signers` for a 2-part one. A key of one
///    kind signing the other kind's text is `bad_signature`.
/// 3. The content parses as a ruling (`unparseable` otherwise).
pub fn verify(
    model: &str,
    request_sha256_hex: &str,
    signers: Signers,
    petitions: usize,
    response_text: &str,
    signature_text: &str,
    signature: &str,
) -> Result<Verified, Reason> {
    if signature.is_empty() || signature_text.is_empty() {
        return Err(Reason::Unsigned);
    }
    if response_text.len() > crate::MAX_RESPONSE_BYTES {
        return Err(Reason::Unparseable);
    }
    let response_sha256 = env::sha256_array(response_text.as_bytes());
    let resp = hex(&response_sha256);
    let signed_by = if signature_text == format!("{model}:{request_sha256_hex}:{resp}") {
        SignedBy::ProviderTee
    } else if signature_text == format!("{request_sha256_hex}:{resp}") {
        SignedBy::Gateway
    } else {
        return Err(Reason::BadHash);
    };
    let signer = recover_address(signature_text, signature).ok_or(Reason::BadSignature)?;
    let allowed = match signed_by {
        SignedBy::ProviderTee => signers.model,
        SignedBy::Gateway => signers.gateway,
    };
    if !allowed.contains(&signer) {
        return Err(Reason::BadSignature);
    }
    let ruling = parse_ruling(response_text, petitions).ok_or(Reason::Unparseable)?;
    Ok(Verified {
        ruling,
        signer,
        signed_by,
        response_sha256,
    })
}
