//! # CHAIR token
//!
//! A memecoin that runs its own central bank (docs/SPEC.md). This contract is
//! the `token` account of SPEC §1: the NEP-141 token, the bonding-curve
//! reserve, the buyback fund and the locker reward pool. It has no keys after
//! deploy, so its code and every parameter set at `new` are permanent.
//!
//! - **Curve (§2).** `buy` / `sell` against `p(s) = p0 + k·s`; minting happens
//!   only here. Every trade pays a tax that the current levers split between
//!   the brain's endowment, the buyback fund and the locker pool.
//! - **Locks and petitions (§3).** Lock for 1, 7 or 30 days for weight
//!   `tokens × days`; lockers share the pool at each meeting and may file one
//!   petition a day (fee burned). The three heaviest reach the brief.
//! - **Constitution (§4).** `constitution.rs`: compile-time bounds, per-meeting
//!   steps, clamp, fallback rule.
//! - **Meeting (§5).** `convene` snapshots a brief, builds the model request
//!   and sends it to the OutLayer courier; `on_ruling` verifies the NEAR AI
//!   TEE signature itself, clamps, applies. `preview_ruling` runs the same
//!   checks as a view.
//! - **Trust (§9).** The owner's only power is a 48 h timelocked change of
//!   `model_signers`, `gateway_signers` and the courier version (OutLayer
//!   `project_id` + `version_key`), all public and slow (`propose_change` /
//!   `apply_change`). No pause, no withdraw, no upgrade.
//!
//! ## NEAR held by this account
//! `reserve + buyback_fund + locker_pool + locker_owed + endowment_pending`
//! plus 0.025 NEAR of storage per registered account. Anything else is the
//! account's own storage stake.

use near_sdk::json_types::{U128, U64};
use near_sdk::store::{LazyOption, LookupMap};
use near_sdk::{env, near, require, AccountId, Gas, PanicOnDefault};

pub mod constitution;
pub mod curve;
pub mod events;
mod ft;
mod locks;
mod meeting;
pub mod ruling;
mod trade;
pub mod types;
pub mod util;

#[cfg(test)]
mod tests;

pub use constitution::{Asked, Clamp, Levers};
use curve::{Curve, U256};
pub use meeting::{SEED_PLACEHOLDER, SYSTEM_PROMPT};
pub use types::*;

// ---------------------------------------------------------------- constants

pub const NAME: &str = "CHAIR";
pub const SYMBOL: &str = "CHAIR";
pub const DECIMALS: u8 = 18;
pub const ONE_TOKEN: u128 = 1_000_000_000_000_000_000;
pub const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;

pub const SEC_NS: u64 = 1_000_000_000;
pub const HOUR_NS: u64 = 3_600 * SEC_NS;
pub const DAY_NS: u64 = 24 * HOUR_NS;
/// SPEC §9: a governance change (signers, courier version) waits this long
/// after its proposal.
pub const CHANGE_TIMELOCK_NS: u64 = 48 * HOUR_NS;
pub const MIN_MEETING_INTERVAL_S: u64 = 60;
pub const MAX_MEETING_INTERVAL_S: u64 = 7 * 86_400;

pub const LOCK_DAYS: [u8; 3] = [1, 7, 30];
pub const MAX_LOCKS: usize = 8;
pub const PETITION_MAX_CHARS: usize = 280;
pub const TOP_PETITIONS: usize = 3;
/// Petitions waiting for the next meeting, heaviest at filing first. Each
/// petitioner's weight is recomputed at `convene`, so the queue holds more
/// than the brief's three; past this many, the lightest filing drops.
pub const MAX_PENDING_PETITIONS: usize = 8;

/// NEP-145 deposit per account (fixed): the account record with up to
/// `MAX_LOCKS` locks and each lock's share of the expiry buckets.
pub const STORAGE_DEPOSIT: u128 = 25_000_000_000_000_000_000_000; // 0.025 NEAR

pub const MEETING_RETENTION: u64 = 64;
pub const MAX_SIGNERS: usize = 16;
pub const MAX_TIERS: usize = 8;
pub const MAX_MODEL_LEN: usize = 128;
/// Largest courier result read; anything longer counts as unsigned.
pub const MAX_RESULT_BYTES: usize = 256 * 1024;
/// Largest `response_text` checked; anything longer is `unparseable` before
/// it is hashed or parsed, so `on_ruling` always has the gas to finish.
pub const MAX_RESPONSE_BYTES: usize = 64 * 1024;
/// The brief's `seed`: hex of the first 16 bytes of `env::random_seed()` at
/// `convene` (SPEC §5.1).
pub const SEED_BYTES: usize = 16;
/// Expired lock buckets processed per meeting (the rest wait for the next).
pub const MAX_EXPIRY_POPS: usize = 64;
/// Event copies of minutes and answers are clipped to these many bytes.
pub const MINUTES_EVENT_BYTES: usize = 1_500;
pub const ANSWER_EVENT_BYTES: usize = 400;
/// Fixed-point scale of the reward-per-weight accumulator.
pub const REWARD_SCALE: u128 = 1_000_000_000_000_000_000_000_000_000_000_000_000; // 1e36

/// Static gas for `outlayer.request_execution` (it also gets all unused gas).
pub const REQUEST_GAS: Gas = Gas::from_tgas(100);
/// `on_ruling`: parse, sha256, ecrecover, clamp, buyback search, events, transfer.
pub const ON_RULING_GAS: Gas = Gas::from_tgas(80);
pub const ON_ENDOWMENT_GAS: Gas = Gas::from_tgas(5);
/// Prepaid gas `convene` requires when a model is awake (300 TGas recommended).
pub const CONVENE_GAS: Gas = Gas::from_tgas(220);
/// Extra prepaid gas `convene` requires when it must first run the fallback
/// for a lapsed meeting (levers, locker payout, endowment transfer).
pub const LAPSE_GAS: Gas = Gas::from_tgas(20);
/// `ft_resolve_transfer`: settles the receiver's expired locks, reads and
/// writes two accounts and logs a refund event.
pub const GAS_FOR_RESOLVE_TRANSFER: Gas = Gas::from_tgas(15);
/// Gas `ft_transfer_call` keeps back from `ft_on_transfer`: its own
/// execution (25 TGas) plus `ft_resolve_transfer`.
pub const GAS_FOR_FT_TRANSFER_CALL: Gas = Gas::from_tgas(40);

// ---------------------------------------------------------------- state

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Chair {
    // fixed at `new` (except `outlayer.project_id` / `outlayer.version_key`,
    // changeable only through the 48 h timelock)
    owner: AccountId,
    brain: AccountId,
    outlayer: OutlayerConfig,
    p0: u128,
    k: u128,
    meeting_interval_ns: u64,
    petition_fee: u128,
    ladder: Vec<Tier>,

    // owner-mutable through the 48 h timelock, with the courier version above
    /// Provider (model) TEE signing addresses: 3-part signature texts.
    model_signers: Vec<[u8; 20]>,
    /// NEAR AI gateway TEE signing addresses: 2-part signature texts.
    gateway_signers: Vec<[u8; 20]>,
    /// The one proposal waiting out its timelock, if any.
    pending_change: Option<PendingChange>,

    // curve
    /// `s`: tokens sold on the curve (base units), burned ones included.
    sold: u128,
    supply: u128,
    burned: u128,
    reserve: u128,

    // funds (yoctoNEAR)
    buyback_fund: u128,
    locker_pool: u128,
    locker_owed: u128,
    endowment_pending: u128,
    endowment_sent: u128,
    endowment_reported: u128,
    endowment_reported_at: u64,

    levers: Levers,

    accounts: LookupMap<AccountId, Account>,
    holders: u64,

    // locks
    total_weight: u128,
    acc_rpw: [u8; 32],
    buckets: LookupMap<u64, Bucket>,
    popped: LookupMap<u64, Popped>,
    /// Hours with a live bucket, ascending.
    expiry: LazyOption<Vec<u64>>,

    // petitions for the next meeting: at most `MAX_PENDING_PETITIONS`,
    // heaviest at filing first; reweighed at `convene`
    petitions: LazyOption<Vec<Petition>>,
    petitions_filed: u32,

    volume: Vec<VolumeSlot>,

    // meetings
    meeting_count: u64,
    next_meeting_at: u64,
    open_meeting: Option<u64>,
    meetings: LookupMap<u64, Meeting>,
    last_request: LazyOption<String>,

    stats: Stats,
}

fn valid_model(m: &str) -> bool {
    !m.is_empty()
        && m.len() <= MAX_MODEL_LEN
        && m.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._/-".contains(&b))
}

fn hexes(v: &[[u8; 20]]) -> Vec<String> {
    v.iter().map(util::address_hex).collect()
}

/// Panics unless `project_id` is an OutLayer `owner/name` (1-128 printable
/// ASCII, no quotes or backslashes) and `version_key` a 64-hex wasm hash.
fn check_courier(project_id: &str, version_key: &str) {
    require!(
        !project_id.is_empty()
            && project_id.len() <= 128
            && project_id.bytes().all(|b| b.is_ascii_graphic() && b != b'"' && b != b'\\'),
        "bad project_id"
    );
    require!(
        version_key.len() == 64 && version_key.bytes().all(|b| b.is_ascii_hexdigit()),
        "version_key must be the 64-hex wasm hash"
    );
}

pub(crate) fn parse_signers(signers: &[String]) -> Vec<[u8; 20]> {
    require!(signers.len() <= MAX_SIGNERS, "too many signers");
    let mut out: Vec<[u8; 20]> = Vec::with_capacity(signers.len());
    for s in signers {
        let a = util::parse_address(s)
            .unwrap_or_else(|| env::panic_str("signer must be a 20-byte hex address"));
        require!(!out.contains(&a), "duplicate signer");
        out.push(a);
    }
    out
}

#[near]
impl Chair {
    /// Launch. Everything here is permanent: the token account's keys are
    /// deleted right after deploy.
    #[init]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        owner: AccountId,
        brain: AccountId,
        outlayer: OutlayerConfig,
        curve: CurveParams,
        ladder: Vec<Tier>,
        model_signers: Vec<String>,
        gateway_signers: Vec<String>,
        meeting_interval_s: u64,
        petition_fee: U128,
        levers: Option<Levers>,
    ) -> Self {
        require!(
            curve.p0.0 > 0 && curve.p0.0 <= ONE_NEAR * 1_000_000,
            "p0 must be in 1..=1e30"
        );
        require!(curve.k.0 <= ONE_NEAR * 1_000_000, "k must be <= 1e30");
        require!(
            (MIN_MEETING_INTERVAL_S..=MAX_MEETING_INTERVAL_S).contains(&meeting_interval_s),
            "meeting_interval_s must be 60..=604800"
        );
        require!(petition_fee.0 > 0, "petition_fee must be positive");
        require!(
            !ladder.is_empty() && ladder.len() <= MAX_TIERS,
            "ladder needs 1..=8 tiers"
        );
        for (i, t) in ladder.iter().enumerate() {
            require!(valid_model(&t.model), "model ids are 1-128 chars of [A-Za-z0-9._/-]");
            require!(t.min_endowment.0 > 0, "tier thresholds must be positive");
            if i > 0 {
                require!(
                    t.min_endowment.0 > ladder[i - 1].min_endowment.0,
                    "tier thresholds must increase"
                );
            }
        }
        let o = &outlayer;
        check_courier(&o.project_id, &o.version_key);
        require!(
            o.max_instructions.0 > 0 && o.max_instructions.0 <= 500_000_000_000,
            "max_instructions must be 1..=5e11"
        );
        require!(
            (1..=4_096).contains(&o.max_memory_mb),
            "max_memory_mb must be 1..=4096"
        );
        require!(
            (1..=180).contains(&o.max_execution_seconds),
            "max_execution_seconds must be 1..=180"
        );
        require!(
            o.secrets_profile.is_some() == o.secrets_owner.is_some(),
            "secrets_profile and secrets_owner go together"
        );
        let levers = levers.unwrap_or(constitution::DEFAULT_LEVERS);
        require!(levers.within_constitution(), "levers outside the constitution");
        let model_signers = parse_signers(&model_signers);
        let gateway_signers = parse_signers(&gateway_signers);
        let now = env::block_timestamp();
        Self {
            owner,
            brain,
            outlayer,
            p0: curve.p0.0,
            k: curve.k.0,
            meeting_interval_ns: meeting_interval_s * SEC_NS,
            petition_fee: petition_fee.0,
            ladder,
            model_signers,
            gateway_signers,
            pending_change: None,
            sold: 0,
            supply: 0,
            burned: 0,
            reserve: 0,
            buyback_fund: 0,
            locker_pool: 0,
            locker_owed: 0,
            endowment_pending: 0,
            endowment_sent: 0,
            endowment_reported: 0,
            endowment_reported_at: 0,
            levers,
            accounts: LookupMap::new(b"a"),
            holders: 0,
            total_weight: 0,
            acc_rpw: [0u8; 32],
            buckets: LookupMap::new(b"b"),
            popped: LookupMap::new(b"p"),
            expiry: LazyOption::new(b"x", Some(Vec::new())),
            petitions: LazyOption::new(b"q", Some(Vec::new())),
            petitions_filed: 0,
            volume: vec![VolumeSlot::default(); 24],
            meeting_count: 0,
            next_meeting_at: now + meeting_interval_s * SEC_NS,
            open_meeting: None,
            meetings: LookupMap::new(b"m"),
            last_request: LazyOption::new(b"r", None),
            stats: Stats::default(),
        }
    }

    // ------------------------------------------------------------ views

    pub fn get_curve(&self) -> CurveView {
        let c = self.curve();
        CurveView {
            p0: U128(self.p0),
            k: U128(self.k),
            sold: U128(self.sold),
            supply: U128(self.supply),
            burned: U128(self.burned),
            reserve: U128(self.reserve),
            integral: U128(c.reserve_for(self.sold).unwrap_or(u128::MAX)),
            price: U128(c.price(self.sold)),
            floor_price: U128(c.price(self.burned)),
            locked_reserve: U128(c.reserve_for(self.burned).unwrap_or(u128::MAX)),
        }
    }

    pub fn get_levers(&self) -> LeversView {
        self.levers.into()
    }

    pub fn get_funds(&self) -> FundsView {
        FundsView {
            reserve: U128(self.reserve),
            buyback_fund: U128(self.buyback_fund),
            locker_pool: U128(self.locker_pool),
            locker_owed: U128(self.locker_owed),
            endowment_pending: U128(self.endowment_pending),
            endowment_sent: U128(self.endowment_sent),
            endowment_reported: U128(self.endowment_reported),
            endowment_reported_at: U64(self.endowment_reported_at),
        }
    }

    pub fn get_constitution(&self) -> ConstitutionView {
        ConstitutionView {
            rules: constitution::rules(),
            meeting_interval_s: self.meeting_interval_ns / SEC_NS,
            ladder: self.ladder.clone(),
            lock_days: LOCK_DAYS.to_vec(),
            max_locks_per_account: MAX_LOCKS as u32,
            petition_fee: U128(self.petition_fee),
            petition_max_chars: PETITION_MAX_CHARS as u32,
            petitions_in_brief: TOP_PETITIONS as u32,
            change_timelock_s: CHANGE_TIMELOCK_NS / SEC_NS,
            owner: self.owner.clone(),
            brain: self.brain.clone(),
            outlayer: self.outlayer.clone(),
            curve: CurveParams {
                p0: U128(self.p0),
                k: U128(self.k),
            },
            system_prompt: SYSTEM_PROMPT.to_string(),
        }
    }

    pub fn get_status(&self) -> StatusView {
        StatusView {
            meeting_count: self.meeting_count,
            next_meeting_at: U64(self.next_meeting_at),
            open_meeting: self.open_meeting,
            model: self.model_for(self.endowment_reported),
            levers: self.levers.into(),
            petitions_filed: self.petitions_filed,
            total_weight: U128(self.total_weight),
            holders: self.holders,
        }
    }

    pub fn get_stats(&self) -> Stats {
        self.stats.clone()
    }

    /// The petitions queued for the next meeting, with their weight at
    /// filing. `convene` recomputes each weight from the locks still active
    /// then; `get_request_preview` shows the brief that would result now.
    pub fn get_petitions(&self) -> Vec<Petition> {
        self.pending_petitions().to_vec()
    }

    /// Everything `propose_change` can touch: the signer allowlists and the
    /// courier version, the pending proposal and the timelock.
    pub fn get_governance(&self) -> GovernanceView {
        GovernanceView {
            owner: self.owner.clone(),
            model_signers: hexes(&self.model_signers),
            gateway_signers: hexes(&self.gateway_signers),
            courier: self.courier(),
            pending: self.pending_change.as_ref().map(change_view),
            timelock_s: CHANGE_TIMELOCK_NS / SEC_NS,
        }
    }

    // ------------------------------------------------------------ governance (SPEC §9)

    /// Owner only. Proposes new values for any of `model_signers` (provider
    /// TEE addresses), `gateway_signers` (gateway TEE addresses) and
    /// `courier` (the OutLayer `project_id` and pinned `version_key` the
    /// meetings run on). An omitted field keeps its value; a given signer
    /// list replaces the whole list. Nothing else is changeable.
    ///
    /// One proposal is pending at a time: a new one replaces it and restarts
    /// the 48 h clock. Anyone may `apply_change` once the clock has run out.
    pub fn propose_change(
        &mut self,
        model_signers: Option<Vec<String>>,
        gateway_signers: Option<Vec<String>>,
        courier: Option<CourierVersion>,
    ) -> PendingChangeView {
        require!(
            env::predecessor_account_id() == self.owner,
            "only the owner proposes changes"
        );
        require!(
            model_signers.is_some() || gateway_signers.is_some() || courier.is_some(),
            "propose at least one of model_signers, gateway_signers, courier"
        );
        let model_signers = model_signers.as_deref().map(parse_signers);
        let gateway_signers = gateway_signers.as_deref().map(parse_signers);
        if let Some(c) = &courier {
            check_courier(&c.project_id, &c.version_key);
        }
        let now = env::block_timestamp();
        let change = PendingChange {
            model_signers,
            gateway_signers,
            courier,
            proposed_at: now,
            eta: now + CHANGE_TIMELOCK_NS,
        };
        let view = change_view(&change);
        events::emit(
            "change_proposed",
            &near_sdk::serde_json::json!({
                "model_signers": view.model_signers,
                "gateway_signers": view.gateway_signers,
                "courier": view.courier,
                "proposed_at": view.proposed_at,
                "eta": view.eta,
                "current": self.governed(),
                "replaced": self.pending_change.as_ref().map(change_view),
            }),
        );
        self.pending_change = Some(change);
        view
    }

    /// Anyone, once the timelock has passed: applies the pending proposal,
    /// only the fields it names.
    pub fn apply_change(&mut self) -> GovernanceView {
        let eta = self
            .pending_change
            .as_ref()
            .map(|p| p.eta)
            .unwrap_or_else(|| env::panic_str("no pending change"));
        require!(env::block_timestamp() >= eta, "timelock has not passed");
        let p = self.pending_change.take().unwrap_or_else(|| env::abort());
        let applied = change_view(&p);
        let previous = self.governed();
        if let Some(m) = p.model_signers {
            self.model_signers = m;
        }
        if let Some(g) = p.gateway_signers {
            self.gateway_signers = g;
        }
        if let Some(c) = p.courier {
            self.outlayer.project_id = c.project_id;
            self.outlayer.version_key = c.version_key;
        }
        events::emit(
            "change_applied",
            &near_sdk::serde_json::json!({
                "model_signers": applied.model_signers,
                "gateway_signers": applied.gateway_signers,
                "courier": applied.courier,
                "proposed_at": applied.proposed_at,
                "previous": previous,
            }),
        );
        self.get_governance()
    }
}

fn change_view(p: &PendingChange) -> PendingChangeView {
    PendingChangeView {
        model_signers: p.model_signers.as_deref().map(hexes),
        gateway_signers: p.gateway_signers.as_deref().map(hexes),
        courier: p.courier.clone(),
        proposed_at: U64(p.proposed_at),
        eta: U64(p.eta),
    }
}

// ---------------------------------------------------------------- internals

impl Chair {
    pub(crate) fn curve(&self) -> Curve {
        Curve {
            p0: self.p0,
            k: self.k,
        }
    }

    /// The courier version meetings run on now.
    pub(crate) fn courier(&self) -> CourierVersion {
        CourierVersion {
            project_id: self.outlayer.project_id.clone(),
            version_key: self.outlayer.version_key.clone(),
        }
    }

    /// The current values of everything `propose_change` can touch (events).
    fn governed(&self) -> near_sdk::serde_json::Value {
        near_sdk::serde_json::json!({
            "model_signers": hexes(&self.model_signers),
            "gateway_signers": hexes(&self.gateway_signers),
            "courier": self.courier(),
        })
    }

    pub(crate) fn acc(&self) -> U256 {
        U256::from_big_endian(&self.acc_rpw)
    }

    pub(crate) fn pending_petitions(&self) -> &[Petition] {
        self.petitions.get().as_deref().unwrap_or(&[])
    }

    /// The IQ ladder: the highest tier the endowment reaches; `None` = asleep.
    pub(crate) fn model_for(&self, endowment: u128) -> Option<String> {
        self.ladder
            .iter()
            .rev()
            .find(|t| endowment >= t.min_endowment.0)
            .map(|t| t.model.clone())
    }

    pub(crate) fn account_or_panic(&self, id: &AccountId) -> Account {
        self.accounts
            .get(id)
            .cloned()
            .unwrap_or_else(|| env::panic_str(&format!("{id} is not registered")))
    }

    pub(crate) fn register(&mut self, id: &AccountId) {
        self.accounts.insert(id.clone(), Account::default());
        self.holders += 1;
    }

    /// Splits a tax amount by the current levers into the three funds.
    pub(crate) fn collect_tax(&mut self, tax: u128) {
        let (e, l, b) = self.levers.split(tax);
        self.endowment_pending += e;
        self.locker_pool += l;
        self.buyback_fund += b;
        self.stats.tax_collected.0 += tax;
    }

    pub(crate) fn record_volume(&mut self, buy: u128, sell: u128) {
        let hour = env::block_timestamp() / HOUR_NS;
        let slot = &mut self.volume[(hour % 24) as usize];
        if slot.hour != hour {
            *slot = VolumeSlot {
                hour,
                buy: 0,
                sell: 0,
            };
        }
        slot.buy += buy;
        slot.sell += sell;
    }

    /// Buy and sell volume of the last 24 hours (the current hour included).
    pub(crate) fn volume_24h(&self) -> (u128, u128) {
        let hour = env::block_timestamp() / HOUR_NS;
        self.volume
            .iter()
            .filter(|s| s.hour + 24 > hour && s.hour <= hour)
            .fold((0, 0), |(b, s), v| (b + v.buy, s + v.sell))
    }
}
