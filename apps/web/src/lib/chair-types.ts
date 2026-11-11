/**
 * Types of the CHAIR token contract's views and events (contracts/token/src),
 * plus the shapes the API routes return. Amounts are decimal strings:
 * NEAR in yoctoNEAR, CHAIR in base units (1 CHAIR = 10^18). Timestamps are
 * nanoseconds as strings.
 */

export type U128 = string;
export type U64 = string;

export interface Levers {
  tax_bps: number;
  endowment_share: number;
  locker_share: number;
}

export interface LeversView extends Levers {
  buyback_share: number;
}

export interface Asked {
  tax_bps: number;
  endowment_share: number;
  locker_share: number;
  buyback_burn: number;
}

/** `rule`: `bounds`, `step`, `sum`, `fund`, or a `+` combination. */
export interface Clamp {
  lever: string;
  asked: number;
  applied: number;
  rule: string;
}

export interface CurveView {
  p0: U128;
  k: U128;
  sold: U128;
  supply: U128;
  burned: U128;
  reserve: U128;
  integral: U128;
  price: U128;
  floor_price: U128;
  locked_reserve: U128;
}

export interface FundsView {
  reserve: U128;
  buyback_fund: U128;
  locker_pool: U128;
  locker_owed: U128;
  endowment_pending: U128;
  endowment_sent: U128;
  endowment_reported: U128;
  endowment_reported_at: U64;
}

export interface StatusView {
  meeting_count: number;
  next_meeting_at: U64;
  open_meeting: number | null;
  model: string | null;
  levers: LeversView;
  petitions_filed: number;
  total_weight: U128;
  holders: number;
}

export interface Stats {
  buys: number;
  sells: number;
  volume_buy: U128;
  volume_sell: U128;
  tax_collected: U128;
  petitions: number;
  petition_fees_burned: U128;
  buyback_tokens_burned: U128;
  buyback_near_spent: U128;
  locker_rewards_paid: U128;
  rulings: number;
  fallbacks: number;
  lapsed: number;
}

export interface Tier {
  min_endowment: U128;
  model: string;
}

export interface Bound {
  min: number;
  max: number;
  max_step: number | null;
}

export interface Rules {
  tax_bps: Bound;
  endowment_share: Bound;
  locker_share: Bound;
  buyback_share: string;
  buyback_burn: Bound;
  fallback_tax_target_bps: number;
  fallback_tax_step_bps: number;
}

export interface OutlayerConfig {
  account: string;
  project_id: string;
  version_key: string;
  secrets_profile: string | null;
  secrets_owner: string | null;
  deposit: U128;
  max_instructions: U64;
  max_memory_mb: number;
  max_execution_seconds: number;
}

export interface ConstitutionView {
  rules: Rules;
  meeting_interval_s: number;
  ladder: Tier[];
  lock_days: number[];
  max_locks_per_account: number;
  petition_fee: U128;
  petition_max_chars: number;
  petitions_in_brief: number;
  change_timelock_s: number;
  owner: string;
  brain: string;
  outlayer: OutlayerConfig;
  curve: { p0: U128; k: U128 };
  system_prompt: string;
}

export interface CourierVersion {
  project_id: string;
  version_key: string;
}

export interface GovernanceView {
  owner: string;
  model_signers: string[];
  gateway_signers: string[];
  courier: CourierVersion;
  pending: {
    model_signers: string[] | null;
    gateway_signers: string[] | null;
    courier: CourierVersion | null;
    proposed_at: U64;
    eta: U64;
  } | null;
  timelock_s: number;
}

export interface Petition {
  account: string;
  weight: U128;
  text: string;
  filed_at: U64;
}

export interface RequestPreview {
  meeting: number;
  model: string | null;
  request: string | null;
  seed_placeholder: string;
}

export type OutcomeKind = "ruling" | "fallback";

export interface Outcome {
  kind: OutcomeKind;
  reason: string | null;
  signer: string | null;
  signed_by: string | null;
  response_sha256: string | null;
  minutes_sha256: string | null;
  asked: Asked | null;
  levers: Levers;
  clamps: Clamp[];
  buyback_bps: number;
  buyback_tokens: U128;
  buyback_near: U128;
  locker_paid: U128;
  endowment_sent: U128;
  held_at: U64;
}

export type MeetingStatus = "requested" | "held" | "lapsed";

export interface Meeting {
  number: number;
  convener: string;
  convened_at: U64;
  model: string | null;
  request_sha256: string | null;
  seed: string | null;
  deposit: U128;
  levers_before: Levers;
  petitions: number;
  status: MeetingStatus;
  outcome: Outcome | null;
}

export interface RulingPreview {
  meeting: number;
  valid: boolean;
  reason: string | null;
  expected_signature_text: string | null;
  expected_gateway_text: string | null;
  signer: string | null;
  signed_by: string | null;
  asked: Asked | null;
  levers_before: LeversView;
  levers: LeversView;
  clamps: Clamp[];
  buyback_bps: number;
  buyback_tokens: U128;
  buyback_near: U128;
  minutes: string | null;
  minutes_sha256: string | null;
  answers: string[];
}

export interface LockView {
  id: number;
  amount: U128;
  days: number;
  weight: U128;
  start: U64;
  unlock_at: U64;
  active: boolean;
  pending_reward: U128;
}

export interface AccountView {
  account_id: string;
  balance: U128;
  locked: U128;
  transferable: U128;
  active_weight: U128;
  claimable: U128;
  rewards: U128;
  last_petition_at: U64;
  locks: LockView[];
}

export interface BuyQuote {
  tokens: U128;
  cost: U128;
  tax: U128;
  storage: U128;
  refund: U128;
  price_after: U128;
}

// ---------------------------------------------------------------- derived shapes

/**
 * How the meeting's signature check ended: the signer kind for an applied
 * ruling, else the fallback reason.
 */
export type SignatureCheck =
  | "provider_tee"
  | "gateway"
  | "bad_signature"
  | "bad_hash"
  | "unsigned"
  | "unparseable"
  | "lapsed"
  | "asleep"
  | "pending";

export interface TxRef {
  label: string;
  hash: string;
  url: string;
  receipt_id?: string;
  block_hash?: string;
}

export interface BriefPetition {
  from: string;
  weight: string;
  text: string;
}

export interface Brief {
  meeting: number;
  seed: string;
  supply: string;
  sold: string;
  reserve_near: string;
  price_near: string;
  volume_24h_near: { buy: string; sell: string };
  levers: LeversView;
  funds_near: { buyback: string; locker_pool: string; endowment_pending: string };
  endowment_near: string;
  locker_weight: string;
  petitions: BriefPetition[];
}

export interface CourierResult {
  /** What the courier module printed, parsed, minus the three fields below (its diagnostics). */
  raw: Record<string, unknown> | null;
  response_text: string | null;
  signature_text: string | null;
  signature: string | null;
  /** `sha256(response_text)` equals the hash the token recorded. */
  response_hash_matches: boolean | null;
  /** The assistant message content: what the chair wrote. */
  content: string | null;
  /** The content parsed as a ruling object, when it is one. */
  ruling: Record<string, unknown> | null;
  /** A courier-side error (`{"error":{code,message}}`), if it returned one. */
  error: { code?: string; message?: string } | null;
  outlayer_request_id: number | null;
  outlayer_charged_yocto: string | null;
}

/** Who signed a ruling, as results/signers-*.json and docs/LAUNCH.md know the address. */
export interface SignerInfo {
  address: string;
  /** `model`: a NEAR AI model's TEE key; `gateway`: NEAR AI's gateway key; `test_key`: the testnet test signer. */
  kind: "model" | "gateway" | "test_key" | "unknown";
  model: string | null;
  /** The file that names it. */
  source: string | null;
  /** When `pnpm verify:signers` checked it against NEAR AI's attestation. */
  verified_at: string | null;
}

export interface MeetingRecord {
  /** The token contract this meeting belongs to. */
  contract: string;
  number: number;
  status: MeetingStatus;
  final: boolean;
  convener: string;
  convened_at: U64;
  model: string | null;
  seed: string | null;
  request_sha256: string | null;
  /** The exact request bytes sent to the model, from `meeting_convened`. */
  request: string | null;
  /** `sha256(request)` equals `request_sha256`. */
  request_hash_matches: boolean | null;
  brief: Brief | null;
  reweighed: { account_id: string; filed_weight: U128; weight: U128; in_brief: boolean }[];
  courier: CourierResult | null;
  check: SignatureCheck;
  outcome: Outcome | null;
  levers_before: Levers;
  asked: Asked | null;
  applied: Levers | null;
  clamps: Clamp[];
  minutes: string | null;
  minutes_clipped: boolean;
  /** One per briefed petition, in brief order. */
  petitions: (BriefPetition & { answer: string | null })[];
  buyback: { bps: number; tokens: U128; near: U128 } | null;
  locker_paid: U128 | null;
  endowment_sent: U128 | null;
  on_ruling_gas_tgas: number | null;
  /** The ruling's recovered signer, named. */
  signer_info: SignerInfo | null;
  /** OutLayer's attestation for the courier run (it names the executed build and the input hash). */
  attestation_url: string | null;
  txs: TxRef[];
  events: { event: string; receipt_id: string; data: Record<string, unknown> }[];
  /** Where the data came from and what could not be found. */
  notes: string[];
}
