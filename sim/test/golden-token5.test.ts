// Golden test against token5 on testnet (token5.chair-dev.testnet): token v3's mechanics with the
// token5 request, which adds `"reasoning_effort":"low"` right after `temperature`. Its two meetings
// went to NEAR AI's GLM 5.3 Flash through the courier and the relay, and both rulings came back
// signed by the model's TEE key. The fixture holds every successful transaction that reached token5
// since it was created (FastNEAR's index), with every event of its receipt tree, and the views at one
// pinned block. Replaying it through the sim must reproduce every event, both requests byte for byte
// in the token5 format with their on-chain seeds, both rulings' execution, and the final views.
// The v1-v3 format must not reproduce them: the format is part of the bytes the model signs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_DIR, SIM_DIR, withNewArgs } from "../src/config.ts";
import { Chair, R, ladderModel, type MeetingRecord } from "../src/token.ts";
import { SEED_PLACEHOLDER, SYSTEM_PROMPT, briefOf, buildBrief, buildRequest } from "../src/prompt.ts";

const F = JSON.parse(readFileSync(join(SIM_DIR, "test", "fixtures", "testnet-token5-chair-dev.json"), "utf8"));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
/** A token5 event of a transaction (the brain and OutLayer log their own). */
const ev = (tx: any, name: string) => tx.events.find((e: any) => e.event === name && e.executor === F.account)?.data[0];
const NEW = F.txs.find((t: any) => t.method === "new").args;
const NOT_CALLS = new Set(["CreateAccount+Transfer+AddKey", "DeleteKey"]);
const PROMPT_V2_SHA256 = "ea189faf8d48d9f50ce4d14eb469c4cfdcd842b4f0a4721a1aaaa2f392e2377c";
const LAUNCH_MD = readFileSync(join(REPO_DIR, "docs", "LAUNCH.md"), "utf8");
const ECON = (a: any) => ({ curve: a.curve, ladder: a.ladder, petition_fee: a.petition_fee, levers: a.levers });
const GLM_KEY = "0x3b753b4406613c5e70ae640508632b600424fa0c";

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
        case "lock": { const id = idOf(tx.signer); assert.ok(c.lock(id, BigInt(a.amount), a.days, 0)); out = { weight: c.locks.at(-1)!.weight }; break; }
        case "petition": { const id = idOf(tx.signer); assert.ok(c.petition(id, a.text, 0)); out = { weight: c.petitions.find((p) => p.owner === id)!.weight }; break; }
        case "convene": {
          const seed = ev(tx, "meeting_convened").seed; // the chain's randomness: the sim takes it as given
          const model = ladderModel(c.brainReported)!;
          const brief = buildBrief(c, seed);
          const request = buildRequest(model, brief, SYSTEM_PROMPT, "token5");
          const oldFormat = buildRequest(model, brief);
          const reweighed = c.reweighed().map((r) => ({ account_id: c.nameOf(r.owner), filed_weight: r.filedWeight.toString(), weight: r.weight.toString(), in_brief: r.inBrief }));
          const petitions = c.topPetitions().length;
          const held: MeetingRecord = c.hold(0, ev(tx, "meeting_held").asked, null);
          out = { model, seed, brief, request, oldFormat, reweighed, petitions, held };
          break;
        }
        default: throw new Error(`unhandled ${tx.method}`);
      }
      c.checkInvariants();
      steps.push({ tx, out });
    }
    const preview = buildRequest(ladderModel(c.brainReported)!, buildBrief(c, SEED_PLACEHOLDER), SYSTEM_PROMPT, "token5");
    return { c, steps, preview, ids };
  });
}

test("token5 runs the docs/LAUNCH.md mainnet economics and the v2 SYSTEM_PROMPT", () => {
  const md = LAUNCH_MD.slice(LAUNCH_MD.indexOf("## Mainnet")).match(/```json\n([\s\S]*?)\n```/);
  assert.ok(md, "no mainnet JSON block in docs/LAUNCH.md");
  assert.deepEqual(ECON(NEW), ECON(JSON.parse(md[1])));
  assert.equal(sha(SYSTEM_PROMPT), PROMPT_V2_SHA256);
  assert.equal(F.views.get_constitution.system_prompt, SYSTEM_PROMPT);
});

test("token5: every trade, lock and petition event is reproduced", () => {
  const { steps } = replay();
  const n: Record<string, number> = {};
  for (const { tx, out } of steps) {
    n[tx.method] = (n[tx.method] ?? 0) + 1;
    if (tx.method === "buy") {
      const e = ev(tx, "buy");
      assert.deepEqual([out.tokens, out.cost, out.price], [BigInt(e.tokens), BigInt(e.cost), BigInt(e.price)], tx.hash);
    } else if (tx.method === "lock") assert.equal(out.weight, BigInt(ev(tx, "lock").weight), tx.hash);
    else if (tx.method === "petition") assert.equal(out.weight, BigInt(ev(tx, "petition_filed").weight), tx.hash);
  }
  assert.deepEqual(n, { new: 1, report_endowment: 1, buy: 6, lock: 6, petition: 6, convene: 2 });
});

test("token5: both requests are byte-identical to the chain in the token5 format, and both NEAR AI rulings execute identically", () => {
  const { steps } = replay();
  const meetings = steps.filter((s) => s.tx.method === "convene");
  assert.equal(meetings.length, 2);
  for (const { tx, out } of meetings) {
    const conv = ev(tx, "meeting_convened"), held = ev(tx, "meeting_held"), rec = F.views[`get_meeting_${conv.meeting}`];
    assert.equal(out.seed, rec.seed);
    assert.equal(out.model, conv.model);
    assert.equal(out.petitions, conv.petitions);
    assert.equal(out.request, conv.request, `meeting ${conv.meeting} request bytes`);
    assert.ok(out.request.endsWith(`"}],"temperature":0,"reasoning_effort":"low"}`));
    assert.deepEqual(Object.keys(JSON.parse(out.request)), ["model", "messages", "temperature", "reasoning_effort"]);
    assert.equal(sha(out.request), conv.request_sha256);
    assert.equal(sha(out.request), rec.request_sha256);
    assert.equal(sha(out.request), held.request_sha256);
    // The v1-v3 format is the same request without `reasoning_effort`, and a different hash.
    assert.equal(out.oldFormat, out.request.replace(`,"reasoning_effort":"low"}`, "}"));
    assert.notEqual(sha(out.oldFormat), conv.request_sha256);
    assert.deepEqual(out.reweighed, conv.reweighed);
    // Signed by NEAR AI's GLM 5.3 Flash TEE key, not the test key.
    assert.deepEqual([held.kind, held.signed_by, held.signer], ["ruling", "provider_tee", GLM_KEY]);
    const lv = (x: any) => ({ tax_bps: x.tax_bps, endowment_share: x.endowment_share, locker_share: x.locker_share });
    assert.deepEqual(lv(out.held.applied), lv(held.levers));
    assert.deepEqual(out.held.clamps, held.clamps);
    assert.equal(out.held.applied.buyback_burn, held.buyback.bps);
    assert.equal(out.held.buybackTokens, BigInt(held.buyback.tokens));
    assert.equal(out.held.buybackCost, BigInt(held.buyback.near));
    assert.equal(out.held.rewardsPaid, BigInt(held.locker_paid));
    assert.equal(out.held.endowmentSent, BigInt(held.endowment_sent));
  }
  assert.equal(meetings[1].out.request, F.views.get_last_request);
});

test("token5: the final state equals the views, and the next request equals get_request_preview with the placeholder", () => {
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
  assert.equal(c.petitions.length, F.views.get_petitions.length);
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
  assert.equal(preview, p.request);
});
