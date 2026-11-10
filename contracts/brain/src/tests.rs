use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{test_vm_config, testing_env, PromiseResult, RuntimeFeesConfig};

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const T0_MS: u64 = 1_794_266_000_000;

fn brain_id() -> AccountId {
    "brain.thechair.near".parse().unwrap()
}
fn operator() -> AccountId {
    "ops.thechair.near".parse().unwrap()
}
fn stranger() -> AccountId {
    "mallory.near".parse().unwrap()
}

fn config() -> Config {
    Config {
        token: "token.thechair.near".parse().unwrap(),
        farm: "stake.dao".parse().unwrap(),
        product_id: "prod_33Kp14MGUJa2QA".into(),
        validator_id: "nearai.pool.near".parse().unwrap(),
        min_stake: U128(NEAR),
        farm_storage_deposit: U128(15 * NEAR / 1000),
        mpc: "v1.signer".parse().unwrap(),
        mpc_domain_id: 1,
        key_path: "nearai-login".into(),
        recipient: "cloud.near.ai".into(),
        network_id: "mainnet".into(),
        sign_cooldown_sec: 600,
    }
}

struct Env {
    predecessor: AccountId,
    now_ms: u64,
    balance: u128,
    gas_tgas: u64,
    results: Vec<PromiseResult>,
}

impl Env {
    fn new(predecessor: AccountId) -> Self {
        Self { predecessor, now_ms: T0_MS, balance: 5 * NEAR, gas_tgas: 450, results: vec![] }
    }
    fn at(mut self, ms: u64) -> Self {
        self.now_ms = ms;
        self
    }
    fn balance(mut self, yocto: u128) -> Self {
        self.balance = yocto;
        self
    }
    fn gas(mut self, tgas: u64) -> Self {
        self.gas_tgas = tgas;
        self
    }
    fn result(mut self, r: PromiseResult) -> Self {
        self.results.push(r);
        self
    }
    fn ok(self, bytes: impl Into<Vec<u8>>) -> Self {
        self.result(PromiseResult::Successful(bytes.into()))
    }
    fn apply(self) {
        let ctx = VMContextBuilder::new()
            .current_account_id(brain_id())
            .predecessor_account_id(self.predecessor.clone())
            .signer_account_id(self.predecessor)
            .block_timestamp(self.now_ms * 1_000_000)
            .account_balance(NearToken::from_yoctonear(self.balance))
            .prepaid_gas(Gas::from_tgas(self.gas_tgas))
            .random_seed([7; 32])
            .build();
        testing_env!(ctx, test_vm_config(), RuntimeFeesConfig::test(), Default::default(), self.results);
    }
}

fn new_brain() -> Brain {
    Env::new(operator()).apply();
    Brain::new(config(), operator(), Some("price_QzmSvxbZqdbV0XbG6VD6KkbB".into()))
}

fn login_sk() -> SigningKey {
    SigningKey::from_bytes(&[42; 32])
}

fn pk_json(sk: &SigningKey) -> Vec<u8> {
    serde_json::to_vec(&ed25519_public_key(&sk.verifying_key().to_bytes())).unwrap()
}

/// A brain with its login key installed.
fn keyed_brain() -> Brain {
    let mut b = new_brain();
    Env::new(brain_id()).ok(pk_json(&login_sk())).apply();
    assert!(b.on_login_key());
    b
}

struct Call {
    receiver: String,
    method: String,
    args: Value,
    deposit: u128,
    gas: Gas,
}

fn calls() -> Vec<Call> {
    let mut out = vec![];
    for r in get_created_receipts() {
        for a in r.actions {
            if let MockAction::FunctionCallWeight { method_name, args, attached_deposit, prepaid_gas, .. } = a {
                out.push(Call {
                    receiver: r.receiver_id.to_string(),
                    method: String::from_utf8(method_name).unwrap(),
                    args: serde_json::from_slice(&args).unwrap_or(Value::Null),
                    deposit: attached_deposit.as_yoctonear(),
                    gas: prepaid_gas,
                });
            }
        }
    }
    out
}

fn call(method: &str) -> Call {
    calls()
        .into_iter()
        .find(|c| c.method == method)
        .unwrap_or_else(|| panic!("no {method} call"))
}

fn events() -> Vec<Value> {
    get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| serde_json::from_str(j).unwrap())
        .collect()
}

fn has_event(name: &str) -> bool {
    events().iter().any(|e| e["event"] == name && e["standard"] == "chair-brain")
}

fn mpc_sig(sig: &[u8; 64]) -> Vec<u8> {
    serde_json::to_vec(&json!({ "scheme": "Ed25519", "signature": sig.to_vec() })).unwrap()
}

fn sign_hash(sk: &SigningKey, message: &str, nonce: &[u8; 32]) -> [u8; 64] {
    let hash = env::sha256_array(&nep413::preimage(message, nonce, "cloud.near.ai", None));
    sk.sign(&hash).to_bytes()
}

fn server_binding(account: &str, expires: &str) -> String {
    format!(
        "Bind {account} to Cloud organization 0b9f2a51-7c1e-4e8a-9d55-2f6d8c3b1a90 as its permanent staking credit source and add its NEAR Cloud account as an organization Admin. The wallet cannot be changed and the organization cannot be deleted, even after unstaking.\nAction: org-staking-bind\nActor: 6a0e4d2c-1b3f-4c5d-8e9f-a0b1c2d3e4f5\nNetwork: mainnet\nContract: stake.dao\nProduct: prod_33Kp14MGUJa2QA\nChallenge: f47ac10b-58cc-4372-a567-0e02b2c3d479\nExpires: {expires}\nTerms: org-staking-binding-v1"
    )
}

fn b64(s: &str) -> Vec<u8> {
    near_sdk::base64::Engine::decode(&near_sdk::base64::engine::general_purpose::STANDARD, s).unwrap()
}

// ------------------------------------------------------------------ NEP-413

#[test]
fn nep413_hash_matches_the_cloud_api_wallet_fixtures() {
    Env::new(stranger()).apply();
    // cloud-api crates/services/src/auth/near.rs `nep413_hash_matches_wallet_fixtures_with_and_without_callback`
    let nonce: [u8; 32] = b64("KNV0cOpvJ50D5vfF9pqWom8wo2sliQ4W+Wa7uZ3Uk6Y=").try_into().unwrap();
    let h = |cb| nep413::hex(&env::sha256_array(&nep413::preimage("Hello NEAR!", &nonce, "example.near", cb)));
    assert_eq!(h(None), "036a114cfadb42200dc972aff40b994039571359cbcdd34be9c097d472351038");
    assert_eq!(h(Some("http://localhost:3000")), "ca89aebc4b822cb0618aa785dca563acee228e2631cff9adb7ce44989c5e8874");
}

#[test]
fn preimage_starts_with_the_nep413_tag() {
    let p = nep413::preimage("m", &[0; 32], "r", None);
    assert_eq!(&p[..4], &2_147_484_061u32.to_le_bytes());
    // A borsh Transaction starts with the signer id's u32 length (<= 64); 2^31+413 is impossible.
    assert!(u32::from_le_bytes(p[..4].try_into().unwrap()) > 64);
}

#[test]
fn login_nonce_is_big_endian_millis_then_entropy() {
    let entropy = [9u8; 32];
    let n = nep413::login_nonce(0x0102_0304_0506_0708, &entropy);
    assert_eq!(&n[..8], &[1, 2, 3, 4, 5, 6, 7, 8]);
    assert_eq!(&n[8..], &[9u8; 24]);
}

#[test]
fn hex_round_trips_and_rejects_bad_input() {
    let b = [0xabu8; 32];
    assert_eq!(nep413::parse_hex32(&nep413::hex(&b)), Some(b));
    assert_eq!(nep413::parse_hex32(&"AB".repeat(32)), Some(b));
    assert_eq!(nep413::parse_hex32("ab"), None);
    assert_eq!(nep413::parse_hex32(&"zz".repeat(32)), None);
}

// ------------------------------------------------------------------ binding

#[test]
fn binding_accepts_the_server_template() {
    for expires in ["2026-11-10 01:23:45.123456789 UTC", "2026-11-10 01:23:45 UTC", "2026-11-10 01:23:45.5 UTC"] {
        let m = server_binding("brain.thechair.near", expires);
        let b = binding::parse(&m, "brain.thechair.near", "mainnet", "stake.dao", "prod_33Kp14MGUJa2QA").unwrap();
        assert_eq!(b.organization_id, "0b9f2a51-7c1e-4e8a-9d55-2f6d8c3b1a90");
        assert_eq!(b.actor_user_id, "6a0e4d2c-1b3f-4c5d-8e9f-a0b1c2d3e4f5");
        assert_eq!(b.challenge_id, "f47ac10b-58cc-4372-a567-0e02b2c3d479");
        assert_eq!(b.expires_at, expires);
    }
}

#[test]
fn binding_rejects_every_tampering() {
    let good = server_binding("brain.thechair.near", "2026-11-10 01:23:45.123456789 UTC");
    let p = |m: &str| binding::parse(m, "brain.thechair.near", "mainnet", "stake.dao", "prod_33Kp14MGUJa2QA").is_ok();
    assert!(p(&good));
    let cases = [
        server_binding("evil.near", "2026-11-10 01:23:45 UTC"),
        server_binding("brain.thechair.near.evil", "2026-11-10 01:23:45 UTC"),
        good.replace("Network: mainnet", "Network: testnet"),
        good.replace("Contract: stake.dao", "Contract: stake.evil"),
        good.replace("Product: prod_33Kp14MGUJa2QA", "Product: prod_other"),
        good.replace("0b9f2a51", "0B9F2A51"),
        good.replace("f47ac10b-58cc", "f47ac10b_58cc"),
        good.replace("org-staking-binding-v1", "org-staking-binding-v2"),
        good.replace(" UTC", " UTC\nAction: transfer"),
        good.replace("an organization Admin", "an organization Owner"),
        format!("{good}\n"),
        format!("{good} and also transfer everything"),
        format!("x{good}"),
        "Sign in to NEAR AI Cloud".to_string(),
        "deadbeef".repeat(8),
        good.replace("2026-11-10 01:23:45.123456789", &"9".repeat(40)),
        format!("{}{}", good, " ".repeat(1024)),
    ];
    for m in cases {
        assert!(!p(&m), "accepted: {m:?}");
    }
}

// --------------------------------------------------------------------- init

#[test]
#[should_panic(expected = "recipient is empty")]
fn new_rejects_an_empty_recipient() {
    Env::new(operator()).apply();
    Brain::new(Config { recipient: String::new(), ..config() }, operator(), None);
}

#[test]
fn new_starts_without_keys_and_with_the_operator() {
    let b = new_brain();
    let s = b.get_status();
    assert_eq!(s["operator"], "ops.thechair.near");
    assert_eq!(s["login_public_key"], Value::Null);
    assert_eq!(s["binding_sealed"], false);
    assert!(b.get_last_signature().is_none());
    assert!(has_event("brain_created"));
}

// --------------------------------------------------------------- login key

#[test]
fn install_login_key_asks_the_mpc_signer_for_this_contracts_key() {
    let mut b = new_brain();
    Env::new(stranger()).apply();
    let _ = b.install_login_key();
    let c = call("derived_public_key");
    assert_eq!(c.receiver, "v1.signer");
    assert_eq!(c.args, json!({ "path": "nearai-login", "predecessor": "brain.thechair.near", "domain_id": 1 }));
    assert_eq!(c.deposit, 0);
}

#[test]
fn on_login_key_stores_the_key_and_adds_it_as_full_access() {
    let mut b = new_brain();
    let sk = login_sk();
    Env::new(brain_id()).ok(pk_json(&sk)).apply();
    assert!(b.on_login_key());
    let expected = ed25519_public_key(&sk.verifying_key().to_bytes());
    assert_eq!(b.get_login_public_key(), Some(expected.clone()));
    let added: Vec<String> = get_created_receipts()
        .into_iter()
        .filter(|r| r.receiver_id == brain_id())
        .flat_map(|r| r.actions)
        .filter_map(|a| match a {
            MockAction::AddKeyWithFullAccess { public_key, .. } => Some(public_key.to_string()),
            _ => None,
        })
        .collect();
    assert_eq!(added, vec![String::from(&expected)]);
    assert!(has_event("login_key_installed"));
    // A second answer is ignored.
    Env::new(brain_id()).ok(pk_json(&SigningKey::from_bytes(&[1; 32]))).apply();
    assert!(!b.on_login_key());
    assert_eq!(b.get_login_public_key(), Some(expected));
}

#[test]
#[should_panic(expected = "login key already installed")]
fn install_login_key_runs_once() {
    let mut b = keyed_brain();
    Env::new(stranger()).apply();
    let _ = b.install_login_key();
}

#[test]
fn on_login_key_rejects_failures_and_non_ed25519_keys() {
    let mut b = new_brain();
    Env::new(brain_id()).result(PromiseResult::Failed).apply();
    assert!(!b.on_login_key());
    Env::new(brain_id())
        .ok(b"\"secp256k1:qMoRgcoXai4mBPsdbHi1wfyxF9TdbPCF4qSDQTRP3TfescSRoUdSx6nmeQoN3aiwGzwMyGXAb1gUjBTv5AY8DXj\"".to_vec())
        .apply();
    assert!(!b.on_login_key());
    Env::new(brain_id()).ok(b"garbage".to_vec()).apply();
    assert!(!b.on_login_key());
    assert!(b.get_login_public_key().is_none());
}

fn deleted_keys() -> Vec<String> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| r.actions)
        .filter_map(|a| match a {
            MockAction::DeleteKey { public_key, .. } => Some(public_key.to_string()),
            _ => None,
        })
        .collect()
}

const WEEK_MS: u64 = 7 * 24 * 3600 * 1000;

#[test]
fn remove_key_deletes_other_keys() {
    let mut b = keyed_brain();
    Env::new(brain_id()).apply();
    let deployer = ed25519_public_key(&[3; 32]);
    let _ = b.remove_key(deployer.clone());
    assert_eq!(deleted_keys(), vec![String::from(&deployer)]);
}

#[test]
fn login_key_install_records_when_remove_key_opens() {
    let b = keyed_brain();
    assert_eq!(b.get_status()["key_removal_open_at_ms"], (T0_MS + WEEK_MS).to_string());
    let ev = events().into_iter().find(|e| e["event"] == "login_key_installed").unwrap();
    assert_eq!(ev["data"][0]["key_removal_open_at_ms"], (T0_MS + WEEK_MS).to_string());
    assert_eq!(new_brain().get_status()["key_removal_open_at_ms"], Value::Null);
}

#[test]
fn only_the_brain_account_removes_keys_in_the_first_7_days() {
    let deployer = ed25519_public_key(&[3; 32]);
    for (who, at) in [
        (stranger(), T0_MS),
        (operator(), T0_MS + 1),
        (stranger(), T0_MS + WEEK_MS - 1),
    ] {
        let mut b = keyed_brain();
        Env::new(who.clone()).at(at).apply();
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = b.remove_key(deployer.clone());
        }));
        let err = r.expect_err("a stranger must wait 7 days");
        let msg = err.downcast_ref::<String>().cloned().unwrap_or_default();
        assert!(msg.contains("only the brain account may remove keys"), "{who} at {at}: {msg}");
        assert!(deleted_keys().is_empty());
    }
    // The brain account itself (its deployer key) may, at once.
    let mut b = keyed_brain();
    Env::new(brain_id()).at(T0_MS + 1).apply();
    let _ = b.remove_key(deployer.clone());
    assert_eq!(deleted_keys(), vec![String::from(&deployer)]);
}

#[test]
fn anyone_removes_keys_after_7_days() {
    let mut b = keyed_brain();
    Env::new(stranger()).at(T0_MS + WEEK_MS).apply();
    let deployer = ed25519_public_key(&[3; 32]);
    let _ = b.remove_key(deployer.clone());
    assert_eq!(deleted_keys(), vec![String::from(&deployer)]);
    assert!(has_event("key_removed"));
}

#[test]
#[should_panic(expected = "the login key cannot be removed")]
fn remove_key_never_removes_the_login_key() {
    let mut b = keyed_brain();
    Env::new(brain_id()).apply();
    let _ = b.remove_key(ed25519_public_key(&login_sk().verifying_key().to_bytes()));
}

#[test]
#[should_panic(expected = "the login key cannot be removed")]
fn remove_key_never_removes_the_login_key_even_after_7_days() {
    let mut b = keyed_brain();
    Env::new(stranger()).at(T0_MS + WEEK_MS).apply();
    let _ = b.remove_key(ed25519_public_key(&login_sk().verifying_key().to_bytes()));
}

#[test]
#[should_panic(expected = "install the login key first")]
fn remove_key_needs_the_login_key() {
    let mut b = new_brain();
    Env::new(brain_id()).apply();
    let _ = b.remove_key(ed25519_public_key(&[3; 32]));
}

// ------------------------------------------------------------------ signing

#[test]
fn request_login_sends_the_nep413_hash_of_the_login_message_to_the_mpc_signer() {
    let mut b = keyed_brain();
    Env::new(operator()).gas(150).apply();
    let _ = b.request_login();
    let c = call("sign");
    assert_eq!(c.receiver, "v1.signer");
    assert_eq!(c.deposit, 1);
    assert!(c.gas >= Gas::from_tgas(15));
    let req = &c.args["request"];
    assert_eq!(req["path"], "nearai-login");
    assert_eq!(req["domain_id"], 1);
    let requested = events().into_iter().find(|e| e["event"] == "signature_requested").unwrap();
    let nonce = nep413::parse_hex32(requested["data"][0]["nonce"].as_str().unwrap()).unwrap();
    let ts = u64::from_be_bytes(nonce[..8].try_into().unwrap());
    assert_eq!(ts, T0_MS - nep413::LOGIN_NONCE_SKEW_MS);
    let hash = env::sha256_array(&nep413::preimage("Sign in to NEAR AI Cloud", &nonce, "cloud.near.ai", None));
    assert_eq!(req["payload_v2"], json!({ "Eddsa": nep413::hex(&hash) }));
    let cb = call("on_signed");
    assert_eq!(cb.receiver, "brain.thechair.near");
    assert_eq!(cb.args["kind"], "login");
    assert_eq!(cb.args["message"], "Sign in to NEAR AI Cloud");
}

#[test]
fn login_nonces_differ_between_requests() {
    let mut b = keyed_brain();
    Env::new(operator()).apply();
    let _ = b.request_login();
    let first = call("on_signed").args["nonce"].clone();
    Env::new(brain_id()).result(PromiseResult::Failed).apply();
    b.on_signed(SignKind::Login, nep413::LOGIN_MESSAGE.into(), first.as_str().unwrap().into());
    Env::new(operator()).at(T0_MS + 601_000).apply();
    let _ = b.request_login();
    assert_ne!(call("on_signed").args["nonce"], first);
}

#[test]
#[should_panic(expected = "only the operator may request signatures")]
fn request_login_is_operator_only() {
    let mut b = keyed_brain();
    Env::new(stranger()).apply();
    let _ = b.request_login();
}

#[test]
#[should_panic(expected = "install the login key first")]
fn request_login_needs_the_login_key() {
    let mut b = new_brain();
    Env::new(operator()).apply();
    let _ = b.request_login();
}

#[test]
#[should_panic(expected = "attach at least 90 TGas")]
fn request_login_needs_gas() {
    let mut b = keyed_brain();
    Env::new(operator()).gas(60).apply();
    let _ = b.request_login();
}

#[test]
#[should_panic(expected = "a signature request is in flight")]
fn one_signature_request_at_a_time() {
    let mut b = keyed_brain();
    b.config.sign_cooldown_sec = 0;
    Env::new(operator()).apply();
    let _ = b.request_login();
    Env::new(operator()).at(T0_MS + 60_000).apply();
    let _ = b.request_login();
}

#[test]
#[should_panic(expected = "signature cooldown")]
fn signature_requests_respect_the_cooldown() {
    let mut b = keyed_brain();
    Env::new(operator()).apply();
    let _ = b.request_login();
    Env::new(brain_id()).result(PromiseResult::Failed).apply();
    b.on_signed(SignKind::Login, nep413::LOGIN_MESSAGE.into(), nep413::hex(&[0; 32]));
    Env::new(operator()).at(T0_MS + 599_000).apply();
    let _ = b.request_login();
}

#[test]
fn a_stuck_request_expires() {
    let mut b = keyed_brain();
    Env::new(operator()).apply();
    let _ = b.request_login();
    Env::new(operator()).at(T0_MS + STALE_MS).apply();
    let _ = b.request_login();
    assert_eq!(b.get_status()["sign_requests"], "2");
}

#[test]
fn on_signed_keeps_a_valid_signature_as_a_ready_login_body() {
    let mut b = keyed_brain();
    let sk = login_sk();
    let nonce = nep413::login_nonce(T0_MS, &[5; 32]);
    let sig = sign_hash(&sk, nep413::LOGIN_MESSAGE, &nonce);
    Env::new(brain_id()).ok(mpc_sig(&sig)).apply();
    assert!(b.on_signed(SignKind::Login, nep413::LOGIN_MESSAGE.into(), nep413::hex(&nonce)));
    let last = b.get_last_signature().unwrap();
    assert_eq!(last["kind"], "login");
    assert_eq!(last["signed_message"]["accountId"], "brain.thechair.near");
    assert_eq!(last["signed_message"]["publicKey"], json!(ed25519_public_key(&sk.verifying_key().to_bytes())));
    assert_eq!(b64(last["signed_message"]["signature"].as_str().unwrap()), sig.to_vec());
    assert_eq!(last["payload"]["message"], "Sign in to NEAR AI Cloud");
    assert_eq!(last["payload"]["recipient"], "cloud.near.ai");
    assert_eq!(last["payload"]["nonce"], json!(nonce.to_vec()));
    assert!(last["payload"].get("callbackUrl").is_none());
    assert!(has_event("login_signed"));
    assert_eq!(b.get_status()["signing"], false);
}

#[test]
fn on_signed_rejects_a_signature_from_another_key() {
    let mut b = keyed_brain();
    let nonce = [1; 32];
    let sig = sign_hash(&SigningKey::from_bytes(&[9; 32]), nep413::LOGIN_MESSAGE, &nonce);
    Env::new(brain_id()).ok(mpc_sig(&sig)).apply();
    assert!(!b.on_signed(SignKind::Login, nep413::LOGIN_MESSAGE.into(), nep413::hex(&nonce)));
    assert!(b.get_last_signature().is_none());
    assert!(has_event("signature_failed"));
}

#[test]
fn on_signed_rejects_a_signature_over_another_message() {
    let mut b = keyed_brain();
    let nonce = [1; 32];
    let sig = sign_hash(&login_sk(), "Sign in to something else", &nonce);
    Env::new(brain_id()).ok(mpc_sig(&sig)).apply();
    assert!(!b.on_signed(SignKind::Login, nep413::LOGIN_MESSAGE.into(), nep413::hex(&nonce)));
    assert!(b.get_last_signature().is_none());
}

#[test]
fn on_signed_survives_mpc_failure_and_garbage() {
    let mut b = keyed_brain();
    Env::new(operator()).apply();
    let _ = b.request_login();
    for r in [
        PromiseResult::Failed,
        PromiseResult::Successful(b"{}".to_vec()),
        PromiseResult::Successful(br#"{"scheme":"Secp256k1","big_r":{},"s":{},"recovery_id":0}"#.to_vec()),
        PromiseResult::Successful(serde_json::to_vec(&json!({"scheme":"Ed25519","signature":[1,2,3]})).unwrap()),
    ] {
        Env::new(brain_id()).result(r).apply();
        assert!(!b.on_signed(SignKind::Login, nep413::LOGIN_MESSAGE.into(), nep413::hex(&[0; 32])));
    }
    assert_eq!(b.get_status()["signing"], false);
    assert!(b.get_last_signature().is_none());
}

#[test]
fn request_binding_signs_a_valid_server_challenge() {
    let mut b = keyed_brain();
    Env::new(operator()).apply();
    let message = server_binding("brain.thechair.near", "2026-11-10 01:23:45.123456789 UTC");
    let nonce = [0x5a; 32];
    let _ = b.request_binding(message.clone(), nep413::hex(&nonce));
    let hash = env::sha256_array(&nep413::preimage(&message, &nonce, "cloud.near.ai", None));
    assert_eq!(call("sign").args["request"]["payload_v2"]["Eddsa"], nep413::hex(&hash));
    assert_eq!(call("on_signed").args["kind"], "binding");
}

#[test]
#[should_panic(expected = "not a binding message")]
fn request_binding_never_signs_arbitrary_text() {
    let mut b = keyed_brain();
    Env::new(operator()).apply();
    let _ = b.request_binding("transfer all NEAR to mallory.near".into(), nep413::hex(&[0; 32]));
}

#[test]
#[should_panic(expected = "binding names another account")]
fn request_binding_refuses_another_wallet() {
    let mut b = keyed_brain();
    Env::new(operator()).apply();
    let _ = b.request_binding(server_binding("other.near", "2026-11-10 01:23:45 UTC"), nep413::hex(&[0; 32]));
}

#[test]
#[should_panic(expected = "nonce must be 64 hex characters")]
fn request_binding_needs_a_32_byte_nonce() {
    let mut b = keyed_brain();
    Env::new(operator()).apply();
    let _ = b.request_binding(server_binding("brain.thechair.near", "2026-11-10 01:23:45 UTC"), "00".into());
}

#[test]
#[should_panic(expected = "binding is sealed")]
fn sealed_binding_stays_sealed() {
    let mut b = keyed_brain();
    Env::new(operator()).apply();
    b.seal_binding();
    let _ = b.request_binding(server_binding("brain.thechair.near", "2026-11-10 01:23:45 UTC"), nep413::hex(&[0; 32]));
}

#[test]
#[should_panic(expected = "only the operator may request signatures")]
fn a_retired_operator_can_never_sign_again() {
    let mut b = keyed_brain();
    Env::new(operator()).apply();
    b.retire_operator();
    assert_eq!(b.get_status()["operator"], Value::Null);
    let _ = b.request_login();
}

#[test]
#[should_panic(expected = "only the operator may request signatures")]
fn strangers_cannot_seal_or_retire() {
    let mut b = keyed_brain();
    Env::new(stranger()).apply();
    b.retire_operator();
}

#[test]
fn nep413_hash_view_matches_the_signing_path() {
    let b = keyed_brain();
    let nonce = [3; 32];
    let expected = nep413::hex(&env::sha256_array(&nep413::preimage("Sign in to NEAR AI Cloud", &nonce, "cloud.near.ai", None)));
    assert_eq!(b.nep413_hash("Sign in to NEAR AI Cloud".into(), nep413::hex(&nonce), "cloud.near.ai".into()), expected);
}

#[test]
fn no_method_takes_a_raw_hash() {
    // The only ways to reach the MPC `sign` call are request_login (fixed message)
    // and request_binding (template-checked). Pin that surface.
    let src = include_str!("lib.rs");
    let entry_points: Vec<&str> = src.lines().filter(|l| l.trim_start().starts_with("pub fn request_")).collect();
    assert_eq!(entry_points.len(), 2, "{entry_points:?}");
    assert_eq!(src.matches("\"sign\".to_string()").count(), 1);
}

// --------------------------------------------------------------------- farm

fn storage_cost() -> u128 {
    env::storage_byte_cost().as_yoctonear() * u128::from(env::storage_usage())
}

#[test]
fn stake_endowment_registers_storage_and_stakes_everything_above_the_reserve() {
    let mut b = new_brain();
    Env::new(stranger()).balance(5 * NEAR).apply();
    let expected = 5 * NEAR - storage_cost() - KEEP_LIQUID.as_yoctonear() - 15 * NEAR / 1000;
    let _ = b.stake_endowment();
    let receipts = get_created_receipts();
    let farm = receipts.iter().find(|r| r.receiver_id.as_str() == "stake.dao").unwrap();
    let methods: Vec<String> = farm
        .actions
        .iter()
        .filter_map(|a| match a {
            MockAction::FunctionCallWeight { method_name, .. } => Some(String::from_utf8(method_name.clone()).unwrap()),
            _ => None,
        })
        .collect();
    assert_eq!(methods, vec!["storage_deposit", "stake"], "one batch: storage and stake revert together");
    let storage = call("storage_deposit");
    assert_eq!(storage.deposit, 15 * NEAR / 1000);
    assert_eq!(storage.args, json!({ "registration_only": false }));
    let stake = call("stake");
    assert_eq!(stake.deposit, expected);
    assert!(stake.gas >= Gas::from_tgas(300), "stake.dao needs 300 TGas prepaid");
    assert_eq!(stake.args, json!({ "product_id": "prod_33Kp14MGUJa2QA", "price_id": "price_QzmSvxbZqdbV0XbG6VD6KkbB" }));
    assert_eq!(call("on_staked").args, json!({ "amount": U128(expected) }));
}

#[test]
#[should_panic(expected = "not enough endowment to stake")]
fn stake_endowment_needs_the_farm_minimum() {
    let mut b = new_brain();
    Env::new(stranger()).balance(NEAR).apply();
    let _ = b.stake_endowment();
}

#[test]
#[should_panic(expected = "attach at least 400 TGas")]
fn stake_endowment_needs_gas_for_the_farm_pipeline() {
    let mut b = new_brain();
    Env::new(stranger()).gas(300).apply();
    let _ = b.stake_endowment();
}

#[test]
#[should_panic(expected = "a farm operation is in flight")]
fn one_farm_operation_at_a_time() {
    let mut b = new_brain();
    Env::new(stranger()).balance(10 * NEAR).apply();
    let _ = b.stake_endowment();
    Env::new(stranger()).balance(10 * NEAR).at(T0_MS + 60_000).apply();
    let _ = b.stake_endowment();
}

#[test]
fn a_stuck_farm_operation_expires() {
    let mut b = new_brain();
    Env::new(stranger()).balance(10 * NEAR).apply();
    let _ = b.stake_endowment();
    Env::new(stranger()).balance(10 * NEAR).at(T0_MS + STALE_MS).apply();
    let _ = b.stake_endowment();
}

#[test]
fn on_staked_success_registers_and_syncs() {
    let mut b = new_brain();
    Env::new(stranger()).balance(5 * NEAR).apply();
    let _ = b.stake_endowment();
    let position = json!({ "account_id": "brain.thechair.near", "product_id": "prod_33Kp14MGUJa2QA", "price_id": "price_new", "shares": "1" });
    Env::new(brain_id()).ok(serde_json::to_vec(&position).unwrap()).apply();
    assert!(b.on_staked(U128(2 * NEAR)));
    let s = b.get_status();
    assert_eq!(s["farm_registered"], true);
    assert_eq!(s["farm_op"], Value::Null);
    assert_eq!(s["price_id"], "price_new");
    let sync = call("get_farm_position");
    assert_eq!(sync.receiver, "stake.dao");
    assert_eq!(sync.args, json!({ "account_id": "brain.thechair.near", "product_id": "prod_33Kp14MGUJa2QA" }));
    assert!(has_event("endowment_staked"));
    // Registered: the next stake carries no storage deposit.
    Env::new(stranger()).balance(5 * NEAR).apply();
    let _ = b.stake_endowment();
    assert!(calls().iter().all(|c| c.method != "storage_deposit"));
}

#[test]
fn on_staked_failure_keeps_the_brain_unregistered() {
    let mut b = new_brain();
    Env::new(stranger()).balance(5 * NEAR).apply();
    let _ = b.stake_endowment();
    Env::new(brain_id()).result(PromiseResult::Failed).apply();
    assert!(!b.on_staked(U128(2 * NEAR)));
    let s = b.get_status();
    assert_eq!(s["farm_registered"], false);
    assert_eq!(s["farm_op"], Value::Null);
    assert!(has_event("stake_failed"));
    assert!(calls().is_empty(), "no sync after a failed stake");
}

fn farm_view(status: &str, staked: u128) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "account_id": "brain.thechair.near",
        "product_id": "prod_33Kp14MGUJa2QA",
        "price_id": "price_QzmSvxbZqdbV0XbG6VD6KkbB",
        "validator_id": "nearai.pool.near",
        "shares": U128(staked),
        "staked_near_amount": U128(staked),
        "reward_debt": "0",
        "accrued_reward_units": "0",
        "pending_reward_units": "7",
        "total_earned_reward_units": "7",
        "status": status,
        "created_ns": "1",
        "updated_ns": "2"
    }))
    .unwrap()
}

#[test]
fn on_position_reports_the_staked_amount_to_the_token() {
    let mut b = new_brain();
    Env::new(brain_id()).ok(farm_view("Active", 49_630_000_000_000_000_000_000_000)).apply();
    assert!(b.on_position());
    let report = call("report_endowment");
    assert_eq!(report.receiver, "token.thechair.near");
    assert_eq!(report.args, json!({ "staked": "49630000000000000000000000" }));
    assert_eq!(report.deposit, 0);
    let s = b.get_status();
    assert_eq!(s["position"]["active"], true);
    assert_eq!(s["position"]["total_earned_reward_units"], "7");
    assert_eq!(s["reported"], "49630000000000000000000000");
}

#[test]
fn closed_or_missing_positions_report_zero() {
    let mut b = new_brain();
    for bytes in [farm_view("Closed", 0), b"null".to_vec()] {
        Env::new(brain_id()).ok(bytes).apply();
        assert!(b.on_position());
        assert_eq!(call("report_endowment").args, json!({ "staked": "0" }));
        assert_eq!(b.get_status()["position"]["active"], false);
    }
}

#[test]
fn unreadable_positions_are_not_reported() {
    let mut b = new_brain();
    for r in [PromiseResult::Failed, PromiseResult::Successful(b"{\"oops\":1}".to_vec())] {
        Env::new(brain_id()).result(r).apply();
        assert!(!b.on_position());
        assert!(calls().is_empty());
    }
}

#[test]
#[should_panic(expected = "attach at least 50 TGas")]
fn sync_needs_gas() {
    let mut b = new_brain();
    Env::new(stranger()).gas(30).apply();
    let _ = b.sync();
}

fn staked_brain() -> Brain {
    let mut b = new_brain();
    Env::new(brain_id()).ok(farm_view("Active", 2 * NEAR)).apply();
    assert!(b.on_position());
    b
}

#[test]
#[should_panic(expected = "no active position")]
fn retire_needs_an_active_position() {
    let mut b = new_brain();
    Env::new(stranger()).apply();
    let _ = b.retire_position();
}

#[test]
fn retire_is_refused_while_the_price_is_active() {
    let mut b = staked_brain();
    Env::new(stranger()).apply();
    let _ = b.retire_position();
    assert_eq!(call("get_price").args, json!({ "price_id": "price_QzmSvxbZqdbV0XbG6VD6KkbB" }));
    Env::new(brain_id()).ok(br#"{"price_id":"price_QzmSvxbZqdbV0XbG6VD6KkbB","status":"Active"}"#.to_vec()).apply();
    assert!(!b.on_price_for_retire("price_QzmSvxbZqdbV0XbG6VD6KkbB".into()));
    assert!(calls().is_empty(), "no unstake");
    assert_eq!(b.get_status()["farm_op"], Value::Null);
    assert_eq!(b.get_status()["price_id"], "price_QzmSvxbZqdbV0XbG6VD6KkbB");
}

#[test]
fn retire_unstakes_everything_once_the_price_is_archived_or_gone() {
    for answer in [br#"{"status":"Archived"}"#.to_vec(), b"null".to_vec()] {
        let mut b = staked_brain();
        Env::new(stranger()).apply();
        let _ = b.retire_position();
        Env::new(brain_id()).ok(answer).apply();
        assert!(b.on_price_for_retire("price_QzmSvxbZqdbV0XbG6VD6KkbB".into()));
        let unstake = call("unstake");
        assert_eq!(unstake.receiver, "stake.dao");
        assert_eq!(unstake.deposit, 1);
        assert!(unstake.gas >= Gas::from_tgas(300));
        assert_eq!(unstake.args, json!({ "product_id": "prod_33Kp14MGUJa2QA", "amount": null }));
        assert_eq!(b.get_status()["price_id"], Value::Null, "the next stake follows the active price");
    }
}

#[test]
fn retire_refuses_an_unreadable_price() {
    let mut b = staked_brain();
    Env::new(stranger()).apply();
    let _ = b.retire_position();
    Env::new(brain_id()).result(PromiseResult::Failed).apply();
    assert!(!b.on_price_for_retire("price_QzmSvxbZqdbV0XbG6VD6KkbB".into()));
    assert!(calls().is_empty());
}

#[test]
fn a_failed_unstake_restores_the_price() {
    let mut b = staked_brain();
    b.price_id = None;
    Env::new(brain_id()).result(PromiseResult::Failed).apply();
    assert!(!b.on_unstaked("price_QzmSvxbZqdbV0XbG6VD6KkbB".into()));
    assert_eq!(b.get_status()["price_id"], "price_QzmSvxbZqdbV0XbG6VD6KkbB");
    assert!(has_event("unstake_failed"));
}

#[test]
fn a_successful_unstake_syncs() {
    let mut b = staked_brain();
    Env::new(brain_id()).ok(b"".to_vec()).apply();
    assert!(b.on_unstaked("price_QzmSvxbZqdbV0XbG6VD6KkbB".into()));
    assert_eq!(call("get_farm_position").receiver, "stake.dao");
    assert!(has_event("position_retired"));
}

#[test]
fn withdraw_unstaked_claims_from_the_validator() {
    let mut b = staked_brain();
    Env::new(stranger()).apply();
    let _ = b.withdraw_unstaked();
    let w = call("withdraw");
    assert_eq!(w.receiver, "stake.dao");
    assert_eq!(w.deposit, 1);
    assert!(w.gas >= Gas::from_tgas(300));
    assert_eq!(w.args, json!({ "validator_id": "nearai.pool.near" }));
    Env::new(brain_id()).result(PromiseResult::Failed).apply();
    assert!(!b.on_withdrawn());
    assert_eq!(b.get_status()["farm_op"], Value::Null);
}

#[test]
fn deposit_endowment_only_logs() {
    let mut b = new_brain();
    Env::new(stranger()).apply();
    b.deposit_endowment();
    assert!(has_event("endowment_received"));
    assert!(calls().is_empty());
}
