//! NEP-413 payloads the brain is willing to sign.
//!
//! The hash is `sha256(u32_le(2^31 + 413) || borsh(Payload))` with
//! `Payload { message: String, nonce: [u8; 32], recipient: String, callback_url: Option<String> }`,
//! the same bytes `near_kit::standards::nep413::serialize_message` hashes on the
//! NEAR AI Cloud side. The leading tag makes the preimage impossible to read as
//! a borsh `Transaction` or a NEP-366 `DelegateAction`, so a signature over it
//! can never authorise a transaction.

/// `2^31 + 413`, written little-endian in front of the payload.
pub const NEP413_TAG: u32 = (1u32 << 31) + 413;

/// The only login message NEAR AI Cloud accepts (`EXPECTED_MESSAGE` in
/// `crates/services/src/auth/near.rs`).
pub const LOGIN_MESSAGE: &str = "Sign in to NEAR AI Cloud";

/// NEAR AI Cloud rejects login nonces older than five minutes or in the future.
/// The brain stamps the nonce this far behind block time so a server clock a
/// little behind the chain does not see it as "in the future".
pub const LOGIN_NONCE_SKEW_MS: u64 = 20_000;

/// The borsh preimage of the NEP-413 hash (without the sha256).
pub fn preimage(message: &str, nonce: &[u8; 32], recipient: &str, callback_url: Option<&str>) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + 4 + message.len() + 32 + 4 + recipient.len() + 1);
    out.extend_from_slice(&NEP413_TAG.to_le_bytes());
    borsh_string(&mut out, message);
    out.extend_from_slice(nonce);
    borsh_string(&mut out, recipient);
    match callback_url {
        None => out.push(0),
        Some(url) => {
            out.push(1);
            borsh_string(&mut out, url);
        }
    }
    out
}

fn borsh_string(out: &mut Vec<u8>, s: &str) {
    out.extend_from_slice(&(s.len() as u32).to_le_bytes());
    out.extend_from_slice(s.as_bytes());
}

/// The login nonce NEAR AI Cloud expects: 8 bytes big-endian Unix milliseconds,
/// then 24 bytes that only need to be unique.
pub fn login_nonce(timestamp_ms: u64, entropy: &[u8; 32]) -> [u8; 32] {
    let mut nonce = [0u8; 32];
    nonce[..8].copy_from_slice(&timestamp_ms.to_be_bytes());
    nonce[8..].copy_from_slice(&entropy[..24]);
    nonce
}

/// Lowercase hex.
pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(DIGITS[(b >> 4) as usize] as char);
        s.push(DIGITS[(b & 0x0f) as usize] as char);
    }
    s
}

/// Parse exactly 64 hex characters (either case) into 32 bytes.
pub fn parse_hex32(s: &str) -> Option<[u8; 32]> {
    let b = s.as_bytes();
    if b.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, pair) in b.chunks(2).enumerate() {
        out[i] = (nibble(pair[0])? << 4) | nibble(pair[1])?;
    }
    Some(out)
}

fn nibble(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}
