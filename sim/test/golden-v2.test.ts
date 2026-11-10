// Golden test against the v2 token on testnet (token2.chair-dev.testnet), kept as a historical
// fixture: locker_share 0-25, the v2 SYSTEM_PROMPT, the launch economics of docs/LAUNCH.md (p0 1e18,
// k 5e10, levers 300/60/20, petition fee 10,000 CHAIR), and the pre-v3 brief, which had no seed. The fixture holds every successful transaction since `new` with its
// events, and the views at one pinned block. Two meetings ran with signed rulings: meeting 1 had two
// petitions (one an injection) and a fooled ruling the contract clamped (locker 100 → 25, buyback
// 10000 → 50 bps, then fund-limited); meeting 2 came after a sell, a buy and a reward claim.
// Replaying all of it through the sim must reproduce every event, both requests byte for byte, and
// the state the views report.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CFG, SIM_DIR, withNewArgs } from "../src/config.ts";
import { Chair, R, ladderModel, type MeetingRecord } from "../src/token.ts";
import { SYSTEM_PROMPT, buildBrief, buildRequest } from "../src/prompt.ts";

const F = JSON.parse(readFileSync(join(SIM_DIR, "test", "fixtures", "testnet-token2-chair-dev.json"), "utf8"));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ev = (tx: any, name: string) => tx.events.find((e: any) => e.event === name)?.data[0];
const NEW = F.txs.find((t: any) => t.method === "new").args;
/** docs/LAUNCH.md: SYSTEM_PROMPT v2, 1,409 bytes. */
const PROMPT_V2_SHA256 = "ea189faf8d48d9f50ce4d14eb469c4cfdcd842b4f0a4721a1aaaa2f392e2377c";

/** Runs `fn` with token2's `new` args in CFG. */
const withToken2Args = <T>(fn: () => T): T => withNewArgs(NEW, fn);

/** The contract's `claim_rewards`: settle every lock of the holder and pay it out. */
function claim(c: Chair, id: number): bigint {
  let amount = 0n;
  for (const l of c.activeLocks(id)) { amount += c.lockReward(l); l.accStart = c.acc; }
  const h = c.holder(id);
  h.near += amount; h.claimed += amount; c.lockerOwed -= amount;
  return amount;
}

function replay() {
  return withToken2Args(() => {
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
        case "lock": { const id = idOf(tx.signer); c.lock(id, BigInt(a.amount), a.days, 0); out = { weight: c.weightOf(id) }; break; }
        case "petition": { const id = idOf(tx.signer); c.petition(id, a.text, 0); out = { weight: c.weightOf(id) }; break; }
        case "claim_rewards": out = { amount: claim(c, idOf(tx.signer)) }; break;
        case "convene": {
          const model = ladderModel(c.brainReported)!;
          const request = buildRequest(model, buildBrief(c, null));
          const petitions = c.topPetitions().length;
          const asked = ev(tx, "meeting_held").asked;
          const held: MeetingRecord = c.hold(0, asked, null);
          out = { model, request, petitions, held };
          break;
        }
        default: throw new Error(`unhandled ${tx.method}`);
      }
      c.checkInvariants();
      steps.push({ tx, out });
    }
    const preview = buildRequest(ladderModel(c.brainReported)!, buildBrief(c, null));
    return { c, steps, preview };
  });
}

test("v2 SYSTEM_PROMPT: sha256 from docs/LAUNCH.md, and what token2 serves", () => {
  assert.equal(Buffer.byteLength(SYSTEM_PROMPT), 1409);
  assert.equal(sha(SYSTEM_PROMPT), PROMPT_V2_SHA256);
  assert.equal(F.views.get_constitution.system_prompt, SYSTEM_PROMPT);
  assert.deepEqual(F.views.get_constitution.rules.locker_share, { min: 0, max: CFG.locker.max, max_step: CFG.locker.max_step });
});

test("token2: every trade, lock, petition and claim event is reproduced", () => {
  const { steps } = replay();
  for (const { tx, out } of steps) {
    if (tx.method === "buy") {
      const e = ev(tx, "buy");
      assert.deepEqual([out.tokens, out.cost, out.price], [BigInt(e.tokens), BigInt(e.cost), BigInt(e.price)], tx.hash);
    } else if (tx.method === "sell") {
      const e = ev(tx, "sell");
      assert.deepEqual([out.gross, out.near_out, out.price], [BigInt(e.gross), BigInt(e.near_out), BigInt(e.price)], tx.hash);
    } else if (tx.method === "lock") assert.equal(out.weight, BigInt(ev(tx, "lock").weight));
    else if (tx.method === "petition") assert.equal(out.weight, BigInt(ev(tx, "petition_filed").weight));
    else if (tx.method === "claim_rewards") assert.equal(out.amount, BigInt(ev(tx, "rewards_claimed").amount));
  }
});

test("token2: both meeting requests are byte-identical to the chain, and both rulings execute identically", () => {
  const { steps } = replay();
  const meetings = steps.filter((s) => s.tx.method === "convene");
  assert.equal(meetings.length, 2);
  for (const { tx, out } of meetings) {
    const conv = ev(tx, "meeting_convened"), held = ev(tx, "meeting_held");
    assert.equal(out.petitions, conv.petitions);
    assert.equal(out.model, conv.model);
    assert.equal(out.request, conv.request, `meeting ${conv.meeting} request bytes`);
    assert.equal(sha(out.request), conv.request_sha256);
    assert.equal(sha(out.request), F.views[`get_meeting_${conv.meeting}`].request_sha256);
    // The same ruling, through the sim's clamp and buyback, lands where the contract put it.
    const lv = (x: any) => ({ tax_bps: x.tax_bps, endowment_share: x.endowment_share, locker_share: x.locker_share });
    assert.deepEqual(lv(out.held.applied), lv(held.levers));
    assert.deepEqual(out.held.clamps, held.clamps);
    assert.equal(out.held.applied.buyback_burn, held.buyback.bps);
    assert.equal(out.held.buybackTokens, BigInt(held.buyback.tokens));
    assert.equal(out.held.buybackCost, BigInt(held.buyback.near));
    assert.equal(out.held.rewardsPaid, BigInt(held.locker_paid));
    assert.equal(out.held.endowmentSent, BigInt(held.endowment_sent));
  }
  // Meeting 1 is the fooled ruling: locker 100 → 25 (bounds), buyback 10000 → 50 (bounds), then the fund.
  const m1 = ev(meetings[0].tx, "meeting_held");
  assert.equal(m1.asked.locker_share, 100);
  assert.equal(m1.levers.locker_share, 25);
});

test("token2: the final state equals the views, and the next request equals get_request_preview", () => {
  const { c, preview } = replay();
  const curve = F.views.get_curve, funds = F.views.get_funds, stats = F.views.get_stats;
  assert.equal(c.s, BigInt(curve.sold));
  assert.equal(c.supply, BigInt(curve.supply));
  assert.equal(c.burned, BigInt(curve.burned));
  assert.equal(c.reserve, BigInt(curve.reserve));
  assert.equal(withToken2Args(() => R(c.s)), BigInt(curve.integral));
  assert.equal(c.buybackFund, BigInt(funds.buyback_fund));
  assert.equal(c.lockerPool, BigInt(funds.locker_pool));
  assert.equal(c.lockerOwed, BigInt(funds.locker_owed));
  assert.equal(c.endowmentPending, BigInt(funds.endowment_pending));
  assert.equal(c.brain, BigInt(funds.endowment_sent));
  assert.equal(c.taxCollected, BigInt(stats.tax_collected));
  assert.equal(c.totalWeight(), BigInt(F.views.get_status.total_weight));
  assert.equal(preview, F.views.get_request_preview.request);
  assert.equal(sha(preview), F.views.get_request_preview.request_sha256);
});
