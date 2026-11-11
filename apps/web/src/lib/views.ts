import type { Asked, Clamp, Levers, LeversView, MeetingRecord, Rules, SignatureCheck, SignerInfo, TxRef } from "@/lib/chair-types";
import { near, tokens } from "@/lib/units";

/**
 * The slices of the API the pages draw. Pure functions, shared by the server
 * (first render) and the browser (polling), so both read the same shape.
 */

// ---------------------------------------------------------------- state

export interface StateView {
  contract: string;
  network: string;
  block: { height: number; at_ms: number };
  levers: LeversView;
  rules: Rules;
  meetings: { count: number; open: number | null; opens_in_s: number; can_convene: boolean; interval_s: number };
  endowment: {
    near: number;
    model: string | null;
    asleep: boolean;
    next: { model: string; min_near: number; missing_near: number } | null;
    ladder: { model: string; min_near: number; reached: boolean }[];
  };
  funds: Record<"reserve" | "buyback_fund" | "locker_pool" | "locker_owed" | "endowment_pending" | "endowment_sent", string>;
  curve: { price_near: string; floor_price_near: string; supply_chair: string; burned_chair: string };
  stats: { rulings: number; fallbacks: number; lapsed: number; buys: number; sells: number; petitions: number };
  petitions: { queued: number; max_queue: number; in_brief: number; fee_chair: string; max_chars: number };
  governance: { owner: string; model_signers: string[]; gateway_signers: string[]; timelock_s: number; pending: boolean };
  token_keys: string[] | null;
  holders: number;
}

/** The `/api/state` body (only the fields read here). */
export interface StateBody {
  contract: string;
  network: string;
  block: { height: number; timestamp: string };
  status: { holders: number };
  levers: LeversView;
  meetings: { count: number; open: number | null; opens_in_s: number; can_convene: boolean; interval_s: number };
  endowment: {
    endowment_near: string;
    model: string | null;
    asleep: boolean;
    next: { model: string; min_endowment_near: string; missing_near: string } | null;
    ladder: { model: string; min_endowment_near: string; reached: boolean }[];
  };
  funds: { display: Record<string, string> };
  curve: { price_near: string; floor_price_near: string; supply_chair: string; burned_chair: string };
  stats: { rulings: number; fallbacks: number; lapsed: number; buys: number; sells: number; petitions: number };
  petitions: { queued: unknown[]; max_queue: number; in_brief: number; fee_chair: string; max_chars: number };
  governance: { owner: string; model_signers: string[]; gateway_signers: string[]; timelock_s: number; pending: unknown };
  token_account?: { keys: string[] | null };
  constitution: { rules: Rules; meeting_interval_s: number };
}

export function toStateView(s: StateBody): StateView {
  const f = s.funds.display;
  return {
    contract: s.contract,
    network: s.network,
    block: { height: s.block.height, at_ms: Number(BigInt(s.block.timestamp) / 1_000_000n) },
    levers: s.levers,
    rules: s.constitution.rules,
    meetings: {
      count: s.meetings.count,
      open: s.meetings.open,
      opens_in_s: s.meetings.opens_in_s,
      can_convene: s.meetings.can_convene,
      interval_s: s.meetings.interval_s,
    },
    endowment: {
      near: Number(s.endowment.endowment_near),
      model: s.endowment.model,
      asleep: s.endowment.asleep,
      next: s.endowment.next
        ? { model: s.endowment.next.model, min_near: Number(s.endowment.next.min_endowment_near), missing_near: Number(s.endowment.next.missing_near) }
        : null,
      ladder: s.endowment.ladder.map((t) => ({ model: t.model, min_near: Number(t.min_endowment_near), reached: t.reached })),
    },
    funds: {
      reserve: f.reserve,
      buyback_fund: f.buyback_fund,
      locker_pool: f.locker_pool,
      locker_owed: f.locker_owed,
      endowment_pending: f.endowment_pending,
      endowment_sent: f.endowment_sent,
    },
    curve: { price_near: s.curve.price_near, floor_price_near: s.curve.floor_price_near, supply_chair: s.curve.supply_chair, burned_chair: s.curve.burned_chair },
    stats: {
      rulings: s.stats.rulings,
      fallbacks: s.stats.fallbacks,
      lapsed: s.stats.lapsed,
      buys: s.stats.buys,
      sells: s.stats.sells,
      petitions: s.stats.petitions,
    },
    petitions: {
      queued: s.petitions.queued.length,
      max_queue: s.petitions.max_queue,
      in_brief: s.petitions.in_brief,
      fee_chair: s.petitions.fee_chair,
      max_chars: s.petitions.max_chars,
    },
    governance: {
      owner: s.governance.owner,
      model_signers: s.governance.model_signers,
      gateway_signers: s.governance.gateway_signers,
      timelock_s: s.governance.timelock_s,
      pending: s.governance.pending !== null,
    },
    token_keys: s.token_account?.keys ?? null,
    holders: s.status.holders,
  };
}

// ---------------------------------------------------------------- one meeting

export interface MeetingView {
  contract: string;
  number: number;
  status: MeetingRecord["status"];
  check: SignatureCheck;
  convener: string;
  model: string | null;
  seed: string | null;
  convened_at_ms: number;
  held_at_ms: number | null;
  request_sha256: string | null;
  request_hash_matches: boolean | null;
  response_sha256: string | null;
  response_hash_matches: boolean | null;
  signature_text: string | null;
  signature: string | null;
  signer: string | null;
  signed_by: string | null;
  signer_info: SignerInfo | null;
  reason: string | null;
  locker_weight: string | null;
  petitions: { from: string; weight: string; text: string; answer: string | null }[];
  levers_before: Levers;
  asked: Asked | null;
  applied: Levers | null;
  clamps: Clamp[];
  buyback: { bps: number; chair: number; near: number } | null;
  locker_paid_near: number | null;
  endowment_sent_near: number | null;
  minutes: string | null;
  minutes_clipped: boolean;
  on_ruling_tgas: number | null;
  outlayer_request_id: number | null;
  outlayer_charged_near: number | null;
  attestation_url: string | null;
  convene_tx: TxRef | null;
  txs: TxRef[];
  notes: string[];
}

const ms = (ns: string | null | undefined) => (ns ? Number(BigInt(ns) / 1_000_000n) : null);

export function toMeetingView(r: MeetingRecord): MeetingView {
  const o = r.outcome;
  return {
    contract: r.contract,
    number: r.number,
    status: r.status,
    check: r.check,
    convener: r.convener,
    model: r.model,
    seed: r.seed,
    convened_at_ms: ms(r.convened_at) ?? 0,
    held_at_ms: ms(o?.held_at),
    request_sha256: r.request_sha256,
    request_hash_matches: r.request_hash_matches,
    response_sha256: o?.response_sha256 ?? null,
    response_hash_matches: r.courier?.response_hash_matches ?? null,
    signature_text: r.courier?.signature_text ?? null,
    signature: r.courier?.signature ?? null,
    signer: o?.signer ?? null,
    signed_by: o?.signed_by ?? null,
    signer_info: r.signer_info ?? null,
    reason: o?.reason ?? null,
    locker_weight: r.brief?.locker_weight ?? null,
    petitions: r.petitions.map((p) => ({ from: p.from, weight: p.weight, text: p.text, answer: p.answer })),
    levers_before: r.levers_before,
    asked: r.asked,
    applied: r.applied,
    clamps: r.clamps,
    buyback: r.buyback ? { bps: r.buyback.bps, chair: Number(tokens(r.buyback.tokens)), near: Number(near(r.buyback.near)) } : null,
    locker_paid_near: r.locker_paid ? Number(near(r.locker_paid)) : null,
    endowment_sent_near: r.endowment_sent ? Number(near(r.endowment_sent)) : null,
    minutes: r.minutes,
    minutes_clipped: r.minutes_clipped,
    on_ruling_tgas: r.on_ruling_gas_tgas,
    outlayer_request_id: r.courier?.outlayer_request_id ?? null,
    outlayer_charged_near: r.courier?.outlayer_charged_yocto ? Number(near(r.courier.outlayer_charged_yocto)) : null,
    attestation_url: r.attestation_url ?? null,
    convene_tx: r.txs.find((t) => t.label === "convene") ?? null,
    txs: r.txs,
    notes: r.notes,
  };
}

/** A meeting as the rails replay it: what stood, what was asked, what landed. */
export interface ReplayMeeting {
  number: number;
  levers_before: Levers;
  asked: Asked;
  applied: Levers;
  clamps: Clamp[];
  buyback_bps: number;
}

export interface MeetingSummary {
  number: number;
  status: MeetingRecord["status"];
  check: SignatureCheck;
  convened_at_ms: number;
  convener: string;
  model: string | null;
  seed: string | null;
  petitions: number;
  levers_before: Levers;
  signer: string | null;
  signed_by: string | null;
  signer_info: SignerInfo | null;
  asked: Asked | null;
  applied: Levers | null;
  clamps: Clamp[];
  buyback_bps: number;
}

/** The `/api/meetings` list body, item shape. */
export interface MeetingListItem {
  number: number;
  status: MeetingRecord["status"];
  check: SignatureCheck;
  convened_at: string;
  convener: string;
  model: string | null;
  seed: string | null;
  petitions: number;
  levers_before: Levers;
  signer?: string | null;
  signed_by?: string | null;
  signer_info?: SignerInfo | null;
  asked: Asked | null;
  applied: Levers | null;
  clamps: Clamp[];
  buyback_bps: number;
}

export function toSummary(m: MeetingListItem): MeetingSummary {
  return {
    number: m.number,
    status: m.status,
    check: m.check,
    convened_at_ms: ms(m.convened_at) ?? 0,
    convener: m.convener,
    model: m.model,
    seed: m.seed,
    petitions: m.petitions,
    levers_before: m.levers_before,
    signer: m.signer ?? null,
    signed_by: m.signed_by ?? null,
    signer_info: m.signer_info ?? null,
    asked: m.asked,
    applied: m.applied,
    clamps: m.clamps,
    buyback_bps: m.buyback_bps,
  };
}

/** Held meetings with a ruling, oldest first: the rails replay these. */
export function toReplay(list: MeetingSummary[]): ReplayMeeting[] {
  return list
    .filter((m): m is MeetingSummary & { asked: Asked; applied: Levers } => m.status === "held" && !!m.asked && !!m.applied)
    .sort((a, b) => a.number - b.number)
    .map((m) => ({ number: m.number, levers_before: m.levers_before, asked: m.asked, applied: m.applied, clamps: m.clamps, buyback_bps: m.buyback_bps }));
}

// ---------------------------------------------------------------- a preview_ruling run

export interface PerLever {
  lever: string;
  before: number | null;
  asked: number | null;
  applied: number;
  clamped: boolean;
  rule: string | null;
}

/** One "try to fool it" run, flattened: what was sent, and what `preview_ruling` returned. */
export interface PreviewView {
  mode: "forge" | "jailbreak" | "garbage";
  variant: string | null;
  meeting: number;
  explain: string | null;
  signer_label: string | null;
  /** The key that signed: the allowlisted test key for jailbreak, a fresh random key for forge. */
  signed_with: string | null;
  edit: Record<string, unknown> | null;
  content: string | null;
  response_content: string | null;
  signature_text: string;
  signature: string;
  valid: boolean;
  reason: string | null;
  signer: string | null;
  asked: Asked | null;
  levers_before: LeversView;
  levers: LeversView;
  clamps: Clamp[];
  buyback_bps: number;
  per_lever: PerLever[];
  verdict: string;
  request_signed_over: string | null;
}

interface PreviewBody {
  mode: PreviewView["mode"];
  variant?: string;
  explain?: string;
  signer?: string | null;
  signer_address?: string;
  forger_address?: string | null;
  edit?: Record<string, unknown> | null;
  content?: string;
  target: { meeting: number };
  request?: { signed_over?: string };
  submitted: { response_text: string; signature_text: string; signature: string };
  preview: {
    valid: boolean;
    reason: string | null;
    signer: string | null;
    asked: Asked | null;
    levers_before: LeversView;
    levers: LeversView;
    clamps: Clamp[];
    buyback_bps: number;
  };
  per_lever: PerLever[];
  verdict: string;
}

/** The assistant message inside a chat completion, when there is one. */
function messageContent(responseText: string): string | null {
  try {
    const body = JSON.parse(responseText) as { choices?: { message?: { content?: string } }[] };
    return body.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}

export function toPreviewView(b: PreviewBody): PreviewView {
  return {
    mode: b.mode,
    variant: b.variant ?? null,
    meeting: b.target.meeting,
    explain: b.explain ?? null,
    signer_label: b.mode === "forge" ? null : (b.signer ?? null),
    signed_with: b.mode === "forge" ? (b.forger_address ?? null) : (b.signer_address ?? null),
    edit: b.edit ?? null,
    content: b.content ?? null,
    response_content: messageContent(b.submitted.response_text) ?? (b.submitted.response_text.length < 400 ? b.submitted.response_text : null),
    signature_text: b.submitted.signature_text,
    signature: b.submitted.signature,
    valid: b.preview.valid,
    reason: b.preview.reason,
    signer: b.preview.signer,
    asked: b.preview.asked,
    levers_before: b.preview.levers_before,
    levers: b.preview.levers,
    clamps: b.preview.clamps,
    buyback_bps: b.preview.buyback_bps,
    per_lever: b.per_lever,
    verdict: b.verdict,
    request_signed_over: b.request?.signed_over ?? null,
  };
}

// ---------------------------------------------------------------- the petition queue

export interface QueuedPetition {
  account: string;
  /** CHAIR-days at filing. */
  weight: number;
  text: string;
  filed_at_ms: number;
}
export interface PetitionsView {
  meeting: number;
  queue: QueuedPetition[];
  max_queue: number;
  /** The brief the contract would build now: the heaviest petitions, weights recomputed. */
  would_brief: { from: string; weight: number; text: string }[];
  relay: { available: boolean; dry_run: boolean; demo_account: string | null; balance_near: string | null; floor_near: number | null };
}

/** The `/api/petitions` body. */
export interface PetitionsBody {
  meeting: number;
  queue: { account: string; weight: string; text: string; filed_at: string; weight_chair_days: string }[];
  max_queue: number;
  would_brief: { from: string; weight: string; text: string }[];
  relay: { available: boolean; dry_run?: boolean; demo_account?: string | null; balance_near?: string; floor_near?: number };
}

export function toPetitionsView(b: PetitionsBody): PetitionsView {
  return {
    meeting: b.meeting,
    queue: b.queue
      .map((p) => ({ account: p.account, weight: Number(p.weight_chair_days), text: p.text, filed_at_ms: ms(p.filed_at) ?? 0 }))
      .sort((a, b) => b.weight - a.weight),
    max_queue: b.max_queue,
    would_brief: b.would_brief.map((p) => ({ from: p.from, weight: Number(p.weight), text: p.text })),
    relay: {
      available: b.relay.available,
      dry_run: !!b.relay.dry_run,
      demo_account: b.relay.demo_account ?? null,
      balance_near: b.relay.balance_near ?? null,
      floor_near: b.relay.floor_near ?? null,
    },
  };
}
