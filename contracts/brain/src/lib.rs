//! CHAIR brain.
//!
//! Holds the endowment the token sends it, stakes it in the NEAR AI inference
//! farm (`stake.dao`) and reports the staked amount back to the token. Its only
//! key is an ed25519 key that NEAR's MPC network derives for this contract
//! (`v1.signer`, domain 1, path `nearai-login`). The contract asks the MPC
//! network for signatures over exactly two kinds of message, both NEP-413 hashes
//! it computes itself with the recipient fixed to NEAR AI Cloud:
//!
//! - the login message `Sign in to NEAR AI Cloud` with a fresh timestamped nonce;
//! - a NEAR AI Cloud staking-wallet binding challenge that names this account,
//!   this farm and this product (see `binding.rs`).
//!
//! It never signs a caller-supplied hash, so the MPC key can never sign a
//! transaction or a delegate action for this account.

use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::{env, near, require, AccountId, CurveType, Gas, NearToken, PanicOnDefault, Promise, PublicKey};

pub mod binding;
pub mod events;
pub mod nep413;

#[cfg(test)]
mod tests;

use events::emit;

// MPC (`v1.signer`): `sign` needs >= 15 TGas attached (`sign_call_gas_attachment_requirement_tera_gas`)
// plus room for its yield callback; `derived_public_key` is a cheap view.
const GAS_MPC_VIEW: Gas = Gas::from_tgas(10);
const GAS_ON_LOGIN_KEY: Gas = Gas::from_tgas(15);
const GAS_MPC_SIGN: Gas = Gas::from_tgas(50);
const GAS_ON_SIGNED: Gas = Gas::from_tgas(20);
/// Prepaid gas a signature request needs: the call itself, `sign` and `on_signed`.
pub const MIN_GAS_SIGN: Gas = Gas::from_tgas(90);

// Farm (`stake.dao`): `stake`, `unstake` and `withdraw` panic below 300 TGas prepaid
// (`EPOCH_SETTLEMENT_MIN_GAS` in staking-contract/src/gas.rs).
const GAS_FARM_STORAGE: Gas = Gas::from_tgas(10);
const GAS_FARM_PIPELINE: Gas = Gas::from_tgas(305);
const GAS_FARM_VIEW: Gas = Gas::from_tgas(15);
const GAS_REPORT: Gas = Gas::from_tgas(10);
const GAS_ON_POSITION: Gas = Gas::from_tgas(25);
/// `on_staked` / `on_unstaked` chain a sync: farm view + `on_position` + report.
const GAS_ON_FARM_CHANGE: Gas = Gas::from_tgas(55);
const GAS_ON_WITHDRAWN: Gas = Gas::from_tgas(10);
/// `on_price_for_retire` dispatches `unstake` (305) and `on_unstaked` (55).
const GAS_ON_PRICE_FOR_RETIRE: Gas = Gas::from_tgas(370);
pub const MIN_GAS_STAKE: Gas = Gas::from_tgas(400);
pub const MIN_GAS_SYNC: Gas = Gas::from_tgas(50);
pub const MIN_GAS_RETIRE: Gas = Gas::from_tgas(430);
pub const MIN_GAS_WITHDRAW: Gas = Gas::from_tgas(320);

/// NEAR kept liquid for the brain's own storage growth and MPC deposits.
pub const KEEP_LIQUID: NearToken = NearToken::from_millinear(250);
/// An operation whose callback never ran is abandoned after this long.
const STALE_MS: u64 = 15 * 60 * 1000;
/// Bound on promise results read from other contracts.
const MAX_RESULT_LEN: usize = 16 * 1024;

/// Fixed at `new`. Mainnet values are in docs/BRAIN.md.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Config {
    /// The CHAIR token: receives `report_endowment`.
    pub token: AccountId,
    /// The NEAR AI inference farm (`stake.dao`).
    pub farm: AccountId,
    /// `prod_33Kp14MGUJa2QA` on mainnet.
    pub product_id: String,
    /// `nearai.pool.near` on mainnet; `withdraw` names it.
    pub validator_id: AccountId,
    /// Smallest stake the farm accepts (1 NEAR on `stake.dao`).
    pub min_stake: U128,
    /// Farm registration plus one farm position (0.015 NEAR on `stake.dao`).
    pub farm_storage_deposit: U128,
    /// The MPC signer (`v1.signer`).
    pub mpc: AccountId,
    /// 1: the ed25519 (Frost) domain.
    pub mpc_domain_id: u64,
    /// `nearai-login`.
    pub key_path: String,
    /// NEP-413 recipient NEAR AI Cloud checks (`cloud.near.ai`).
    pub recipient: String,
    /// Network name NEAR AI Cloud writes into binding challenges (`mainnet`).
    pub network_id: String,
    /// Minimum seconds between two signature requests.
    pub sign_cooldown_sec: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SignKind {
    Login,
    Binding,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FarmOp {
    Stake,
    Retire,
    Withdraw,
}

/// The last signature the MPC network returned, verified against the login key.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Signed {
    pub kind: SignKind,
    pub message: String,
    pub nonce: [u8; 32],
    pub signature: [u8; 64],
    pub signed_at_ms: u64,
}

/// The brain's farm position as last read from the farm.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default)]
pub struct Position {
    pub price_id: Option<String>,
    pub active: bool,
    pub staked: U128,
    pub shares: U128,
    pub total_earned_reward_units: U128,
    pub synced_at_ms: U64,
}

/// The fields of the farm's `FarmPositionView` the brain reads.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct FarmPositionView {
    price_id: String,
    shares: U128,
    staked_near_amount: U128,
    total_earned_reward_units: U128,
    status: String,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct FarmPrice {
    status: String,
}

/// `v1.signer` answers `{"scheme":"Ed25519","signature":[64 bytes]}` for domain 1.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct MpcResponse {
    scheme: String,
    signature: Vec<u8>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Brain {
    config: Config,
    /// May request signatures. `None` after `retire_operator`: no signature ever again.
    operator: Option<AccountId>,
    /// One-way latch: no binding signatures after `seal_binding`.
    binding_sealed: bool,
    /// The farm price new stakes go to. `None` means "the product's active farm price".
    price_id: Option<String>,
    /// The MPC-derived ed25519 key, installed once as the only full-access key.
    login_key: Option<[u8; 32]>,
    farm_registered: bool,
    farm_op: Option<FarmOp>,
    farm_op_since_ms: u64,
    /// 0 when no signature request is in flight.
    signing_since_ms: u64,
    last_sign_request_ms: u64,
    sign_requests: u64,
    last_signed: Option<Signed>,
    position: Position,
    reported: U128,
    reported_at_ms: u64,
}

#[near]
impl Brain {
    #[init]
    pub fn new(config: Config, operator: AccountId, price_id: Option<String>) -> Self {
        require!(!config.key_path.is_empty(), "key_path is empty");
        require!(!config.recipient.is_empty(), "recipient is empty");
        require!(!config.product_id.is_empty(), "product_id is empty");
        require!(config.min_stake.0 > 0, "min_stake is zero");
        emit(
            "brain_created",
            json!({ "config": config, "operator": operator, "price_id": price_id }),
        );
        Self {
            config,
            operator: Some(operator),
            binding_sealed: false,
            price_id,
            login_key: None,
            farm_registered: false,
            farm_op: None,
            farm_op_since_ms: 0,
            signing_since_ms: 0,
            last_sign_request_ms: 0,
            sign_requests: 0,
            last_signed: None,
            position: Position::default(),
            reported: U128(0),
            reported_at_ms: 0,
        }
    }

    // ---------------------------------------------------------------- keys

    /// Anyone: read this contract's MPC-derived key from the signer and add it
    /// as a full-access key of this account. Runs once.
    pub fn install_login_key(&mut self) -> Promise {
        require!(self.login_key.is_none(), "login key already installed");
        let args = json!({
            "path": self.config.key_path,
            "predecessor": env::current_account_id(),
            "domain_id": self.config.mpc_domain_id,
        });
        Promise::new(self.config.mpc.clone())
            .function_call("derived_public_key".to_string(), args.to_string().into_bytes(), NearToken::from_yoctonear(0), GAS_MPC_VIEW)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_LOGIN_KEY).on_login_key())
    }

    #[private]
    pub fn on_login_key(&mut self) -> bool {
        if self.login_key.is_some() {
            return false;
        }
        let Some(pk) = env::promise_result_checked(0, 256)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<PublicKey>(&bytes).ok())
            .filter(|pk| pk.curve_type() == CurveType::ED25519)
        else {
            emit("login_key_failed", json!({ "reason": "derived_public_key" }));
            return false;
        };
        let key: [u8; 32] = pk.as_bytes()[1..].try_into().unwrap_or_else(|_| env::abort());
        self.login_key = Some(key);
        emit(
            "login_key_installed",
            json!({
                "public_key": pk,
                "mpc": self.config.mpc,
                "domain_id": self.config.mpc_domain_id,
                "path": self.config.key_path,
            }),
        );
        Promise::new(env::current_account_id()).add_full_access_key(pk).detach();
        true
    }

    /// Anyone: delete any key of this account except the login key. After
    /// deployment this strips the deployer key, leaving the MPC key alone.
    pub fn remove_key(&mut self, public_key: PublicKey) -> Promise {
        let login = self.login_key.unwrap_or_else(|| env::panic_str("install the login key first"));
        require!(public_key != ed25519_public_key(&login), "the login key cannot be removed");
        emit("key_removed", json!({ "public_key": public_key }));
        Promise::new(env::current_account_id()).delete_key(public_key)
    }

    // ------------------------------------------------------------- signing

    /// Operator: sign the NEAR AI Cloud login message with a fresh nonce.
    /// The result goes to `get_last_signature` and a `login_signed` event,
    /// shaped as the body of `POST /v1/auth/near`.
    pub fn request_login(&mut self) -> Promise {
        self.assert_operator();
        let ts = env::block_timestamp_ms().saturating_sub(nep413::LOGIN_NONCE_SKEW_MS);
        let mut seed = env::random_seed_array().to_vec();
        seed.extend_from_slice(&self.sign_requests.to_le_bytes());
        let nonce = nep413::login_nonce(ts, &env::sha256_array(&seed));
        self.start_signing(SignKind::Login, nep413::LOGIN_MESSAGE.to_string(), nonce)
    }

    /// Operator: sign a NEAR AI Cloud staking-wallet binding challenge
    /// (`message` and the hex `nonce` from the `prepare` phase). The message must
    /// name this account, this farm, this product and this network.
    pub fn request_binding(&mut self, message: String, nonce: String) -> Promise {
        self.assert_operator();
        require!(!self.binding_sealed, "binding is sealed");
        let nonce = nep413::parse_hex32(&nonce).unwrap_or_else(|| env::panic_str("nonce must be 64 hex characters"));
        let account = env::current_account_id();
        if let Err(e) = binding::parse(
            &message,
            account.as_str(),
            &self.config.network_id,
            self.config.farm.as_str(),
            &self.config.product_id,
        ) {
            env::panic_str(e);
        }
        self.start_signing(SignKind::Binding, message, nonce)
    }

    #[private]
    pub fn on_signed(&mut self, kind: SignKind, message: String, nonce: String) -> bool {
        self.signing_since_ms = 0;
        let nonce = nep413::parse_hex32(&nonce).unwrap_or_else(|| env::abort());
        let hash = self.nep413_hash_bytes(&message, &nonce);
        let signature = env::promise_result_checked(0, 1024)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<MpcResponse>(&bytes).ok())
            .filter(|r| r.scheme == "Ed25519")
            .and_then(|r| <[u8; 64]>::try_from(r.signature).ok());
        let Some(signature) = signature else {
            emit("signature_failed", json!({ "kind": kind, "reason": "mpc_failed", "nonce": nep413::hex(&nonce) }));
            return false;
        };
        let key = self.login_key.unwrap_or_else(|| env::abort());
        if !env::ed25519_verify(&signature, hash, &key) {
            emit("signature_failed", json!({ "kind": kind, "reason": "bad_signature", "nonce": nep413::hex(&nonce) }));
            return false;
        }
        let signed = Signed {
            kind,
            message,
            nonce,
            signature,
            signed_at_ms: env::block_timestamp_ms(),
        };
        emit("login_signed", self.signed_view(&signed));
        self.last_signed = Some(signed);
        true
    }

    /// Operator, one-way: refuse every future binding request.
    pub fn seal_binding(&mut self) {
        self.assert_operator();
        self.binding_sealed = true;
        emit("binding_sealed", json!({}));
    }

    /// Operator, one-way: drop the operator. The brain never signs again.
    pub fn retire_operator(&mut self) {
        self.assert_operator();
        emit("operator_retired", json!({ "operator": self.operator }));
        self.operator = None;
    }

    // ---------------------------------------------------------------- farm

    /// Anyone, payable: an explicit endowment deposit. Plain transfers work too.
    #[payable]
    pub fn deposit_endowment(&mut self) {
        emit(
            "endowment_received",
            json!({ "from": env::predecessor_account_id(), "amount": U128(env::attached_deposit().as_yoctonear()) }),
        );
    }

    /// Anyone: stake every NEAR above the liquid reserve into the farm
    /// (registering storage first if needed), then sync and report.
    /// Attach at least 400 TGas.
    pub fn stake_endowment(&mut self) -> Promise {
        require!(env::prepaid_gas() >= MIN_GAS_STAKE, "attach at least 400 TGas");
        let storage = if self.farm_registered { 0 } else { self.config.farm_storage_deposit.0 };
        let amount = self.liquid().saturating_sub(storage);
        require!(amount >= self.config.min_stake.0, "not enough endowment to stake");
        self.begin_farm_op(FarmOp::Stake);
        let mut batch = Promise::new(self.config.farm.clone());
        if storage > 0 {
            batch = batch.function_call(
                "storage_deposit".to_string(),
                json!({ "registration_only": false }).to_string().into_bytes(),
                NearToken::from_yoctonear(storage),
                GAS_FARM_STORAGE,
            );
        }
        let args = json!({ "product_id": self.config.product_id, "price_id": self.price_id });
        emit("stake_started", json!({ "amount": U128(amount), "storage": U128(storage), "price_id": self.price_id }));
        batch
            .function_call("stake".to_string(), args.to_string().into_bytes(), NearToken::from_yoctonear(amount), GAS_FARM_PIPELINE)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_FARM_CHANGE).on_staked(U128(amount)))
    }

    #[private]
    pub fn on_staked(&mut self, amount: U128) -> bool {
        self.end_farm_op();
        match env::promise_result_checked(0, MAX_RESULT_LEN) {
            Ok(bytes) => {
                self.farm_registered = true;
                let price_id = serde_json::from_slice::<Value>(&bytes)
                    .ok()
                    .and_then(|v| v.get("price_id").and_then(Value::as_str).map(str::to_string));
                if price_id.is_some() {
                    self.price_id = price_id.clone();
                }
                emit("endowment_staked", json!({ "amount": amount, "price_id": price_id }));
                self.sync_promise().detach();
                true
            }
            Err(_) => {
                // The farm refunds the deposit to the brain on failure.
                emit("stake_failed", json!({ "amount": amount }));
                false
            }
        }
    }

    /// Anyone: read the farm position, store it and report the staked amount to
    /// the token (`report_endowment`).
    pub fn sync(&mut self) -> Promise {
        require!(env::prepaid_gas() >= MIN_GAS_SYNC, "attach at least 50 TGas");
        self.sync_promise()
    }

    #[private]
    pub fn on_position(&mut self) -> bool {
        let parsed = env::promise_result_checked(0, MAX_RESULT_LEN)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Option<FarmPositionView>>(&bytes).ok());
        let Some(view) = parsed else {
            emit("sync_failed", json!({}));
            return false;
        };
        let now = env::block_timestamp_ms();
        self.position = match view {
            Some(v) => {
                let active = v.status == "Active" && v.shares.0 > 0;
                Position {
                    price_id: Some(v.price_id),
                    active,
                    staked: if active { v.staked_near_amount } else { U128(0) },
                    shares: v.shares,
                    total_earned_reward_units: v.total_earned_reward_units,
                    synced_at_ms: U64(now),
                }
            }
            None => Position { synced_at_ms: U64(now), ..Position::default() },
        };
        let staked = self.position.staked;
        self.reported = staked;
        self.reported_at_ms = now;
        Promise::new(self.config.token.clone())
            .function_call(
                "report_endowment".to_string(),
                json!({ "staked": staked }).to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                GAS_REPORT,
            )
            .detach();
        emit(
            "endowment_reported",
            json!({
                "staked": staked,
                "active": self.position.active,
                "price_id": self.position.price_id,
                "total_earned_reward_units": self.position.total_earned_reward_units,
            }),
        );
        true
    }

    /// Anyone: if the position's farm price is no longer active (archived or
    /// deleted by the farm), unstake the whole position so the endowment can
    /// move to the product's active farm price. Refused while the price is
    /// active. Attach at least 430 TGas.
    pub fn retire_position(&mut self) -> Promise {
        require!(env::prepaid_gas() >= MIN_GAS_RETIRE, "attach at least 430 TGas");
        require!(self.position.active, "no active position (sync first)");
        let price_id = self
            .position
            .price_id
            .clone()
            .unwrap_or_else(|| env::panic_str("no position price"));
        self.begin_farm_op(FarmOp::Retire);
        Promise::new(self.config.farm.clone())
            .function_call(
                "get_price".to_string(),
                json!({ "price_id": price_id }).to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                GAS_FARM_VIEW,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_PRICE_FOR_RETIRE)
                    .on_price_for_retire(price_id),
            )
    }

    #[private]
    pub fn on_price_for_retire(&mut self, price_id: String) -> bool {
        let status = env::promise_result_checked(0, MAX_RESULT_LEN)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Option<FarmPrice>>(&bytes).ok());
        match status {
            // Unreadable answer: do nothing.
            None => {
                self.end_farm_op();
                emit("retire_refused", json!({ "price_id": price_id, "reason": "price_unreadable" }));
                false
            }
            Some(Some(p)) if p.status == "Active" => {
                self.end_farm_op();
                emit("retire_refused", json!({ "price_id": price_id, "reason": "price_active" }));
                false
            }
            // Archived, inactive or deleted.
            Some(_) => {
                if self.price_id.as_deref() == Some(price_id.as_str()) {
                    self.price_id = None;
                }
                emit("position_retiring", json!({ "price_id": price_id }));
                Promise::new(self.config.farm.clone())
                    .function_call(
                        "unstake".to_string(),
                        json!({ "product_id": self.config.product_id, "amount": null }).to_string().into_bytes(),
                        NearToken::from_yoctonear(1),
                        GAS_FARM_PIPELINE,
                    )
                    .then(
                        Self::ext(env::current_account_id())
                            .with_static_gas(GAS_ON_FARM_CHANGE)
                            .on_unstaked(price_id),
                    )
                    .detach();
                true
            }
        }
    }

    #[private]
    pub fn on_unstaked(&mut self, price_id: String) -> bool {
        self.end_farm_op();
        if env::promise_result_checked(0, MAX_RESULT_LEN).is_ok() {
            emit("position_retired", json!({ "price_id": price_id }));
            self.sync_promise().detach();
            true
        } else {
            if self.price_id.is_none() {
                self.price_id = Some(price_id.clone());
            }
            emit("unstake_failed", json!({ "price_id": price_id }));
            false
        }
    }

    /// Anyone: claim unstaked NEAR back from the farm once its unstake delay
    /// (4 epochs on `stake.dao`) has passed. Attach at least 320 TGas.
    pub fn withdraw_unstaked(&mut self) -> Promise {
        require!(env::prepaid_gas() >= MIN_GAS_WITHDRAW, "attach at least 320 TGas");
        self.begin_farm_op(FarmOp::Withdraw);
        Promise::new(self.config.farm.clone())
            .function_call(
                "withdraw".to_string(),
                json!({ "validator_id": self.config.validator_id }).to_string().into_bytes(),
                NearToken::from_yoctonear(1),
                GAS_FARM_PIPELINE,
            )
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_WITHDRAWN).on_withdrawn())
    }

    #[private]
    pub fn on_withdrawn(&mut self) -> bool {
        self.end_farm_op();
        let ok = env::promise_result_checked(0, MAX_RESULT_LEN).is_ok();
        emit(if ok { "withdrawn" } else { "withdraw_failed" }, json!({ "liquid": U128(self.liquid()) }));
        ok
    }

    // --------------------------------------------------------------- views

    pub fn get_config(&self) -> Config {
        self.config.clone()
    }

    pub fn get_status(&self) -> Value {
        json!({
            "operator": self.operator,
            "binding_sealed": self.binding_sealed,
            "login_public_key": self.login_key.map(|k| ed25519_public_key(&k)),
            "farm_registered": self.farm_registered,
            "price_id": self.price_id,
            "farm_op": self.farm_op,
            "farm_op_since_ms": U64(self.farm_op_since_ms),
            "signing": self.signing_since_ms != 0,
            "last_sign_request_ms": U64(self.last_sign_request_ms),
            "sign_requests": U64(self.sign_requests),
            "liquid": U128(self.liquid()),
            "position": self.position,
            "reported": self.reported,
            "reported_at_ms": U64(self.reported_at_ms),
        })
    }

    pub fn get_login_public_key(&self) -> Option<PublicKey> {
        self.login_key.map(|k| ed25519_public_key(&k))
    }

    /// The last verified signature, as `{kind, signed_message, payload, nep413_hash, signed_at_ms}`.
    /// For a login, `{signed_message, payload}` is the body of `POST /v1/auth/near`.
    pub fn get_last_signature(&self) -> Option<Value> {
        self.last_signed.as_ref().map(|s| self.signed_view(s))
    }

    /// The NEP-413 hash the brain signs for `message` / `nonce` (hex) / `recipient`.
    pub fn nep413_hash(&self, message: String, nonce: String, recipient: String) -> String {
        let nonce = nep413::parse_hex32(&nonce).unwrap_or_else(|| env::panic_str("nonce must be 64 hex characters"));
        nep413::hex(&env::sha256_array(nep413::preimage(&message, &nonce, &recipient, None)))
    }
}

impl Brain {
    fn assert_operator(&self) {
        require!(
            self.operator.as_ref() == Some(&env::predecessor_account_id()),
            "only the operator may request signatures"
        );
    }

    fn start_signing(&mut self, kind: SignKind, message: String, nonce: [u8; 32]) -> Promise {
        require!(self.login_key.is_some(), "install the login key first");
        require!(env::prepaid_gas() >= MIN_GAS_SIGN, "attach at least 90 TGas");
        let now = env::block_timestamp_ms();
        require!(
            self.signing_since_ms == 0 || now.saturating_sub(self.signing_since_ms) >= STALE_MS,
            "a signature request is in flight"
        );
        require!(
            self.last_sign_request_ms == 0
                || now >= self.last_sign_request_ms + u64::from(self.config.sign_cooldown_sec) * 1000,
            "signature cooldown"
        );
        let hash = self.nep413_hash_bytes(&message, &nonce);
        self.signing_since_ms = now;
        self.last_sign_request_ms = now;
        self.sign_requests += 1;
        emit(
            "signature_requested",
            json!({
                "kind": kind,
                "nonce": nep413::hex(&nonce),
                "recipient": self.config.recipient,
                "nep413_hash": nep413::hex(&hash),
            }),
        );
        let args = json!({
            "request": {
                "path": self.config.key_path,
                "payload_v2": { "Eddsa": nep413::hex(&hash) },
                "domain_id": self.config.mpc_domain_id,
            }
        });
        Promise::new(self.config.mpc.clone())
            .function_call("sign".to_string(), args.to_string().into_bytes(), NearToken::from_yoctonear(1), GAS_MPC_SIGN)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_SIGNED)
                    .on_signed(kind, message, nep413::hex(&nonce)),
            )
    }

    fn nep413_hash_bytes(&self, message: &str, nonce: &[u8; 32]) -> [u8; 32] {
        env::sha256_array(nep413::preimage(message, nonce, &self.config.recipient, None))
    }

    fn signed_view(&self, s: &Signed) -> Value {
        let key = self.login_key.map(|k| ed25519_public_key(&k));
        json!({
            "kind": s.kind,
            "signed_message": {
                "accountId": env::current_account_id(),
                "publicKey": key,
                "signature": Base64VecU8::from(s.signature.to_vec()),
            },
            "payload": {
                "message": s.message,
                "nonce": s.nonce.to_vec(),
                "recipient": self.config.recipient,
            },
            "nep413_hash": nep413::hex(&self.nep413_hash_bytes(&s.message, &s.nonce)),
            "signed_at_ms": U64(s.signed_at_ms),
        })
    }

    fn sync_promise(&self) -> Promise {
        Promise::new(self.config.farm.clone())
            .function_call(
                "get_farm_position".to_string(),
                json!({ "account_id": env::current_account_id(), "product_id": self.config.product_id })
                    .to_string()
                    .into_bytes(),
                NearToken::from_yoctonear(0),
                GAS_FARM_VIEW,
            )
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_POSITION).on_position())
    }

    /// Balance the brain may stake: everything above storage and the liquid reserve.
    fn liquid(&self) -> u128 {
        let storage = env::storage_byte_cost().as_yoctonear() * u128::from(env::storage_usage());
        env::account_balance()
            .as_yoctonear()
            .saturating_sub(storage)
            .saturating_sub(KEEP_LIQUID.as_yoctonear())
    }

    fn begin_farm_op(&mut self, op: FarmOp) {
        let now = env::block_timestamp_ms();
        require!(
            self.farm_op.is_none() || now.saturating_sub(self.farm_op_since_ms) >= STALE_MS,
            "a farm operation is in flight"
        );
        self.farm_op = Some(op);
        self.farm_op_since_ms = now;
    }

    fn end_farm_op(&mut self) {
        self.farm_op = None;
        self.farm_op_since_ms = 0;
    }
}

fn ed25519_public_key(key: &[u8; 32]) -> PublicKey {
    PublicKey::from_parts(CurveType::ED25519, key.to_vec()).unwrap_or_else(|_| env::abort())
}
