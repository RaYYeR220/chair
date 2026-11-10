// Golden test against the first deployed contract, kept as a historical fixture (v1 prompt, the
// testnet args of token.chair-dev.testnet, and the pre-v3 brief without a seed). The fixture holds
// every transaction sent to token.chair-dev.testnet since `new`, with the events the contract
// emitted, and the contract's views at one pinned block. Replaying the transactions through the sim's token model must give
// back the same events, the same state, and the same meeting request bytes (and sha256) that the
// contract built on chain: meeting 1 (one petition, from the `meeting_convened` event) and meeting 2
// (no petitions, from `get_request_preview`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CFG, REPO_DIR, SIM_DIR, YOCTO, withNewArgs } from "../src/config.ts";
import { Chair, R, ladderModel } from "../src/token.ts";
import { SYSTEM_PROMPT, briefOf, buildBrief, buildRequest, decimal, systemPromptFor } from "../src/prompt.ts";

const F = JSON.parse(readFileSync(join(SIM_DIR, "test", "fixtures", "testnet-chair-dev.json"), "utf8"));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ev = (tx: any, name: string) => tx.events.find((e: any) => e.event === name)?.data[0];
const DEPLOYED_PROMPT: string = F.views.get_constitution.system_prompt;
const ME = 0;
const NEW = F.txs.find((t: any) => t.method === "new").args;
/** Runs `fn` with token.chair-dev.testnet's `new` args in CFG (the sim's default run uses docs/LAUNCH.md's). */
const withToken1Args = <T>(fn: () => T): T => withNewArgs(NEW, fn);

/** Replays the fixture's transactions; returns the chair and what each step produced. */
function replay() { return withToken1Args(replay1); }
function replay1() {
  const c = new Chair();
  c.names.set(ME, "chair-dev.testnet");
  c.holder(ME).near = 100n * YOCTO;
  const out: Record<string, any> = {};
  for (const tx of F.txs) {
    const a = tx.args;
    switch (tx.method) {
      case "new": break;
      case "report_endowment": c.reportEndowment(BigInt(a.staked)); break;
      case "buy": {
        const before = { near: c.holder(ME).near };
        const tokens = c.buy(ME, BigInt(tx.deposit));
        out.buy = { tokens, cost: c.reserve, spent: before.near - c.holder(ME).near, price: c.price() };
        break;
      }
      case "lock": c.lock(ME, BigInt(a.amount), a.days, 0); out.lock = { weight: c.weightOf(ME) }; break;
      case "sell": {
        const r0 = c.reserve, n0 = c.holder(ME).near;
        c.sell(ME, BigInt(a.amount));
        out.sell = { gross: r0 - c.reserve, near_out: c.holder(ME).near - n0, price: c.price() };
        break;
      }
      case "petition": c.petition(ME, a.text, 0); out.petition = { weight: c.petitions[0].weight }; break;
      case "convene": {
        const model = ladderModel(c.brainReported)!;
        const brief = buildBrief(c, null);
        out.meeting1 = { model, brief, request: buildRequest(model, brief, DEPLOYED_PROMPT), petitions: c.topPetitions().length };
        out.held = c.hold(0, null, "unsigned");
        break;
      }
      default: throw new Error(`unhandled ${tx.method}`);
    }
    c.checkInvariants();
  }
  return { c, out };
}

test("the v1 deployment's args, and the constitution items it shares with the sim", () => withToken1Args(() => {
  const args = NEW;
  assert.equal(CFG.p0, BigInt(args.curve.p0));
  assert.equal(CFG.k, BigInt(args.curve.k));
  assert.equal(CFG.petitionFee, BigInt(args.petition_fee));
  assert.deepEqual(CFG.ladder.map((t) => [t.min, t.model]), args.ladder.map((t: any) => [BigInt(t.min_endowment), t.model]));
  assert.equal(args.levers, null);
  assert.deepEqual(CFG.launch, { tax_bps: 200, endowment_share: 60, locker_share: 20 }); // DEFAULT_LEVERS
  const k = F.views.get_constitution;
  assert.deepEqual(CFG.lockDays, k.lock_days);
  assert.equal(CFG.petitionTopN, k.petitions_in_brief);
  assert.equal(CFG.petitionMaxChars, k.petition_max_chars);
  assert.deepEqual(CFG.tax, k.rules.tax_bps);
  assert.deepEqual(CFG.endowment, k.rules.endowment_share);
  assert.equal(CFG.buybackMaxBps, k.rules.buyback_burn.max);
  assert.equal(CFG.fallbackTaxTarget, k.rules.fallback_tax_target_bps);
  assert.equal(CFG.fallbackTaxStep, k.rules.fallback_tax_step_bps);
}));

test("replaying the testnet transactions reproduces every event", () => {
  const { out } = replay();
  const tx = (m: string) => F.txs.find((t: any) => t.method === m);
  const buy = ev(tx("buy"), "buy");
  assert.equal(out.buy.tokens, BigInt(buy.tokens));
  assert.equal(out.buy.cost, BigInt(buy.cost));
  assert.equal(out.buy.spent, BigInt(buy.cost) + BigInt(buy.tax) + CFG.storageDeposit);
  assert.equal(out.buy.price, BigInt(buy.price));
  assert.equal(out.lock.weight, BigInt(ev(tx("lock"), "lock").weight));
  const sell = ev(tx("sell"), "sell");
  assert.equal(out.sell.gross, BigInt(sell.gross));
  assert.equal(out.sell.near_out, BigInt(sell.near_out));
  assert.equal(out.sell.price, BigInt(sell.price));
  assert.equal(out.petition.weight, BigInt(ev(tx("petition"), "petition_filed").weight));
  const held = ev(tx("convene"), "meeting_held");
  assert.equal(held.kind, "fallback");
  assert.equal(out.held.rewardsPaid, BigInt(held.locker_paid));
  assert.equal(out.held.endowmentSent, BigInt(held.endowment_sent));
  const lv = (x: any) => ({ tax_bps: x.tax_bps, endowment_share: x.endowment_share, locker_share: x.locker_share });
  assert.deepEqual(lv(out.held.applied), lv(held.levers));
  assert.equal(out.held.buybackTokens, BigInt(held.buyback.tokens));
});

test("meeting 1: the sim's request bytes equal the on-chain request (with a petition)", () => {
  const { out } = replay();
  const conv = ev(F.txs.find((t: any) => t.method === "convene"), "meeting_convened");
  assert.equal(conv.meeting, 1);
  assert.equal(out.meeting1.petitions, 1);
  assert.equal(out.meeting1.model, conv.model);
  assert.equal(out.meeting1.request, conv.request);
  assert.equal(out.meeting1.request, F.views.get_last_request);
  assert.equal(sha(out.meeting1.request), conv.request_sha256);
  assert.equal(sha(out.meeting1.request), F.views.get_meeting_1.request_sha256);
});

test("meeting 2: the sim's request bytes equal get_request_preview, and the state equals the views", () => withToken1Args(() => {
  const { c } = replay();
  const p = F.views.get_request_preview;
  const model = ladderModel(c.brainReported)!;
  const request = buildRequest(model, buildBrief(c, null), DEPLOYED_PROMPT);
  assert.equal(p.meeting, c.meeting + 1);
  assert.equal(request, p.request);
  assert.equal(sha(request), p.request_sha256);
  const curve = F.views.get_curve, funds = F.views.get_funds, stats = F.views.get_stats;
  assert.equal(c.s, BigInt(curve.sold));
  assert.equal(c.supply, BigInt(curve.supply));
  assert.equal(c.burned, BigInt(curve.burned));
  assert.equal(c.reserve, BigInt(curve.reserve));
  assert.equal(R(c.s), BigInt(curve.integral));
  assert.equal(c.price(), BigInt(curve.price));
  assert.equal(c.buybackFund, BigInt(funds.buyback_fund));
  assert.equal(c.lockerPool, BigInt(funds.locker_pool));
  assert.equal(c.lockerOwed, BigInt(funds.locker_owed));
  assert.equal(c.endowmentPending, BigInt(funds.endowment_pending));
  assert.equal(c.brain, BigInt(funds.endowment_sent));
  assert.equal(c.brainReported, BigInt(funds.endowment_reported));
  assert.equal(c.taxCollected, BigInt(stats.tax_collected));
  assert.equal(c.totalWeight(), BigInt(F.views.get_status.total_weight));
  assert.deepEqual(briefOf(c, null).levers, F.views.get_levers);
}));

test("brief numbers use the contract's decimal(): exact, trailing zeros trimmed", () => {
  assert.equal(decimal(0n, 24), "0");
  assert.equal(decimal(10n * YOCTO, 24), "10");
  assert.equal(decimal(1n, 24), "0.000000000000000000000001");
  assert.equal(decimal(1500000000000000000000000n, 24), "1.5");
  assert.equal(decimal(2100000n * 10n ** 18n, 18), "2100000");
  assert.equal(decimal(12345n, 0), "12345");
});

test("the v2 prompt is the deployed v1 prompt with only the locker bound changed", () => {
  assert.equal(systemPromptFor(50), DEPLOYED_PROMPT);
  const v1Bound = "lockers. 0 to 50, moving";
  assert.equal(DEPLOYED_PROMPT.split(v1Bound).length, 2);
  assert.equal(SYSTEM_PROMPT, DEPLOYED_PROMPT.replace(v1Bound, "lockers. 0 to 25, moving"));
});

/** The SYSTEM_PROMPT string literal from contracts/token/src/meeting.rs, unescaped. */
function contractSource() {
  const src = readFileSync(join(REPO_DIR, "contracts", "token", "src", "meeting.rs"), "utf8").replace(/\r\n/g, "\n");
  const m = src.match(/pub const SYSTEM_PROMPT: &str = "((?:[^"\\]|\\[\s\S])*)";/);
  assert.ok(m, "SYSTEM_PROMPT literal not found");
  const prompt = m[1].replace(/\\\n\s*/g, "").replace(/\\(.)/g, (_, ch) => ({ n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", "0": "\0" }[ch as string] ?? ch));
  const kon = readFileSync(join(REPO_DIR, "contracts", "token", "src", "constitution.rs"), "utf8");
  const lockerMax = Number(kon.match(/pub const LOCKER_MAX: i64 = (\d+);/)![1]);
  return { prompt, lockerMax };
}

test("the sim can build the contract source's system prompt byte for byte", () => {
  const { prompt, lockerMax } = contractSource();
  assert.equal(systemPromptFor(lockerMax), prompt);
});

test("the contract source has adopted the v2 constitution (LOCKER_MAX 25)", () => {
  const { prompt, lockerMax } = contractSource();
  assert.equal(lockerMax, CFG.locker.max, `contracts/token LOCKER_MAX is ${lockerMax}; the sim runs v2 (${CFG.locker.max})`);
  assert.equal(prompt, SYSTEM_PROMPT);
});
