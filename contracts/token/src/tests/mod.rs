//! Unit tests. Rulings are signed with a real secp256k1 key (k256) under
//! EIP-191 and delivered through mocked promise results, the way OutLayer
//! resumes the yield.

use super::*;
use k256::ecdsa::SigningKey;
use near_sdk::mock::MockAction;
use near_sdk::serde_json::{self as sj, json, Value};
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, test_vm_config, NearToken, PromiseOrValue, PromiseResult, RuntimeFeesConfig};
use sha2::{Digest as _, Sha256};
use sha3::Keccak256;

mod audit_findings;
mod constitution_tests;
mod curve_tests;
mod fuzz;
mod locks_tests;
mod meeting_tests;
mod token_tests;

pub const T0: u64 = 1_794_225_600_000_000_000;
pub const INTERVAL_S: u64 = 300;
pub const P0: u128 = 1_000_000_000_000_000_000; // 1e-6 NEAR per CHAIR
pub const K: u128 = 1_000_000_000_000; // +1e-12 NEAR per CHAIR per CHAIR sold
pub const FEE: u128 = 1_000 * ONE_TOKEN;
pub const OUTLAYER_DEPOSIT: u128 = 10_000_000_000_000_000_000_000; // 0.01 NEAR
pub const VERSION_KEY: &str = "36f855f658b9b0dbcf0781b503536443a290663df5669eaecd495954e5e30270";
pub const GLM: &str = "z-ai/glm-5.3-flash";
pub const DEEPSEEK: &str = "deepseek-ai/DeepSeek-V4.1-Flash-1017";
pub const KIMI: &str = "moonshotai/kimi-k3";

pub fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
pub fn token() -> AccountId {
    acc("token.chair.near")
}
pub fn owner() -> AccountId {
    acc("owner.chair.near")
}
pub fn brain() -> AccountId {
    acc("brain.chair.near")
}
pub fn outlayer() -> AccountId {
    acc("outlayer.near")
}
pub fn alice() -> AccountId {
    acc("alice.near")
}
pub fn bob() -> AccountId {
    acc("bob.near")
}
pub fn carol() -> AccountId {
    acc("carol.near")
}
pub fn cranker() -> AccountId {
    acc("crank.near")
}
pub fn near(n: u128) -> u128 {
    n * ONE_NEAR
}
pub fn milli(n: u128) -> u128 {
    n * ONE_NEAR / 1_000
}
pub fn tokens(n: u128) -> u128 {
    n * ONE_TOKEN
}

// ---------------------------------------------------------------- keys

pub fn model_sk() -> SigningKey {
    SigningKey::from_bytes(&[7u8; 32].into()).unwrap()
}
pub fn other_sk() -> SigningKey {
    SigningKey::from_bytes(&[9u8; 32].into()).unwrap()
}
/// The NEAR AI gateway TEE key (in `gateway_signers`).
pub fn gateway_sk() -> SigningKey {
    SigningKey::from_bytes(&[11u8; 32].into()).unwrap()
}

pub fn keccak(b: &[u8]) -> [u8; 32] {
    Keccak256::digest(b).into()
}
pub fn sha256(b: &[u8]) -> [u8; 32] {
    Sha256::digest(b).into()
}
pub fn hexs(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn address(sk: &SigningKey) -> [u8; 20] {
    let pt = sk.verifying_key().to_encoded_point(false);
    let h = keccak(&pt.as_bytes()[1..]);
    h[12..].try_into().unwrap()
}
pub fn address_str(sk: &SigningKey) -> String {
    format!("0x{}", hexs(&address(sk)))
}

/// EIP-191 personal_sign, `0x` + r ‖ s ‖ v with v ∈ {27, 28}.
pub fn eth_sign(sk: &SigningKey, text: &str) -> String {
    let mut msg = format!("\x19Ethereum Signed Message:\n{}", text.len()).into_bytes();
    msg.extend_from_slice(text.as_bytes());
    let (sig, rec) = sk.sign_prehash_recoverable(&keccak(&msg)).unwrap();
    let mut out = sig.to_bytes().to_vec();
    out.push(rec.to_byte() + 27);
    format!("0x{}", hexs(&out))
}

// ---------------------------------------------------------------- model output

pub fn chat_response(model: &str, content: &str) -> String {
    json!({
        "id": "chatcmpl-test",
        "object": "chat.completion",
        "created": 1_794_225_600u64,
        "model": model,
        "choices": [{
            "index": 0,
            "message": { "role": "assistant", "content": content },
            "finish_reason": "stop"
        }],
        "usage": { "prompt_tokens": 900, "completion_tokens": 120, "total_tokens": 1020 }
    })
    .to_string()
}

pub fn ruling_json(t: i64, e: i64, l: i64, b: i64, answers: &[&str]) -> String {
    json!({
        "tax_bps": t,
        "endowment_share": e,
        "locker_share": l,
        "buyback_burn": b,
        "minutes": "Volume is thin; holding steady.",
        "answers": answers,
    })
    .to_string()
}

pub fn courier(response_text: &str, signature_text: &str, signature: &str) -> Vec<u8> {
    json!({
        "response_text": response_text,
        "signature_text": signature_text,
        "signature": signature,
    })
    .to_string()
    .into_bytes()
}

// ---------------------------------------------------------------- receipts

pub struct Call {
    pub receiver: String,
    pub method: String,
    pub args: Vec<u8>,
    pub deposit: u128,
}

pub fn calls() -> Vec<Call> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let receiver = r.receiver_id.to_string();
            r.actions.into_iter().filter_map(move |a| match a {
                MockAction::FunctionCallWeight {
                    method_name,
                    args,
                    attached_deposit,
                    ..
                } => Some(Call {
                    receiver: receiver.clone(),
                    method: String::from_utf8(method_name).unwrap(),
                    args,
                    deposit: attached_deposit.as_yoctonear(),
                }),
                _ => None,
            })
        })
        .collect()
}

pub fn transfers() -> Vec<(String, u128)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let receiver = r.receiver_id.to_string();
            r.actions.into_iter().filter_map(move |a| match a {
                MockAction::Transfer { deposit, .. } => Some((receiver.clone(), deposit.as_yoctonear())),
                _ => None,
            })
        })
        .collect()
}

/// `(event, data[0])` of every `chair` / `nep141` event logged.
pub fn events() -> Vec<(String, Value)> {
    get_logs()
        .into_iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:").map(str::to_string))
        .map(|j| {
            let v: Value = sj::from_str(&j).unwrap();
            (v["event"].as_str().unwrap().to_string(), v["data"][0].clone())
        })
        .collect()
}

pub fn event(name: &str) -> Option<Value> {
    events().into_iter().find(|(e, _)| e == name).map(|(_, d)| d)
}

// ---------------------------------------------------------------- harness

pub fn outlayer_config() -> OutlayerConfig {
    OutlayerConfig {
        account: outlayer(),
        project_id: "chair.near/courier".into(),
        version_key: VERSION_KEY.into(),
        secrets_profile: Some("default".into()),
        secrets_owner: Some(acc("chair.near")),
        deposit: U128(OUTLAYER_DEPOSIT),
        max_instructions: U64(10_000_000_000),
        max_memory_mb: 128,
        max_execution_seconds: 120,
    }
}

pub fn ladder() -> Vec<Tier> {
    vec![
        Tier {
            min_endowment: U128(near(1)),
            model: GLM.into(),
        },
        Tier {
            min_endowment: U128(near(50)),
            model: DEEPSEEK.into(),
        },
        Tier {
            min_endowment: U128(near(500)),
            model: KIMI.into(),
        },
    ]
}

pub struct H {
    pub c: Chair,
    pub now: u64,
}

/// The block random seed the harness uses at time `now` (each block its own).
pub fn seed_at(now: u64) -> [u8; 32] {
    sha256(&now.to_le_bytes())
}

pub fn ctx(pred: &AccountId, deposit: u128, now: u64) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(token())
        .random_seed(seed_at(now))
        .predecessor_account_id(pred.clone())
        .signer_account_id(pred.clone())
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .prepaid_gas(Gas::from_tgas(300))
        .block_timestamp(now)
        .account_balance(NearToken::from_near(10_000));
    b
}

impl H {
    pub fn with_levers(levers: Option<Levers>) -> Self {
        // A fresh chain: drop whatever an earlier contract in this thread stored.
        near_sdk::mock::with_mocked_blockchain(|b| {
            b.take_storage();
        });
        testing_env!(ctx(&owner(), 0, T0).build());
        let c = Chair::new(
            owner(),
            brain(),
            outlayer_config(),
            CurveParams {
                p0: U128(P0),
                k: U128(K),
            },
            ladder(),
            vec![address_str(&model_sk())],
            vec![address_str(&gateway_sk())],
            INTERVAL_S,
            U128(FEE),
            levers,
        );
        H { c, now: T0 }
    }

    pub fn new() -> Self {
        Self::with_levers(None)
    }

    /// Calls as `who` with `deposit` attached at the current time.
    pub fn as_(&self, who: &AccountId, deposit: u128) {
        testing_env!(ctx(who, deposit, self.now).build());
    }

    pub fn advance(&mut self, ns: u64) {
        self.now += ns;
    }

    pub fn buy(&mut self, who: &AccountId, deposit: u128) -> BuyResult {
        self.as_(who, deposit);
        self.c.buy(U128(0))
    }

    pub fn sell(&mut self, who: &AccountId, amount: u128) -> SellResult {
        self.as_(who, 1);
        self.c.sell(U128(amount), U128(0))
    }

    pub fn lock(&mut self, who: &AccountId, amount: u128, days: u8) -> LockView {
        self.as_(who, 1);
        self.c.lock(U128(amount), days)
    }

    pub fn petition(&mut self, who: &AccountId, text: &str) -> Petition {
        self.as_(who, 1);
        self.c.petition(text.to_string())
    }

    pub fn report(&mut self, amount: u128) {
        self.as_(&brain(), 0);
        self.c.report_endowment(U128(amount));
    }

    pub fn balance(&self, who: &AccountId) -> u128 {
        self.c.ft_balance_of(who.clone()).0
    }

    /// Moves to the next allowed meeting time and convenes with the OutLayer deposit.
    pub fn convene(&mut self) -> PromiseOrValue<Option<Meeting>> {
        self.now = self.now.max(self.c.next_meeting_at);
        self.as_(&cranker(), OUTLAYER_DEPOSIT);
        self.c.convene()
    }

    /// Convenes an awake meeting and returns its number.
    pub fn convene_awake(&mut self) -> u64 {
        if self.c.endowment_reported < near(1) {
            self.report(near(10));
        }
        match self.convene() {
            PromiseOrValue::Promise(_) => self.c.meeting_count,
            PromiseOrValue::Value(_) => panic!("expected an awake meeting"),
        }
    }

    pub fn deliver(&mut self, meeting: u64, result: PromiseResult) -> Option<Meeting> {
        testing_env!(
            ctx(&token(), 0, self.now).build(),
            test_vm_config(),
            RuntimeFeesConfig::test(),
            Default::default(),
            vec![result]
        );
        self.c.on_ruling(meeting)
    }

    pub fn meeting(&self, n: u64) -> Meeting {
        self.c.meetings.get(&n).cloned().unwrap()
    }

    /// A courier result for meeting `n`: `content` as the model's message,
    /// signed by `sk` over the correct signature text.
    pub fn signed(&self, n: u64, content: &str, sk: &SigningKey) -> (String, String, String) {
        let m = self.meeting(n);
        let model = m.model.unwrap();
        let resp = chat_response(&model, content);
        let text = format!(
            "{model}:{}:{}",
            m.request_sha256.unwrap(),
            hexs(&sha256(resp.as_bytes()))
        );
        let sig = eth_sign(sk, &text);
        (resp, text, sig)
    }

    /// Like `signed`, but the gateway form: `sha256(request):sha256(response)`.
    pub fn signed_gateway(&self, n: u64, content: &str, sk: &SigningKey) -> (String, String, String) {
        let m = self.meeting(n);
        let resp = chat_response(m.model.as_deref().unwrap(), content);
        let text = format!(
            "{}:{}",
            m.request_sha256.unwrap(),
            hexs(&sha256(resp.as_bytes()))
        );
        let sig = eth_sign(sk, &text);
        (resp, text, sig)
    }

    pub fn deliver_signed(&mut self, n: u64, content: &str) -> Meeting {
        let (r, t, s) = self.signed(n, content, &model_sk());
        self.deliver(n, PromiseResult::Successful(courier(&r, &t, &s)))
            .unwrap()
    }

    pub fn outcome(&self, n: u64) -> Outcome {
        self.meeting(n).outcome.unwrap()
    }
}

/// Deterministic xorshift64* PRNG for property and fuzz loops.
pub struct Rng(pub u64);

impl Rng {
    pub fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
    /// Uniform in `0..n` (n > 0).
    pub fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    pub fn range(&mut self, lo: i64, hi: i64) -> i64 {
        lo + self.below((hi - lo + 1) as u64) as i64
    }
    pub fn chance(&mut self, pct: u64) -> bool {
        self.below(100) < pct
    }
    /// Log-uniform u128 in roughly `[1, 2^bits)`.
    pub fn log_u128(&mut self, bits: u32) -> u128 {
        let b = 1 + self.below(bits as u64) as u32;
        let v = ((self.next() as u128) << 64) | self.next() as u128;
        if b >= 128 {
            v
        } else {
            (v % (1u128 << b)).max(1)
        }
    }
}

pub fn expect_panic<F: FnOnce()>(f: F, needle: &str) {
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
    let err = r.expect_err("expected a panic");
    let msg = err
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default();
    assert!(msg.contains(needle), "panic {msg:?} does not contain {needle:?}");
}
