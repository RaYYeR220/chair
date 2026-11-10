//! State records and view types.

use near_sdk::json_types::{U128, U64};
use near_sdk::{near, AccountId};

use crate::constitution::{Asked, Clamp, Levers, Rules};

// ---------------------------------------------------------------- config (fixed at `new`)

/// Where and how meetings run on OutLayer.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutlayerConfig {
    /// The OutLayer contract (`outlayer.near` / `outlayer.testnet`).
    pub account: AccountId,
    /// The courier project, `owner/name`.
    pub project_id: String,
    /// Pinned project version (64-hex wasm hash). `project_id` and
    /// `version_key` change only through the 48 h timelock.
    pub version_key: String,
    /// OutLayer secrets holding the NEAR AI API key (`secrets_ref`), if any.
    pub secrets_profile: Option<String>,
    pub secrets_owner: Option<AccountId>,
    /// Minimum deposit `convene` must attach (OutLayer refunds the unused
    /// part to the caller).
    pub deposit: U128,
    pub max_instructions: U64,
    pub max_memory_mb: u32,
    pub max_execution_seconds: u32,
}

/// `p(s) = p0 + k·s/10^18`, in yoctoNEAR per CHAIR.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CurveParams {
    pub p0: U128,
    pub k: U128,
}

/// One rung of the IQ ladder (SPEC §7).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tier {
    /// Endowment (yoctoNEAR, as reported by the brain) from which this model runs.
    pub min_endowment: U128,
    pub model: String,
}

// ---------------------------------------------------------------- accounts and locks

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Lock {
    pub id: u32,
    pub amount: u128,
    pub days: u8,
    /// `amount × days`.
    pub weight: u128,
    pub start: u64,
    pub unlock_at: u64,
    /// Hour index whose end (`bucket × 1 h`) first follows `unlock_at`; the
    /// lock's weight leaves the reward denominator when that bucket expires.
    pub bucket: u64,
    /// Reward-per-weight accumulator at the last settlement (U256, big endian).
    pub acc_start: [u8; 32],
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Account {
    pub balance: u128,
    /// Settled locker rewards, yoctoNEAR, not yet claimed.
    pub claimable: u128,
    /// Last petition time (ns), 0 if never.
    pub last_petition_at: u64,
    pub next_lock_id: u32,
    pub locks: Vec<Lock>,
}

/// Locks that expire in one hour bucket, still in the reward denominator.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Bucket {
    pub weight: u128,
    pub locks: u32,
}

/// An expired bucket: the accumulator its locks stopped at, kept until the
/// last of them is settled and removed.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Popped {
    pub acc: [u8; 32],
    pub locks: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Petition {
    pub account: AccountId,
    /// The petitioner's active lock weight (base units × days) when filed.
    pub weight: U128,
    pub text: String,
    pub filed_at: U64,
}

/// One hour of trade volume (curve NEAR, before tax).
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct VolumeSlot {
    pub hour: u64,
    pub buy: u128,
    pub sell: u128,
}

/// The courier the meetings run on: OutLayer project and pinned version.
/// Changeable only through the 48 h timelock (`propose_change`).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CourierVersion {
    /// `owner/name`.
    pub project_id: String,
    /// 64-hex wasm hash.
    pub version_key: String,
}

/// A proposed governance change waiting out its timelock. `None` fields
/// stay as they are when it is applied.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingChange {
    pub model_signers: Option<Vec<[u8; 20]>>,
    pub gateway_signers: Option<Vec<[u8; 20]>>,
    pub courier: Option<CourierVersion>,
    pub proposed_at: u64,
    pub eta: u64,
}

// ---------------------------------------------------------------- meetings

#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MeetingStatus {
    /// Sent to OutLayer, waiting for the ruling.
    Requested,
    /// Decided: a ruling or the fallback rule was applied.
    Held,
    /// No result arrived before the next meeting was convened; nothing applied.
    Lapsed,
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutcomeKind {
    Ruling,
    Fallback,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outcome {
    pub kind: OutcomeKind,
    /// Why the fallback ran: `unsigned`, `bad_hash`, `bad_signature`, `unparseable`, `asleep`.
    pub reason: Option<String>,
    pub signer: Option<String>,
    /// `provider_tee` (model TEE, 3-part text) or `gateway` (gateway TEE, 2-part text).
    pub signed_by: Option<String>,
    pub response_sha256: Option<String>,
    pub minutes_sha256: Option<String>,
    pub asked: Option<Asked>,
    pub levers: Levers,
    pub clamps: Vec<Clamp>,
    /// Buyback-and-burn actually executed, in bps of supply (floor).
    pub buyback_bps: u16,
    pub buyback_tokens: U128,
    pub buyback_near: U128,
    /// Locker pool distributed at this meeting.
    pub locker_paid: U128,
    /// Endowment NEAR sent to the brain at this meeting.
    pub endowment_sent: U128,
    pub held_at: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Meeting {
    pub number: u64,
    pub convener: AccountId,
    pub convened_at: U64,
    /// `None` when the brain was asleep (no model asked).
    pub model: Option<String>,
    /// Hex sha256 of the exact request bytes sent to the model.
    pub request_sha256: Option<String>,
    pub deposit: U128,
    pub levers_before: Levers,
    /// Petitions in the brief; the ruling must answer each.
    pub petitions: u8,
    pub status: MeetingStatus,
    pub outcome: Option<Outcome>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Stats {
    pub buys: u64,
    pub sells: u64,
    pub volume_buy: U128,
    pub volume_sell: U128,
    pub tax_collected: U128,
    pub petitions: u64,
    pub petition_fees_burned: U128,
    pub buyback_tokens_burned: U128,
    pub buyback_near_spent: U128,
    pub locker_rewards_paid: U128,
    pub rulings: u64,
    pub fallbacks: u64,
    pub lapsed: u64,
}

// ---------------------------------------------------------------- views

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CurveView {
    pub p0: U128,
    pub k: U128,
    /// `s`: tokens sold on the curve and not sold back (includes burned).
    pub sold: U128,
    pub supply: U128,
    /// `s − supply`: tokens burned by buybacks, petition fees and forced unregisters.
    pub burned: U128,
    pub reserve: U128,
    /// `ceil(∫₀ˢ p)`; the reserve never holds less.
    pub integral: U128,
    /// Spot price `p(s)`, yoctoNEAR per CHAIR.
    pub price: U128,
    /// `p(burned)`: the lowest price selling every token in existence can reach.
    pub floor_price: U128,
    /// NEAR that stays in the reserve after every holder sells (`R(burned)`).
    pub locked_reserve: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BuyQuote {
    pub tokens: U128,
    pub cost: U128,
    pub tax: U128,
    /// Storage deposit taken first when the buyer is not registered.
    pub storage: U128,
    pub refund: U128,
    pub price_after: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SellQuote {
    pub gross: U128,
    pub tax: U128,
    pub near_out: U128,
    pub price_after: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LeversView {
    pub tax_bps: u16,
    pub endowment_share: u8,
    pub locker_share: u8,
    pub buyback_share: u8,
}

impl From<Levers> for LeversView {
    fn from(l: Levers) -> Self {
        LeversView {
            tax_bps: l.tax_bps,
            endowment_share: l.endowment_share,
            locker_share: l.locker_share,
            buyback_share: l.buyback_share(),
        }
    }
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FundsView {
    pub reserve: U128,
    pub buyback_fund: U128,
    /// Locker rewards waiting for the next meeting.
    pub locker_pool: U128,
    /// Locker rewards distributed and not yet claimed.
    pub locker_owed: U128,
    /// Endowment share of tax waiting for the next meeting.
    pub endowment_pending: U128,
    pub endowment_sent: U128,
    pub endowment_reported: U128,
    pub endowment_reported_at: U64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LockView {
    pub id: u32,
    pub amount: U128,
    pub days: u8,
    pub weight: U128,
    pub start: U64,
    pub unlock_at: U64,
    pub active: bool,
    pub pending_reward: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountView {
    pub account_id: AccountId,
    pub balance: U128,
    pub locked: U128,
    pub transferable: U128,
    pub active_weight: U128,
    pub claimable: U128,
    /// `claimable` plus every lock's pending reward.
    pub rewards: U128,
    pub last_petition_at: U64,
    pub locks: Vec<LockView>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StatusView {
    pub meeting_count: u64,
    pub next_meeting_at: U64,
    pub open_meeting: Option<u64>,
    /// Model the next meeting would ask (`None` = asleep).
    pub model: Option<String>,
    pub levers: LeversView,
    pub petitions_filed: u32,
    pub total_weight: U128,
    pub holders: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingChangeView {
    /// `None`: unchanged.
    pub model_signers: Option<Vec<String>>,
    pub gateway_signers: Option<Vec<String>>,
    pub courier: Option<CourierVersion>,
    pub proposed_at: U64,
    /// `apply_change` is allowed from this time (ns).
    pub eta: U64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GovernanceView {
    pub owner: AccountId,
    pub model_signers: Vec<String>,
    pub gateway_signers: Vec<String>,
    pub courier: CourierVersion,
    pub pending: Option<PendingChangeView>,
    pub timelock_s: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConstitutionView {
    pub rules: Rules,
    pub meeting_interval_s: u64,
    pub ladder: Vec<Tier>,
    pub lock_days: Vec<u8>,
    pub max_locks_per_account: u32,
    pub petition_fee: U128,
    pub petition_max_chars: u32,
    pub petitions_in_brief: u32,
    /// Delay between `propose_change` and `apply_change`.
    pub change_timelock_s: u64,
    pub owner: AccountId,
    pub brain: AccountId,
    pub outlayer: OutlayerConfig,
    pub curve: CurveParams,
    pub system_prompt: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RequestPreview {
    pub meeting: u64,
    pub model: Option<String>,
    pub request: Option<String>,
    pub request_sha256: Option<String>,
}

/// What `on_ruling` would execute for a given courier result.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RulingPreview {
    pub meeting: u64,
    pub valid: bool,
    /// Failure reason when `valid` is false (the fallback rule would run).
    pub reason: Option<String>,
    /// What a provider (model) TEE must sign for this response.
    pub expected_signature_text: Option<String>,
    /// What the gateway TEE must sign for this response.
    pub expected_gateway_text: Option<String>,
    pub signer: Option<String>,
    pub signed_by: Option<String>,
    pub asked: Option<Asked>,
    pub levers_before: LeversView,
    pub levers: LeversView,
    pub clamps: Vec<Clamp>,
    pub buyback_bps: u16,
    pub buyback_tokens: U128,
    pub buyback_near: U128,
    pub minutes: Option<String>,
    pub minutes_sha256: Option<String>,
    pub answers: Vec<String>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BuyResult {
    pub tokens: U128,
    pub cost: U128,
    pub tax: U128,
    pub refund: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SellResult {
    pub gross: U128,
    pub tax: U128,
    pub near_out: U128,
}

// ---------------------------------------------------------------- NEP-145 / NEP-148

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StorageBalance {
    pub total: U128,
    pub available: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StorageBalanceBounds {
    pub min: U128,
    pub max: Option<U128>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FungibleTokenMetadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
    pub icon: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
    pub decimals: u8,
}
