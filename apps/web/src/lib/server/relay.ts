import "server-only";
import { PublicKey } from "near-api-js";
import type { Petition } from "@/lib/chair-types";
import { cached, chair, forget, near, parseNear, tokens } from "./chair";
import { env, isTestnet } from "./env";
import { addSpend, exclusive, spentToday } from "./limit";
import { finalBlock, txEvents, txStatus, viewAccount } from "./rpc";
import { actions, call, demoAccountId, demoAvailable, demoPublicKey, ref, send } from "./wallet";

/**
 * Gasless petitions (testnet only). The demo account keeps a small pool of
 * petitioner sub-accounts, `p0.<demo>` … `p{N-1}.<demo>`, all on its key.
 * For a visitor's text it picks one that may file now, then as needed: creates
 * or tops it up, buys a little CHAIR, locks it past the next meeting, and
 * files the petition. The contract's own rules hold throughout: one petition
 * per account per 24 h, a lock that outlasts the next meeting, at most 8
 * queued (heaviest first), and a newer petition from an account replaces its
 * queued one, so a petitioner already in the queue is never reused.
 */

const DAY_NS = 86_400n * 1_000_000_000n;
const ONE_YOCTO = 1n;
/**
 * Account storage, plus headroom for the gas each call reserves up front (a
 * node reserves prepaid gas at a pessimistic price; the unused part comes
 * back), on top of the CHAIR budget. It stays with the petitioner for reuse.
 */
const ACCOUNT_OVERHEAD = parseNear("0.08");
/** Prepaid gas per call (buy burns about 4 TGas, lock and petition about 3). */
const GAS_T = { buy: 30, lock: 20, petition: 20 } as const;
const STORAGE_DEPOSIT = parseNear("0.025");
/** A lock must end at least this long after the next possible meeting. */
const LOCK_MARGIN_NS = 120n * 1_000_000_000n;

export class RelayError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const relayAvailable = () => isTestnet && demoAvailable();

export function validatePetition(raw: unknown): string {
  if (typeof raw !== "string") throw new RelayError("text is required");
  const text = raw.trim();
  const chars = [...text].length;
  if (chars === 0 || chars > 280) throw new RelayError("a petition is 1 to 280 characters");
  // The contract refuses Unicode control characters (`char::is_control`, category Cc).
  if (/[\u0000-\u001f\u007f-\u009f]/.test(text)) throw new RelayError("a petition must not contain control characters");
  return text;
}

const subId = (i: number) => `p${i}.${demoAccountId()}`;

async function demoBalance(): Promise<bigint> {
  const a = await viewAccount(demoAccountId()!);
  return a ? BigInt(a.amount) : 0n;
}

function spend(amount: bigint, balance: bigint) {
  const floor = parseNear(env.relay.floorNear);
  if (balance - amount < floor) {
    throw new RelayError("the demo account is down to its reserve; petitions are paused", 503, { floor_near: env.relay.floorNear });
  }
  if (spentToday() + amount > parseNear(env.relay.dailyCapNear)) {
    throw new RelayError("the demo account's daily budget is spent; try again tomorrow", 503);
  }
  addSpend(amount);
}

/** The first pool account that can file now: not in the queue, no petition in the last 24 h. Views only. */
export async function pickPetitioner(now: bigint, queue: Petition[]) {
  const queued = new Set(queue.map((p) => p.account));
  for (let i = 0; i < env.relay.poolSize; i++) {
    const id = subId(i);
    if (queued.has(id)) continue;
    const view = await chair.account(id, "optimistic");
    if (view && BigInt(view.last_petition_at) !== 0n && now < BigInt(view.last_petition_at) + DAY_NS) continue;
    return { id, view };
  }
  return null;
}

export async function relayPetition(rawText: unknown) {
  // The dry run never reaches this function; refuse anyway rather than sign anything while it is on.
  if (env.dryRun) throw new RelayError("dry run is on: this server does not send petitions", 503);
  if (!isTestnet) throw new RelayError("the petition relay runs on testnet only", 403);
  if (!demoAvailable()) throw new RelayError("the petition relay is not configured", 503);
  const text = validatePetition(rawText);

  return exclusive(async () => {
    const [block, status, queue, constitution] = await Promise.all([
      finalBlock("optimistic"),
      chair.status("optimistic"),
      chair.petitions("optimistic"),
      cached("constitution", 60_000, chair.constitution),
    ]);
    const now = BigInt(block.timestamp_nanosec);
    const nextMeeting = BigInt(status.next_meeting_at) > now ? BigInt(status.next_meeting_at) : now;
    const fee = BigInt(constitution.petition_fee);

    const pick = await pickPetitioner(now, queue);
    if (!pick) {
      throw new RelayError(`all ${env.relay.poolSize} demo petitioners are queued or filed in the last 24 h`, 429, { pool_size: env.relay.poolSize });
    }
    const id = pick.id;
    const demo = demoAccountId()!;
    const txs: ReturnType<typeof ref>[] = [];
    /** Runs one transaction; any failure stops the flow with every tx so far. */
    const step = async (label: string, tx: () => Promise<Awaited<ReturnType<typeof send>>>) => {
      let r: Awaited<ReturnType<typeof send>>;
      try {
        r = await tx();
      } catch (e) {
        throw new RelayError(`${label} failed: ${(e as Error).message}`, 502, { account: id, txs });
      }
      txs.push(ref(label, r));
      if (!r.ok) throw new RelayError(`${label} failed: ${r.error}`, 502, { account: id, txs });
      return r;
    };

    // 1. The petitioner account exists and can pay for a buy.
    const buy = parseNear(env.relay.buyNear);
    const needNear = buy + (pick.view ? 0n : STORAGE_DEPOSIT) + ACCOUNT_OVERHEAD;
    const acct = await viewAccount(id);
    const balance = await demoBalance();
    if (!acct) {
      spend(needNear, balance);
      await step("create petitioner", () =>
        send(demo, id, [actions.createAccount(), actions.transfer(needNear), actions.addFullAccessKey(PublicKey.fromString(demoPublicKey()))]),
      );
    } else if (BigInt(acct.amount) < needNear) {
      const topUp = needNear - BigInt(acct.amount);
      spend(topUp, balance);
      await step("top up petitioner", () => send(demo, id, [actions.transfer(topUp)]));
    }

    // 2. Enough unlocked CHAIR for the fee, plus something to lock if needed.
    let view = await chair.account(id, "optimistic");
    const hasLock = (v: typeof view) => !!v?.locks.some((l) => BigInt(l.unlock_at) > nextMeeting + LOCK_MARGIN_NS);
    const needLock = !hasLock(view);
    const transferable = view ? BigInt(view.transferable) : 0n;
    if (transferable < fee * (needLock ? 2n : 1n)) {
      const deposit = buy + (view ? 0n : STORAGE_DEPOSIT);
      await step("buy CHAIR", () => call(id, env.contractId, "buy", { min_out: "0" }, GAS_T.buy, deposit));
      view = await chair.account(id, "optimistic");
    }
    if (!view) throw new RelayError("the petitioner did not register", 502, { account: id, txs });

    // 3. A lock that runs past the next possible meeting (SPEC §3).
    if (needLock) {
      const lockAmount = BigInt(view.transferable) - fee;
      if (lockAmount <= 0n) throw new RelayError("not enough CHAIR to lock and pay the fee", 502, { account: id, txs });
      await step(`lock ${tokens(lockAmount)} CHAIR for ${env.relay.lockDays} d`, () =>
        call(id, env.contractId, "lock", { amount: lockAmount.toString(), days: env.relay.lockDays }, GAS_T.lock, ONE_YOCTO),
      );
    }

    // 4. File it.
    const filed = await step("petition", () => call(id, env.contractId, "petition", { text }, GAS_T.petition, ONE_YOCTO, "FINAL"));
    let event: Record<string, unknown> | null = null;
    try {
      const tx = await txStatus(filed.hash, id);
      event = txEvents(tx).find((e) => e.event === "petition_filed")?.data ?? null;
    } catch {
      event = null;
    }
    forget("state");
    const petition = filed.value as Petition | undefined;
    return {
      ok: true,
      account: id,
      meeting: status.meeting_count + 1,
      petition: petition ?? null,
      weight_chair_days: petition ? tokens(petition.weight) : null,
      queued: event ? Boolean(event.queued) : null,
      in_brief_provisional: event ? Boolean(event.in_brief) : null,
      note: "weights are recomputed at convene; the three heaviest queued petitions reach the brief",
      fee_burned_chair: tokens(fee),
      txs,
    };
  });
}

export async function relayStatus() {
  if (!relayAvailable()) return env.dryRun ? { available: true, dry_run: true } : { available: false, dry_run: false };
  const [balance, queue] = await Promise.all([demoBalance(), chair.petitions()]);
  return {
    available: true,
    demo_account: demoAccountId(),
    balance_near: near(balance),
    floor_near: env.relay.floorNear,
    pool_size: env.relay.poolSize,
    queued: queue.length,
    dry_run: env.dryRun,
  };
}
