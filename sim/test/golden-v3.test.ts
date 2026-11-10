// Golden test against token v3 on testnet (token3.chair-dev.testnet), the code mainnet launches:
// petitions reweighed at `convene`, the brief's `seed`, and the docs/LAUNCH.md economics. The fixture
// holds every successful transaction that reached token3 since it was created (FastNEAR's index),
// with every event of its receipt tree, and the views at one pinned block. Two meetings ran with
// signed rulings. Meeting 1 had three petitions after reweighing: bob filed at 10k CHAIR-days, then
// locked 200k more for 7 days, and the brief carries him at 1.41M. Its fooled ruling was clamped
// (locker 100 → 25, buyback 10000 → 50 bps). Meeting 2 came after a buy, a reward claim and a sell.
// Replaying all of it through the sim must reproduce every event, both requests byte for byte with
// their on-chain seeds, the reweighing, and the state the views report.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CFG, REPO_DIR, SIM_DIR, withNewArgs } from "../src/config.ts";
import { Chair, R, ladderModel, type MeetingRecord } from "../src/token.ts";
import { SEED_PLACEHOLDER, SYSTEM_PROMPT, briefOf, buildBrief, buildRequest, meetingSeed } from "../src/prompt.ts";

const F = JSON.parse(readFileSync(join(SIM_DIR, "test", "fixtures", "testnet-token3-chair-dev.json"), "utf8"));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
/** A token3 event of a transaction (the brain and OutLayer log their own). */
const ev = (tx: any, name: string) => tx.events.find((e: any) => e.event === name && e.executor === F.account)?.data[0];
const NEW = F.txs.find((t: any) => t.method === "new").args;
const NOT_CALLS = new Set(["CreateAccount+Transfer+AddKey", "DeleteKey"]);
const PROMPT_V2_SHA256 = "ea189faf8d48d9f50ce4d14eb469c4cfdcd842b4f0a4721a1aaaa2f392e2377c";
const LAUNCH_MD = readFileSync(join(REPO_DIR, "docs", "LAUNCH.md"), "utf8");
const ECON = (a: any) => ({ curve: a.curve, ladder: a.ladder, petition_fee: a.petition_fee, levers: a.levers });

/** The contract's `claim_rewards`: settle every lock of the holder and pay it out. */
function claim(c: Chair, id: number): bigint {
  let amount = 0n;
  for (const l of c.activeLocks(id)) { amount += c.lockReward(l); l.accStart = c.acc; }
  const h = c.holder(id);
  h.near += amount; h.claimed += amount; c.lockerOwed -= amount;
  return amount;
}

function replay() {
  return withNewArgs(NEW, () => {
    const c = new Chair({ launch: NEW.levers });
    const ids = new Map<string, number>();
    const idOf = (acc: string) => {
      if (!ids.has(acc)) { const id = ids.size; ids.set(acc, id); c.names.set(id, acc); c.holder(id).near = 100n * 10n ** 24n; }
      return ids.get(acc)!;
    };
    const steps: { tx: any; out: any }[] = [];
    for (const tx of F.txs) {
      const a = tx.args;
      let out: any = null;
      if (NOT_CALLS.has(tx.method)) continue;
      switch (tx.method) {
        case "new": break;
        case "report_endowment": c.reportEndowment(BigInt(a.staked)); break;
        case "buy": {
          const id = idOf(tx.signer), r0 = c.reserve;
          const tokens = c.buy(id, BigInt(tx.deposit));
          out = { tokens, cost: c.reserve - r0, price: c.price() };
          break;
        }
        case "sell": {
          const id = idOf(tx.signer), r0 = c.reserve, n0 = c.holder(id).near;
          c.sell(id, BigInt(a.amount));
          out = { gross: r0 - c.reserve, near_out: c.holder(id).near - n0, price: c.price() };
          break;
        }
        case "lock": { const id = idOf(tx.signer); assert.ok(c.lock(id, BigInt(a.amount), a.days, 0)); out = { weight: c.locks.at(-1)!.weight }; break; }
        case "petition": { const id = idOf(tx.signer); assert.ok(c.petition(id, a.text, 0)); out = { weight: c.petitions.find((p) => p.owner === id)!.weight }; break; }
        case "claim_rewards": out = { amount: claim(c, idOf(tx.signer)) }; break;
        case "convene": {
          const seed = ev(tx, "meeting_convened").seed; // the chain's randomness: the sim takes it as given
          const model = ladderModel(c.brainReported)!;
          const brief = buildBrief(c, seed);
          const request = buildRequest(model, brief);
          const reweighed = c.reweighed().map((r) => ({ account_id: c.nameOf(r.owner), filed_weight: r.filedWeight.toString(), weight: r.weight.toString(), in_brief: r.inBrief }));
          const petitions = c.topPetitions().length;
          const held: MeetingRecord = c.hold(0, ev(tx, "meeting_held").asked, null);
          out = { model, seed, brief, request, reweighed, petitions, held };
          break;
        }
        default: throw new Error(`unhandled ${tx.method}`);
      }
      c.checkInvariants();
      steps.push({ tx, out });
    }
    const preview = buildRequest(ladderModel(c.brainReported)!, buildBrief(c, SEED_PLACEHOLDER));
    return { c, steps, preview, ids };
  });
}

test("chair.config.json new_args are the docs/LAUNCH.md mainnet economics, which token3 runs", () => {
  const md = LAUNCH_MD.slice(LAUNCH_MD.indexOf("## Mainnet")).match(/```json\n([\s\S]*?)\n```/);
  assert.ok(md, "no mainnet JSON block in docs/LAUNCH.md");
  const mainnet = JSON.parse(md[1]);
  assert.deepEqual(ECON(CFG.rawNewArgs), ECON(mainnet));
  assert.equal(CFG.rawNewArgs.meeting_interval_s, mainnet.meeting_interval_s);
  assert.deepEqual(ECON(NEW), ECON(mainnet));
  assert.deepEqual(CFG.launch, NEW.levers);
  assert.equal(CFG.p0, BigInt(NEW.curve.p0));
  assert.equal(CFG.k, BigInt(NEW.curve.k));
  assert.equal(CFG.petitionFee, BigInt(NEW.petition_fee));
  const k = F.views.get_constitution;
  assert.deepEqual(k.rules.tax_bps, CFG.tax);
  assert.deepEqual(k.rules.endowment_share, CFG.endowment);
  assert.deepEqual(k.rules.locker_share, CFG.locker);
  assert.equal(k.rules.buyback_burn.max, CFG.buybackMaxBps);
  assert.deepEqual(k.lock_days, CFG.lockDays);
  assert.equal(k.petitions_in_brief, CFG.petitionTopN);
  assert.equal(k.petition_max_chars, CFG.petitionMaxChars);
});

test("token3 serves the v2 SYSTEM_PROMPT unchanged (sha256 from docs/LAUNCH.md)", () => {
  assert.equal(sha(SYSTEM_PROMPT), PROMPT_V2_SHA256);
  assert.equal(F.views.get_constitution.system_prompt, SYSTEM_PROMPT);
  assert.ok(LAUNCH_MD.includes(PROMPT_V2_SHA256));
});

test("token3: every trade, lock, petition and claim event is reproduced", () => {
  const { steps } = replay();
  const n: Record<string, number> = {};
  for (const { tx, out } of steps) {
    n[tx.method] = (n[tx.method] ?? 0) + 1;
    if (tx.method === "buy") {
      const e = ev(tx, "buy");
      assert.deepEqual([out.tokens, out.cost, out.price], [BigInt(e.tokens), BigInt(e.cost), BigInt(e.price)], tx.hash);
    } else if (tx.method === "sell") {
      const e = ev(tx, "sell");
      assert.deepEqual([out.gross, out.near_out, out.price], [BigInt(e.gross), BigInt(e.near_out), BigInt(e.price)], tx.hash);
    } else if (tx.method === "lock") assert.equal(out.weight, BigInt(ev(tx, "lock").weight), tx.hash);
    else if (tx.method === "petition") assert.equal(out.weight, BigInt(ev(tx, "petition_filed").weight), tx.hash);
    else if (tx.method === "claim_rewards") assert.equal(out.amount, BigInt(ev(tx, "rewards_claimed").amount), tx.hash);
  }
  assert.deepEqual(n, { new: 1, report_endowment: 1, buy: 5, lock: 5, petition: 3, convene: 2, claim_rewards: 1, sell: 1 });
});

test("token3: both requests are byte-identical to the chain, seed included, and both rulings execute identically", () => {
  const { steps } = replay();
  const meetings = steps.filter((s) => s.tx.method === "convene");
  assert.equal(meetings.length, 2);
  for (const { tx, out } of meetings) {
    const conv = ev(tx, "meeting_convened"), held = ev(tx, "meeting_held"), rec = F.views[`get_meeting_${conv.meeting}`];
    assert.match(out.seed, /^[0-9a-f]{32}$/);
    assert.equal(out.seed, rec.seed);
    assert.deepEqual(Object.keys(JSON.parse(out.brief)).slice(0, 3), ["meeting", "seed", "supply"]);
    assert.equal(out.model, conv.model);
    assert.equal(out.petitions, conv.petitions);
    assert.equal(out.request, conv.request, `meeting ${conv.meeting} request bytes`);
    assert.equal(sha(out.request), conv.request_sha256);
    assert.equal(sha(out.request), rec.request_sha256);
    assert.equal(sha(out.request), held.request_sha256);
    assert.deepEqual(out.reweighed, conv.reweighed);
    const lv = (x: any) => ({ tax_bps: x.tax_bps, endowment_share: x.endowment_share, locker_share: x.locker_share });
    assert.deepEqual(lv(out.held.applied), lv(held.levers));
    assert.deepEqual(out.held.clamps, held.clamps);
    assert.equal(out.held.applied.buyback_burn, held.buyback.bps);
    assert.equal(out.held.buybackTokens, BigInt(held.buyback.tokens));
    assert.equal(out.held.buybackCost, BigInt(held.buyback.near));
    assert.equal(out.held.rewardsPaid, BigInt(held.locker_paid));
    assert.equal(out.held.endowmentSent, BigInt(held.endowment_sent));
  }
  // docs/LAUNCH.md quotes meeting 1's brief and request sha256.
  const m1 = meetings[0].out;
  assert.ok(LAUNCH_MD.includes("\n" + m1.brief + "\n"), "meeting 1's brief as quoted in docs/LAUNCH.md");
  assert.ok(LAUNCH_MD.includes(sha(m1.request)));
  // Reweighing: bob filed at 10k CHAIR-days, locked 200k more for 7 days, and briefs at 1.41M, ahead of alice.
  const bob = m1.reweighed.find((r: any) => r.account_id === "chair3-fund-f2ba13.testnet");
  assert.deepEqual([bob.filed_weight, bob.weight], ["10000000000000000000000", "1410000000000000000000000"]);
  assert.deepEqual(JSON.parse(m1.brief).petitions.map((p: any) => [p.from, p.weight]), [
    ["chair3-whale-ebd657.testnet", "10500000"], ["chair3-fund-f2ba13.testnet", "1410000"], ["alice.chair-fund-ed152e.testnet", "500000"],
  ]);
  // The fooled ruling: locker 100 → 25 and buyback 10000 → 50, both on bounds.
  const h1 = ev(meetings[0].tx, "meeting_held");
  assert.deepEqual([h1.asked.locker_share, h1.levers.locker_share, h1.buyback.bps], [100, 25, 50]);
  // The last request the chain stored is meeting 2's.
  assert.equal(meetings[1].out.request, F.views.get_last_request);
});

test("token3: the final state equals the views, and the next request equals get_request_preview with the placeholder", () => {
  const { c, preview, ids } = replay();
  const curve = F.views.get_curve, funds = F.views.get_funds, stats = F.views.get_stats;
  assert.equal(c.s, BigInt(curve.sold));
  assert.equal(c.supply, BigInt(curve.supply));
  assert.equal(c.burned, BigInt(curve.burned));
  assert.equal(c.reserve, BigInt(curve.reserve));
  assert.equal(withNewArgs(NEW, () => R(c.s)), BigInt(curve.integral));
  assert.equal(withNewArgs(NEW, () => c.price()), BigInt(curve.price));
  assert.equal(c.buybackFund, BigInt(funds.buyback_fund));
  assert.equal(c.lockerPool, BigInt(funds.locker_pool));
  assert.equal(c.lockerOwed, BigInt(funds.locker_owed));
  assert.equal(c.endowmentPending, BigInt(funds.endowment_pending));
  assert.equal(c.brain, BigInt(funds.endowment_sent));
  assert.equal(c.brainReported, BigInt(funds.endowment_reported));
  assert.equal(c.taxCollected, BigInt(stats.tax_collected));
  assert.equal(c.burned - BigInt(stats.buyback_tokens_burned), BigInt(stats.petition_fees_burned));
  assert.equal(c.totalWeight(), BigInt(F.views.get_status.total_weight));
  assert.deepEqual(briefOf(c, null).levers, F.views.get_levers);
  assert.deepEqual(F.views.get_petitions, []);
  assert.equal(c.petitions.length, 0);
  for (const [acc, v] of Object.entries<any>(F.views.get_account)) {
    const id = ids.get(acc)!, h = c.holder(id);
    assert.equal(h.tokens + h.locked, BigInt(v.balance), `${acc} balance`);
    assert.equal(h.locked, BigInt(v.locked), `${acc} locked`);
    assert.equal(c.weightAt(id, 0), BigInt(v.active_weight), `${acc} active weight`);
    assert.equal(c.rewardsOf(id) - h.claimed, BigInt(v.rewards), `${acc} unclaimed rewards`);
  }
  const p = F.views.get_request_preview;
  assert.equal(p.meeting, c.meeting + 1);
  assert.equal(p.seed_placeholder, SEED_PLACEHOLDER);
  assert.equal(p.request_sha256, undefined, "no hash before the seed exists");
  assert.equal(preview, p.request);
});

test("the sim's brief seed: 16 bytes of sha256(scenario|seed|meeting), stable and distinct", () => {
  assert.equal(meetingSeed("whale", 1, 7), sha("whale|1|7").slice(0, 32));
  assert.match(meetingSeed("steady", 1, 1), /^[0-9a-f]{32}$/);
  assert.notEqual(meetingSeed("whale", 1, 7), meetingSeed("whale", 1, 8));
  assert.notEqual(meetingSeed("whale", 1, 7), meetingSeed("whale", 2, 7));
  assert.notEqual(meetingSeed("whale", 1, 7), meetingSeed("bankrun", 1, 7));
});
