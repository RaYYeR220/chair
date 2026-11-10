import "server-only";
import { cached, chair, near, parseNear, tokens } from "./chair";
import { ConveneError } from "./convene";
import { env, isTestnet } from "./env";
import { getMeetingRecord } from "./history";
import { pickPetitioner, RelayError, validatePetition } from "./relay";
import { finalBlock, viewAccount } from "./rpc";
import { demoAccountId } from "./wallet";

/**
 * Dry runs of the two write flows, for testing the app without touching the
 * chain (`CHAIR_RELAY_DRY_RUN=1`, off by default). Each one validates the
 * request exactly as the real flow does and answers in the real response's
 * shape, marked `dry_run: true`. Everything in it comes from read-only views;
 * nothing is signed or sent, so the petition queue and the meeting count stay
 * as they are.
 */

const NS = 1_000_000_000n;
/** A lock must end at least this long after the next possible meeting (as the relay). */
const LOCK_MARGIN_NS = 120n * NS;
/** What the relay keeps on a petitioner for storage and prepaid gas (as the relay). */
const ACCOUNT_OVERHEAD = parseNear("0.08");
const STORAGE_DEPOSIT = parseNear("0.025");

const DRY_NOTE = "dry run: nothing was signed or sent";

/** What `POST /api/relay/petition` would do with this text now. */
export async function dryRunPetition(rawText: unknown) {
  if (!isTestnet) throw new RelayError("the petition relay runs on testnet only", 403);
  const text = validatePetition(rawText);

  const [block, status, queue, constitution] = await Promise.all([
    finalBlock("optimistic"),
    chair.status("optimistic"),
    chair.petitions("optimistic"),
    cached("constitution", 60_000, chair.constitution),
  ]);
  const now = BigInt(block.timestamp_nanosec);
  const nextMeeting = BigInt(status.next_meeting_at) > now ? BigInt(status.next_meeting_at) : now;
  const fee = BigInt(constitution.petition_fee);
  const buy = parseNear(env.relay.buyNear);

  // The petitioner the relay would pick, when this server has a demo account.
  const demo = demoAccountId();
  const pick = demo ? await pickPetitioner(now, queue) : null;
  if (demo && !pick) {
    throw new RelayError(`all ${env.relay.poolSize} demo petitioners are queued or filed in the last 24 h`, 429, { pool_size: env.relay.poolSize });
  }
  const account = pick?.id ?? "p0.<demo account>";
  const view = pick?.view ?? null;

  const steps: string[] = [];
  const state = demo ? await viewAccount(account) : null;
  const needNear = buy + (view ? 0n : STORAGE_DEPOSIT) + ACCOUNT_OVERHEAD;
  if (!state) steps.push("create petitioner");
  else if (BigInt(state.amount) < needNear) steps.push("top up petitioner");

  const hasLock = !!view?.locks.some((l) => BigInt(l.unlock_at) > nextMeeting + LOCK_MARGIN_NS);
  const transferable = view ? BigInt(view.transferable) : 0n;
  let free = transferable;
  if (transferable < fee * (hasLock ? 1n : 2n)) {
    const quote = await chair.quoteBuy(buy + (view ? 0n : STORAGE_DEPOSIT), account.startsWith("p0.<") ? undefined : account);
    free += BigInt(quote.tokens);
    steps.push("buy CHAIR");
  }
  let weight: bigint;
  if (hasLock) {
    weight = BigInt(view!.active_weight);
  } else {
    const lockAmount = free - fee;
    if (lockAmount <= 0n) throw new RelayError("not enough CHAIR to lock and pay the fee", 502, { account });
    steps.push(`lock ${tokens(lockAmount)} CHAIR for ${env.relay.lockDays} d`);
    weight = lockAmount * BigInt(env.relay.lockDays);
  }
  steps.push("petition");

  // Where it would land: the queue keeps the heaviest 8 by weight at filing.
  const rank = queue.filter((p) => BigInt(p.weight) > weight).length + 1;
  return {
    ok: true,
    dry_run: true,
    account,
    meeting: status.meeting_count + 1,
    petition: { account, weight: weight.toString(), text, filed_at: now.toString() },
    weight_chair_days: tokens(weight),
    rank,
    queued: rank <= 8,
    in_brief_provisional: rank <= constitution.petitions_in_brief,
    note: `${DRY_NOTE}. The steps, the weight and the rank are what the relay would do now, worked out from views; weights are recomputed at convene.`,
    fee_burned_chair: tokens(fee),
    txs: steps.map((label) => ({ label, hash: null, url: null, ok: true })),
  };
}

/**
 * What `POST /api/convene` would do now. It checks the interval as the real
 * flow does, then lands on the latest real meeting as a stand-in, with that
 * meeting's own convene-to-ruling time as the progress timeline.
 */
export async function dryRunConvene() {
  const started = Date.now();
  const [block, status, constitution] = await Promise.all([
    finalBlock("optimistic"),
    chair.status("optimistic"),
    cached("constitution", 60_000, chair.constitution),
  ]);
  const now = BigInt(block.timestamp_nanosec);
  const next = BigInt(status.next_meeting_at);
  if (now < next) {
    const s = Number((next - now) / NS) + 1;
    throw new ConveneError(`the next meeting opens in ${s} s`, 409, { opens_in_s: s, next_meeting_at: status.next_meeting_at, dry_run: true });
  }
  const deposit = status.model ? BigInt(constitution.outlayer.deposit) : 0n;
  const latest = status.meeting_count;
  const record = latest > 0 ? await getMeetingRecord(latest) : null;
  const held = record?.outcome?.held_at ? BigInt(record.outcome.held_at) : null;
  const rulingS = record && held ? Number((held - BigInt(record.convened_at)) / 100_000_000n) / 10 : 8;
  return {
    ok: true,
    dry_run: true,
    meeting: latest,
    would_convene: latest + 1,
    tx: null,
    convener: demoAccountId(),
    deposit_near: near(deposit),
    lapsed_previous: status.open_meeting,
    waited_s: Math.round((Date.now() - started) / 100) / 10,
    landed: record !== null,
    /** Seconds from the click: the convene included, then `on_ruling` held (meeting `meeting`'s real timing). */
    timeline: { convened_s: 1.5, on_ruling_s: 1.5 + rulingS },
    note: `${DRY_NOTE}. Meeting ${latest + 1} was not convened; this is meeting ${latest}, the latest real one, as a stand-in.`,
    record,
  };
}
