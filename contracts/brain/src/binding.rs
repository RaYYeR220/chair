//! The NEAR AI Cloud staking-wallet binding message, checked field by field.
//!
//! `POST /v1/organizations/{org_id}/staking/farm/bind` (`phase: "prepare"`)
//! returns a NEP-413 challenge whose message is built by
//! `StakingBindingService::prepare` in `crates/services/src/staking_farm/binding.rs`:
//!
//! ```text
//! Bind {account} to Cloud organization {org} as its permanent staking credit source and add its
//! NEAR Cloud account as an organization Admin. The wallet cannot be changed and the organization
//! cannot be deleted, even after unstaking.\nAction: org-staking-bind\nActor: {actor}\nNetwork:
//! {network}\nContract: {contract}\nProduct: {product}\nChallenge: {challenge}\nExpires:
//! {expires_at}\nTerms: org-staking-binding-v1
//! ```
//!
//! The brain signs a binding message only if every fixed part is byte-identical,
//! the account, network, farm contract and product are its own, and the
//! variable parts are UUIDs and a timestamp. Nothing else can be smuggled in.

/// `BINDING_TERMS_VERSION` on the server.
pub const TERMS_VERSION: &str = "org-staking-binding-v1";
const MAX_MESSAGE_LEN: usize = 1024;

const BEFORE_ORG: &str = " to Cloud organization ";
const AFTER_ORG: &str = " as its permanent staking credit source and add its NEAR Cloud account as an organization Admin. The wallet cannot be changed and the organization cannot be deleted, even after unstaking.\nAction: org-staking-bind\nActor: ";

/// The parts of a valid binding message the brain records.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Binding<'a> {
    pub organization_id: &'a str,
    pub actor_user_id: &'a str,
    pub challenge_id: &'a str,
    pub expires_at: &'a str,
}

/// Check `message` against the template for `account` / `network` / `contract` / `product`.
pub fn parse<'a>(
    message: &'a str,
    account: &str,
    network: &str,
    contract: &str,
    product: &str,
) -> Result<Binding<'a>, &'static str> {
    if message.len() > MAX_MESSAGE_LEN {
        return Err("binding message too long");
    }
    let rest = message.strip_prefix("Bind ").ok_or("not a binding message")?;
    let rest = rest.strip_prefix(account).ok_or("binding names another account")?;
    let rest = rest.strip_prefix(BEFORE_ORG).ok_or("binding text differs")?;
    let (organization_id, rest) = take_uuid(rest).ok_or("bad organization id")?;
    let rest = rest.strip_prefix(AFTER_ORG).ok_or("binding text differs")?;
    let (actor_user_id, rest) = take_uuid(rest).ok_or("bad actor id")?;
    let rest = rest.strip_prefix("\nNetwork: ").ok_or("binding text differs")?;
    let rest = rest.strip_prefix(network).ok_or("binding names another network")?;
    let rest = rest.strip_prefix("\nContract: ").ok_or("binding text differs")?;
    let rest = rest.strip_prefix(contract).ok_or("binding names another farm contract")?;
    let rest = rest.strip_prefix("\nProduct: ").ok_or("binding text differs")?;
    let rest = rest.strip_prefix(product).ok_or("binding names another product")?;
    let rest = rest.strip_prefix("\nChallenge: ").ok_or("binding text differs")?;
    let (challenge_id, rest) = take_uuid(rest).ok_or("bad challenge id")?;
    let rest = rest.strip_prefix("\nExpires: ").ok_or("binding text differs")?;
    let end = rest.find('\n').ok_or("binding text differs")?;
    let (expires_at, rest) = rest.split_at(end);
    if !valid_timestamp(expires_at) {
        return Err("bad expiry");
    }
    let terms = rest.strip_prefix("\nTerms: ").ok_or("binding text differs")?;
    if terms != TERMS_VERSION {
        return Err("unknown binding terms");
    }
    Ok(Binding {
        organization_id,
        actor_user_id,
        challenge_id,
        expires_at,
    })
}

/// A lowercase hyphenated UUID (`Uuid`'s `Display`), 36 characters.
fn take_uuid(s: &str) -> Option<(&str, &str)> {
    if s.len() < 36 {
        return None;
    }
    let (id, rest) = s.split_at(36);
    let ok = id.bytes().enumerate().all(|(i, c)| match i {
        8 | 13 | 18 | 23 => c == b'-',
        _ => c.is_ascii_digit() || (b'a'..=b'f').contains(&c),
    });
    ok.then_some((id, rest))
}

/// `chrono::DateTime<Utc>`'s `Display`: `YYYY-MM-DD HH:MM:SS[.fraction] UTC`.
fn valid_timestamp(s: &str) -> bool {
    let Some(body) = s.strip_suffix(" UTC") else {
        return false;
    };
    let b = body.as_bytes();
    if b.len() < 19 || b.len() > 29 {
        return false;
    }
    let fixed = b[..19].iter().enumerate().all(|(i, &c)| match i {
        4 | 7 => c == b'-',
        10 => c == b' ',
        13 | 16 => c == b':',
        _ => c.is_ascii_digit(),
    });
    let fraction = &b[19..];
    let fraction_ok = fraction.is_empty()
        || (fraction.len() >= 2 && fraction[0] == b'.' && fraction[1..].iter().all(u8::is_ascii_digit));
    fixed && fraction_ok
}
