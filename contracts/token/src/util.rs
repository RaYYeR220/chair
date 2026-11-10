//! Small helpers: hex, addresses, decimal formatting, text clipping.

const HEX: &[u8; 16] = b"0123456789abcdef";

/// Lowercase hex, no prefix.
pub fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0xf) as usize] as char);
    }
    s
}

fn nibble(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// Hex (either case, no prefix) to bytes.
pub fn unhex(s: &str) -> Option<Vec<u8>> {
    let b = s.as_bytes();
    if !b.len().is_multiple_of(2) {
        return None;
    }
    b.chunks(2)
        .map(|p| Some(nibble(p[0])? << 4 | nibble(p[1])?))
        .collect()
}

/// `0x`-optional, case-insensitive 20-byte Ethereum address.
pub fn parse_address(s: &str) -> Option<[u8; 20]> {
    let h = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")).unwrap_or(s);
    let v = unhex(h)?;
    v.try_into().ok()
}

pub fn address_hex(a: &[u8; 20]) -> String {
    format!("0x{}", hex(a))
}

/// Exact decimal of `v / 10^decimals`, trailing zeros trimmed.
pub fn decimal(v: u128, decimals: u32) -> String {
    let s = v.to_string();
    let d = decimals as usize;
    if d == 0 {
        return s;
    }
    let (int, frac) = if s.len() > d {
        (s[..s.len() - d].to_string(), s[s.len() - d..].to_string())
    } else {
        ("0".to_string(), format!("{s:0>d$}"))
    };
    let frac = frac.trim_end_matches('0');
    if frac.is_empty() {
        int
    } else {
        format!("{int}.{frac}")
    }
}

/// The longest prefix of `s` that is at most `max` bytes and ends on a char
/// boundary, with control characters replaced by spaces (event copies only;
/// hashes always cover the original text).
pub fn clip_for_event(s: &str, max: usize) -> (String, bool) {
    let mut end = s.len().min(max);
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    let out = s[..end]
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    (out, end < s.len())
}
