import "server-only";
import type { MeetingRecord } from "@/lib/chair-types";
import { cached, chair, forget, near, parseNear } from "./chair";
import { env } from "./env";
import { getMeetingRecord, rememberConvene } from "./history";
import { addSpend, exclusive, spentToday } from "./limit";
import { finalBlock, receiptMethods, type TxStatus, txEvents, txFailure, txStatus, viewAccount } from "./rpc";
import { call, demoAccountId, demoAvailable } from "./wallet";

/**
 * Convene the next meeting with the demo account's NEAR: `convene` with the
 * exact OutLayer deposit once the interval has passed, then wait for the
 * courier's result to land in `on_ruling` and return the meeting record.
 */

export class ConveneError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const CONVENE_GAS_T = 300;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const conveneAvailable = () => demoAvailable();

/** Waits for the `convene` receipt itself and reads the meeting number from `meeting_convened`. */
async function conveneReceipt(hash: string, sender: string, deadline: number): Promise<{ n: number; tx: TxStatus }> {
  while (Date.now() < deadline) {
    try {
      const tx = await txStatus(hash, sender, "NONE");
      const methods = receiptMethods(tx);
      const r = tx.receipts_outcome.find((x) => methods.get(x.id) === "convene" && x.outcome.executor_id === env.contractId);
      if (r && Object.keys(r.outcome.status).length) {
        if (r.outcome.status.Failure !== undefined) throw new ConveneError(`convene failed: ${txFailure(tx)}`, 409, { tx: hash });
        const e = txEvents(tx).find((x) => x.event === "meeting_convened");
        if (e) return { n: Number(e.data.meeting), tx };
      }
    } catch (e) {
      if (e instanceof ConveneError) throw e;
      // not visible yet
    }
    await sleep(1_000);
  }
  throw new ConveneError("convene was sent but its receipt did not show up in time", 504, { tx: hash });
}

export async function convene(opts: { waitMs?: number } = {}) {
  // The dry run never reaches this function; refuse anyway rather than sign anything while it is on.
  if (env.dryRun) throw new ConveneError("dry run is on: this server does not convene", 503);
  if (!demoAvailable()) throw new ConveneError("convening is not configured on this server", 503);
  const demo = demoAccountId()!;
  const started = Date.now();

  const sent = await exclusive(async () => {
    const [block, status, constitution, demoState] = await Promise.all([
      finalBlock("optimistic"),
      chair.status("optimistic"),
      cached("constitution", 60_000, chair.constitution),
      viewAccount(demo),
    ]);
    const now = BigInt(block.timestamp_nanosec);
    const next = BigInt(status.next_meeting_at);
    if (now < next) {
      const s = Number((next - now) / 1_000_000_000n) + 1;
      throw new ConveneError(`the next meeting opens in ${s} s`, 409, { opens_in_s: s, next_meeting_at: status.next_meeting_at });
    }
    // Awake: exactly the OutLayer deposit. Asleep: any deposit is refunded, so send none.
    const deposit = status.model ? BigInt(constitution.outlayer.deposit) : 0n;
    const balance = demoState ? BigInt(demoState.amount) : 0n;
    const floor = parseNear(env.relay.floorNear);
    if (balance - deposit - parseNear("0.01") < floor) throw new ConveneError("the demo account is down to its reserve", 503);
    if (spentToday() + deposit > parseNear(env.relay.dailyCapNear)) throw new ConveneError("the demo account's daily budget is spent", 503);
    const r = await call(demo, env.contractId, "convene", {}, CONVENE_GAS_T, deposit, "INCLUDED");
    if (!r.ok && !/timed out/.test(r.error ?? "")) throw new ConveneError(`convene failed: ${r.error}`, 502, { tx: r.hash });
    addSpend(deposit);
    return { hash: r.hash, url: r.url, deposit, lapsing: status.open_meeting };
  });

  const deadline = started + (opts.waitMs ?? 80_000);
  const { n } = await conveneReceipt(sent.hash, demo, Math.min(deadline, Date.now() + 30_000));
  rememberConvene(n, sent.hash, demo);
  forget("state");

  // Poll the meeting until `on_ruling` (or the asleep fallback) has held it.
  let status = "requested";
  while (Date.now() < deadline) {
    const m = await chair.meeting(n, "final").catch(() => null);
    status = m?.status ?? status;
    if (m && m.status !== "requested") break;
    await sleep(1_500);
  }
  const base = {
    meeting: n,
    tx: { hash: sent.hash, url: sent.url },
    convener: demo,
    deposit_near: near(sent.deposit),
    lapsed_previous: sent.lapsing,
    waited_s: Math.round((Date.now() - started) / 100) / 10,
  };
  if (status === "requested") {
    return { ...base, landed: false, note: `the ruling has not landed yet; poll /api/meetings/${n}`, record: null as MeetingRecord | null };
  }
  // The on_ruling receipt is final; read the whole record from the tx tree.
  let record: MeetingRecord | null = null;
  for (let i = 0; i < 5; i++) {
    record = await getMeetingRecord(n);
    if (record?.courier?.raw || !record?.model) break;
    await sleep(1_500);
  }
  return { ...base, landed: true, record };
}
