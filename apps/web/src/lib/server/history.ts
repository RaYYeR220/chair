import "server-only";
import { createHash } from "node:crypto";
import type {
  Asked,
  Brief,
  Clamp,
  CourierResult,
  Levers,
  Meeting,
  MeetingRecord,
  SignatureCheck,
  TxRef,
} from "@/lib/chair-types";
import { cached, chair, parseBrief } from "./chair";
import { env, txUrl } from "./env";
import { type ChainEvent, decodeValue, receiptMethods, type TxStatus, txEvents, txStatus } from "./rpc";

/**
 * Meeting history, rebuilt from the chain's own record: the meeting view,
 * plus the events and receipts of the transaction that convened it
 * (`meeting_convened`, the OutLayer courier's output, `on_ruling`'s
 * `meeting_held`). A held or lapsed meeting never changes again, so its
 * record is cached for the life of the server instance (and the API sends it
 * with an immutable cache header).
 */

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const records = new Map<string, MeetingRecord>();
const convenes = new Map<string, { hash: string; sender: string }>();
const key = (n: number) => `${env.contractId}:${n}`;

for (const [n, hash] of env.knownConvenes) convenes.set(key(n), { hash, sender: "" });

/** Record the transaction that convened meeting `n` (the convene route calls this). */
export function rememberConvene(n: number, hash: string, sender: string) {
  convenes.set(key(n), { hash, sender });
}

// ---------------------------------------------------------------- finding the convene tx

interface NbTxn {
  transaction_hash: string;
  signer_account_id: string;
  block_timestamp: string;
  actions: { action: string; method: string | null }[];
  outcomes: { status: boolean };
}

async function nearblocks<T>(path: string): Promise<T> {
  const res = await fetch(`${env.nearblocksApi}${path}`, {
    headers: env.nearblocksKey ? { authorization: `Bearer ${env.nearblocksKey}` } : {},
    signal: AbortSignal.timeout(12_000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`nearblocks ${res.status}`);
  const body = (await res.json()) as { data: T | null; errors?: { message: string }[] };
  if (body.data === null) throw new Error(`nearblocks: ${body.errors?.[0]?.message ?? "no data"}`);
  return body.data;
}

function convenedNumber(tx: TxStatus): number | null {
  const e = txEvents(tx).find((x) => x.event === "meeting_convened" && x.executor === env.contractId);
  return e ? Number(e.data.meeting) : null;
}

/**
 * The convene transaction of meeting `m`. Known hashes first; otherwise the
 * NearBlocks transaction list of the token just before `convened_at`, each
 * candidate confirmed on chain by its `meeting_convened` event.
 */
async function findConvene(m: Meeting): Promise<{ hash: string; sender: string; tx: TxStatus } | null> {
  const known = convenes.get(key(m.number));
  if (known) {
    const tx = await txStatus(known.hash, known.sender || m.convener);
    if (convenedNumber(tx) === m.number) return { hash: known.hash, sender: known.sender || m.convener, tx };
  }
  const at = BigInt(m.convened_at);
  const before = (at + 30n * 1_000_000_000n).toString();
  const list = await cached(`nb:${env.contractId}:${before}`, 60_000, () =>
    nearblocks<NbTxn[]>(`/v3/accounts/${env.contractId}/txns?before_ts=${before}&limit=25`),
  );
  const candidates = list
    .filter((t) => t.outcomes.status && t.actions.some((a) => a.method === "convene") && BigInt(t.block_timestamp) <= at)
    .sort((a, b) => (BigInt(b.block_timestamp) > BigInt(a.block_timestamp) ? 1 : -1))
    .slice(0, 3);
  for (const c of candidates) {
    const tx = await txStatus(c.transaction_hash, c.signer_account_id);
    if (convenedNumber(tx) === m.number) {
      rememberConvene(m.number, c.transaction_hash, c.signer_account_id);
      return { hash: c.transaction_hash, sender: c.signer_account_id, tx };
    }
  }
  return null;
}

// ---------------------------------------------------------------- reading a meeting out of a tx

function courierOf(tx: TxStatus, outlayer: string, responseSha: string | null): CourierResult | null {
  const methods = receiptMethods(tx);
  let raw: Record<string, unknown> | null = null;
  for (const r of tx.receipts_outcome) {
    if (r.outcome.executor_id !== outlayer || r.outcome.status.SuccessValue === undefined) continue;
    const v = decodeValue(r.outcome.status.SuccessValue);
    if (v && typeof v === "object" && ("response_text" in v || "error" in v || methods.get(r.id) === "on_execution_response")) {
      raw = v as Record<string, unknown>;
      break;
    }
  }
  const outlayerEvents = txEvents(tx).filter((e) => e.executor === outlayer);
  let requestId: number | null = null;
  const requested = outlayerEvents.find((e) => e.event === "execution_requested");
  if (requested && typeof requested.data.request_data === "string") {
    try {
      requestId = Number((JSON.parse(requested.data.request_data) as { request_id: number }).request_id);
    } catch {
      requestId = null;
    }
  }
  let charged: string | null = null;
  for (const r of tx.receipts_outcome) {
    for (const l of r.outcome.logs) {
      const m = /yNEAR charged: "?(\d+)"?/.exec(l);
      if (m && r.outcome.executor_id === outlayer) charged = m[1];
    }
  }
  if (!raw && requestId === null) return null;
  const str = (k: string) => (raw && typeof raw[k] === "string" ? (raw[k] as string) : null);
  const responseText = str("response_text");
  let content: string | null = null;
  let ruling: Record<string, unknown> | null = null;
  if (responseText) {
    try {
      const body = JSON.parse(responseText) as { choices?: { message?: { content?: string } }[] };
      content = body.choices?.[0]?.message?.content ?? null;
    } catch {
      content = null;
    }
    if (content) ruling = extractObject(content);
  }
  // `raw` keeps the courier's diagnostics; the three checked fields are below.
  const { response_text: _r, signature_text: _t, signature: _s, ...diagnostics } = raw ?? {};
  return {
    raw: raw ? diagnostics : null,
    response_text: responseText,
    signature_text: str("signature_text"),
    signature: str("signature"),
    response_hash_matches: responseText && responseSha ? sha256(responseText) === responseSha : null,
    content,
    ruling,
    error: raw && typeof raw.error === "object" && raw.error ? (raw.error as { code?: string; message?: string }) : null,
    outlayer_request_id: requestId,
    outlayer_charged_yocto: charged,
  };
}

/** The contract's `extract_object`: the whole content if it is one JSON object, else first `{` to last `}`. */
export function extractObject(content: string): Record<string, unknown> | null {
  const tryParse = (s: string) => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const whole = tryParse(content.trim());
  if (whole) return whole;
  const a = content.indexOf("{");
  const b = content.lastIndexOf("}");
  return a >= 0 && b > a ? tryParse(content.slice(a, b + 1)) : null;
}

function checkOf(m: Meeting): SignatureCheck {
  if (m.status === "requested" || !m.outcome) return "pending";
  if (m.outcome.kind === "ruling") return (m.outcome.signed_by as SignatureCheck) ?? "provider_tee";
  return (m.outcome.reason as SignatureCheck) ?? "unsigned";
}

function slimEvent(e: ChainEvent) {
  const { request: _request, ...data } = e.data;
  return { event: e.event, receipt_id: e.receipt_id, data };
}

function receiptRef(tx: TxStatus, hash: string, method: string, label: string): TxRef | null {
  const methods = receiptMethods(tx);
  const r = tx.receipts_outcome.find((x) => methods.get(x.id) === method);
  return r ? { label, hash, url: txUrl(hash), receipt_id: r.id, block_hash: r.block_hash } : null;
}

async function build(m: Meeting): Promise<{ record: MeetingRecord; complete: boolean }> {
  const notes: string[] = [];
  const constitution = await cached("constitution", 60_000, chair.constitution);
  const outlayer = constitution.outlayer.account;

  let conv: Awaited<ReturnType<typeof findConvene>> = null;
  try {
    conv = await findConvene(m);
  } catch (e) {
    notes.push(`convene tx lookup failed: ${(e as Error).message}`);
  }
  if (!conv) notes.push("convene transaction not found; the record holds the contract view only");

  const events = conv ? txEvents(conv.tx).filter((e) => e.executor === env.contractId) : [];
  const convened = events.find((e) => e.event === "meeting_convened" && Number(e.data.meeting) === m.number);
  let held = events.find((e) => e.event === "meeting_held" && Number(e.data.meeting) === m.number);
  const txs: TxRef[] = [];
  if (conv) {
    txs.push({ label: "convene", hash: conv.hash, url: txUrl(conv.hash), block_hash: conv.tx.transaction_outcome.block_hash });
    const req = receiptRef(conv.tx, conv.hash, "request_execution", "outlayer request_execution");
    const resp = receiptRef(conv.tx, conv.hash, "on_execution_response", "courier result");
    const ruled = receiptRef(conv.tx, conv.hash, "on_ruling", "on_ruling");
    for (const r of [req, resp, ruled]) if (r) txs.push(r);
  }

  // A lapsed meeting's fallback ran inside the next meeting's convene.
  let lapseEvents: ChainEvent[] = [];
  if (m.status === "lapsed" && !held) {
    try {
      const nextMeeting = await chair.meeting(m.number + 1);
      const next = nextMeeting ? await findConvene(nextMeeting) : null;
      if (next) {
        lapseEvents = txEvents(next.tx).filter((e) => e.executor === env.contractId && Number(e.data.meeting) === m.number);
        held = lapseEvents.find((e) => e.event === "meeting_held");
        txs.push({ label: "lapse settled (next convene)", hash: next.hash, url: txUrl(next.hash) });
      } else notes.push("the convene that settled this lapse was not found");
    } catch (e) {
      notes.push(`lapse lookup failed: ${(e as Error).message}`);
    }
  }

  const request = typeof convened?.data.request === "string" ? convened.data.request : null;
  const parsed = parseBrief(request);
  const brief = (parsed?.brief ?? null) as Brief | null;
  const courier = conv ? courierOf(conv.tx, outlayer, m.outcome?.response_sha256 ?? null) : null;

  const o = m.outcome;
  const heldData = held?.data as
    | { minutes?: string | null; minutes_clipped?: boolean; answers?: string[]; buyback?: { bps: number; tokens: string; near: string } }
    | undefined;
  // Full minutes and answers come from the signed response when it is the one
  // the token applied (its minutes hash matches); the event copy is clipped.
  let minutes = heldData?.minutes ?? null;
  let minutesClipped = heldData?.minutes_clipped ?? false;
  let answers = heldData?.answers ?? [];
  if (o?.kind === "ruling" && courier?.ruling && courier.response_hash_matches) {
    const full = courier.ruling.minutes;
    if (typeof full === "string" && o.minutes_sha256 && sha256(full) === o.minutes_sha256) {
      minutes = full;
      minutesClipped = false;
      const a = courier.ruling.answers;
      if (Array.isArray(a)) answers = a.slice(0, m.petitions).map(String);
    }
  }

  const methods = conv ? receiptMethods(conv.tx) : new Map<string, string>();
  const onRuling = conv?.tx.receipts_outcome.find((r) => methods.get(r.id) === "on_ruling");

  const record: MeetingRecord = {
    number: m.number,
    status: m.status,
    final: m.status !== "requested",
    convener: m.convener,
    convened_at: m.convened_at,
    model: m.model,
    seed: m.seed,
    request_sha256: m.request_sha256,
    request,
    request_hash_matches: request && m.request_sha256 ? sha256(request) === m.request_sha256 : null,
    brief,
    reweighed: (convened?.data.reweighed as MeetingRecord["reweighed"]) ?? [],
    courier,
    check: checkOf(m),
    outcome: o,
    levers_before: m.levers_before,
    asked: (o?.asked ?? null) as Asked | null,
    applied: (o?.levers ?? null) as Levers | null,
    clamps: (o?.clamps ?? []) as Clamp[],
    minutes,
    minutes_clipped: minutesClipped,
    petitions: (brief?.petitions ?? []).map((p, i) => ({ ...p, answer: answers[i] ?? null })),
    buyback: o ? { bps: o.buyback_bps, tokens: o.buyback_tokens, near: o.buyback_near } : (heldData?.buyback ?? null),
    locker_paid: o?.locker_paid ?? null,
    endowment_sent: o?.endowment_sent ?? null,
    on_ruling_gas_tgas: onRuling ? Math.round(onRuling.outcome.gas_burnt / 1e10) / 100 : null,
    txs,
    events: [...events.filter((e) => Number(e.data.meeting) === m.number), ...lapseEvents].map(slimEvent),
    notes,
  };
  if (request && record.request_hash_matches === false) notes.push("request bytes in the event do not hash to request_sha256");
  if (m.model && !request && conv) notes.push("meeting_convened carried no request");

  const settled = m.status !== "requested";
  const complete =
    settled &&
    !!conv &&
    !!convened &&
    !!held &&
    (!m.model || m.status === "lapsed" || (courier !== null && (courier.raw !== null || o?.reason === "unsigned")));
  return { record, complete };
}

/** One meeting's full record, or `null` if the contract has no such meeting. */
export async function getMeetingRecord(n: number): Promise<MeetingRecord | null> {
  const hit = records.get(key(n));
  if (hit) return hit;
  const m = await chair.meeting(n);
  if (!m) return null;
  const { record, complete } = await build(m);
  if (complete) records.set(key(n), record);
  return record;
}

export function isCachedFinal(n: number) {
  return records.has(key(n));
}

/** Every meeting the contract still holds (the last 64), newest first, from views only. */
export async function listMeetings() {
  const status = await chair.status();
  const count = status.meeting_count;
  const from = Math.max(1, count - 63);
  const nums = Array.from({ length: count - from + 1 }, (_, i) => count - i);
  const meetings = await Promise.all(
    nums.map(async (n) => {
      const cachedRecord = records.get(key(n));
      const m = await (cachedRecord ? Promise.resolve(null) : chair.meeting(n));
      if (cachedRecord) {
        const r = cachedRecord;
        return summary(
          { number: r.number, status: r.status, convener: r.convener, convened_at: r.convened_at, model: r.model, seed: r.seed, request_sha256: r.request_sha256, levers_before: r.levers_before, petitions: r.petitions.length, outcome: r.outcome, deposit: "0" },
          r.txs.find((t) => t.label === "convene")?.hash ?? null,
        );
      }
      return m ? summary(m, convenes.get(key(n))?.hash ?? null) : null;
    }),
  );
  return { count, open: status.open_meeting, next_meeting_at: status.next_meeting_at, meetings: meetings.filter((x) => x !== null) };
}

function summary(m: Meeting, convene: string | null) {
  const o = m.outcome;
  return {
    number: m.number,
    status: m.status,
    check: checkOf(m),
    convened_at: m.convened_at,
    convener: m.convener,
    model: m.model,
    seed: m.seed,
    request_sha256: m.request_sha256,
    petitions: m.petitions,
    levers_before: m.levers_before,
    asked: o?.asked ?? null,
    applied: o?.levers ?? null,
    clamps: o?.clamps ?? [],
    buyback_bps: o?.buyback_bps ?? 0,
    locker_paid: o?.locker_paid ?? null,
    endowment_sent: o?.endowment_sent ?? null,
    convene_tx: convene ? { hash: convene, url: txUrl(convene) } : null,
  };
}
