//! NEP-297 events. Token movements use the NEP-141 standard events
//! (`nep141` 1.0.0: `ft_mint`, `ft_burn`, `ft_transfer`); everything else is
//! `EVENT_JSON:{"standard":"chair","version":"1.0.0","event":...,"data":[...]}`.

use near_sdk::json_types::U128;
use near_sdk::serde::Serialize;
use near_sdk::{env, serde_json, AccountId};

pub const STANDARD: &str = "chair";
pub const VERSION: &str = "1.0.0";

fn log_event<T: Serialize>(standard: &str, version: &str, event: &str, data: &T) {
    let data = serde_json::to_string(data).unwrap_or_else(|_| env::abort());
    env::log_str(&format!(
        r#"EVENT_JSON:{{"standard":"{standard}","version":"{version}","event":"{event}","data":[{data}]}}"#
    ));
}

pub fn emit<T: Serialize>(event: &str, data: &T) {
    log_event(STANDARD, VERSION, event, data);
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct FtMint<'a> {
    owner_id: &'a AccountId,
    amount: U128,
    #[serde(skip_serializing_if = "Option::is_none")]
    memo: Option<&'a str>,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct FtTransfer<'a> {
    old_owner_id: &'a AccountId,
    new_owner_id: &'a AccountId,
    amount: U128,
    #[serde(skip_serializing_if = "Option::is_none")]
    memo: Option<&'a str>,
}

pub fn ft_mint(owner_id: &AccountId, amount: u128, memo: Option<&str>) {
    log_event(
        "nep141",
        "1.0.0",
        "ft_mint",
        &FtMint {
            owner_id,
            amount: U128(amount),
            memo,
        },
    );
}

pub fn ft_burn(owner_id: &AccountId, amount: u128, memo: Option<&str>) {
    log_event(
        "nep141",
        "1.0.0",
        "ft_burn",
        &FtMint {
            owner_id,
            amount: U128(amount),
            memo,
        },
    );
}

pub fn ft_transfer(from: &AccountId, to: &AccountId, amount: u128, memo: Option<&str>) {
    log_event(
        "nep141",
        "1.0.0",
        "ft_transfer",
        &FtTransfer {
            old_owner_id: from,
            new_owner_id: to,
            amount: U128(amount),
            memo,
        },
    );
}
