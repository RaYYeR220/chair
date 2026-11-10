import { test } from "node:test";
import assert from "node:assert/strict";
import { CFG, ONE, YOCTO, withLockerMax } from "../src/config.ts";
import { Chair, N, R, buyCost, sellProceeds, maxBuy, isqrt, clampRuling, fallbackRuling, ladderModel, priceAt } from "../src/token.ts";
import { parseRuling, llmPolicy } from "../src/policies.ts";
import type { LlmClient } from "../src/llm.ts";
import { u } from "../src/rng.ts";

test("isqrt is exact", () => {
  for (const n of [0n, 1n, 2n, 15n, 16n, 17n, 10n ** 40n, 10n ** 70n + 12345n, 4n * 10n ** 80n - 1n]) {
    const r = isqrt(n);
    assert.ok(r * r <= n && (r + 1n) * (r + 1n) > n, `isqrt(${n})`);
  }
});

test("curve: R is the ceiling of the exact integral; contract unit-test values", () => {
  assert.equal(R(0n), 0n);
  assert.equal(R(ONE), CFG.p0 + CFG.k / 2n); // 1 CHAIR
  assert.equal(R(1_000_000n * ONE), CFG.p0 * 1_000_000n + (CFG.k * 1_000_000_000_000n) / 2n);
  assert.equal(R(1n), 2n); // 1 base unit: 1 + 5e-7 yocto, rounded up
  assert.equal(priceAt(ONE), CFG.p0 + CFG.k);
  for (let i = 0; i < 200; i++) {
    const s = BigInt(Math.floor(u(1, i) * 1e9)) * ONE + BigInt(Math.floor(u(2, i) * 1e18));
    const r = R(s);
    assert.ok(r * 2n * ONE * ONE >= N(s) && (r - 1n) * 2n * ONE * ONE < N(s));
  }
});

test("buy then sell round trip is exact before tax (path independence)", () => {
  let s = 123456789n * ONE;
  for (let i = 0; i < 200; i++) {
    const delta = BigInt(Math.floor(u(7, i) * 1e9)) * ONE + BigInt(Math.floor(u(8, i) * 1e9));
    assert.equal(buyCost(s, delta), sellProceeds(s + delta, delta));
    s += delta;
  }
});

test("maxBuy returns the largest affordable delta", () => {
  for (let i = 0; i < 100; i++) {
    const s = BigInt(Math.floor(u(1, i) * 1e9)) * ONE;
    const budget = BigInt(Math.floor(u(2, i) * 1e6)) * (YOCTO / 1000n);
    const [d, cost] = maxBuy(s, budget);
    assert.equal(cost, buyCost(s, d));
    assert.ok(cost <= budget);
    assert.ok(buyCost(s, d + 1n) > budget);
  }
});

test("reserve == R(s), supply + burned == s, rewards covered, through random activity", () => {
  const c = new Chair();
  for (let id = 0; id < 20; id++) c.holder(id).near = 1000n * YOCTO;
  for (let day = 0; day < 40; day++) {
    c.newDay(day);
    for (let id = 0; id < 20; id++) {
      const r = u(3, day, id);
      const h = c.holder(id);
      if (r < 0.4) c.buy(id, h.near / 5n);
      else if (r < 0.7) c.sell(id, h.tokens / 3n);
      else if (r < 0.85) c.lock(id, h.tokens / 2n, CFG.lockDays[id % 3], day);
      else c.petition(id, `petition ${id} ${day}`);
      c.checkInvariants();
    }
    const rr = u(4, day) < 0.5 ? null : { tax_bps: 50 + Math.floor(u(5, day) * 400), endowment_share: Math.floor(u(6, day) * 120), locker_share: Math.floor(u(9, day) * 80), buyback_burn: Math.floor(u(10, day) * 100) };
    c.hold(day, rr, rr ? null : "asleep");
    c.reportEndowment(c.brain);
    c.checkInvariants();
    assert.ok(c.levers.tax_bps >= CFG.tax.min && c.levers.tax_bps <= CFG.tax.max);
    assert.ok(c.levers.locker_share <= CFG.locker.max);
    assert.ok(c.levers.endowment_share + c.levers.locker_share <= 100);
  }
});

test("buyback-and-burn: tax-exempt, supply unchanged, s, reserve and floor up", () => {
  const c = new Chair();
  c.holder(1).near = 5000n * YOCTO;
  c.buy(1, 4000n * YOCTO);
  c.hold(0, null, "asleep");
  const before = { s: c.s, supply: c.supply, reserve: c.reserve, floor: c.floor(), price: c.price(), fund: c.buybackFund, tax: c.taxCollected };
  assert.ok(before.fund > 0n);
  const rec = c.hold(1, { tax_bps: 200, endowment_share: 60, locker_share: 20, buyback_burn: 50 }, null);
  assert.ok(rec.buybackTokens > 0n);
  assert.equal(c.supply, before.supply);
  assert.equal(c.taxCollected, before.tax);
  assert.ok(c.s > before.s && c.reserve > before.reserve && c.floor() > before.floor && c.price() > before.price);
  assert.equal(c.reserve - before.reserve, rec.buybackCost);
  assert.equal(before.fund - c.buybackFund, rec.buybackCost);
  c.checkInvariants();
});

test("fallback: no buyback, but lockers are paid and the endowment is sent", () => {
  const c = new Chair();
  c.holder(1).near = 100n * YOCTO;
  c.buy(1, 50n * YOCTO);
  c.lock(1, c.holder(1).tokens / 2n, 7, 0);
  c.sell(1, c.holder(1).tokens / 2n);
  const pool = c.lockerPool, pending = c.endowmentPending, fund = c.buybackFund;
  assert.ok(pool > 0n && pending > 0n && fund > 0n);
  const rec = c.hold(0, null, "asleep");
  assert.equal(rec.buybackTokens, 0n);
  assert.equal(c.buybackFund, fund);
  assert.equal(rec.rewardsPaid, pool);
  assert.equal(rec.endowmentSent, pending);
  assert.equal(c.brain, pending);
  assert.equal(c.lockerPool, 0n);
  assert.equal(c.lockerOwed, pool);
  // Rewards accrue per weight and are claimed when the lock ends.
  const earned = c.rewardsOf(1);
  assert.ok(earned > 0n && pool - earned < 10n);
  const near = c.holder(1).near;
  c.newDay(7);
  assert.equal(c.holder(1).near - near, earned);
  assert.equal(c.lockerOwed, pool - earned);
});

test("petitions: lockers only, one a day, fee burned, three heaviest in order (earlier wins ties)", () => {
  const c = new Chair();
  for (let id = 0; id < 5; id++) { c.holder(id).near = 100n * YOCTO; c.buy(id, 10n * YOCTO); }
  assert.equal(c.petition(0, "no lock"), false);
  for (let id = 0; id < 5; id++) c.lock(id, 1000n * ONE * BigInt(id === 4 ? 1 : 2), 7, 0);
  const supply = c.supply;
  for (let id = 0; id < 5; id++) assert.equal(c.petition(id, `p${id}`, 0), true);
  assert.equal(c.supply, supply - 5n * CFG.petitionFee);
  assert.equal(c.burned, 5n * CFG.petitionFee);
  assert.equal(c.petition(0, "again", 0), false);
  assert.deepEqual(c.topPetitions().map((p) => p.text), ["p0", "p1", "p2"]);
  assert.equal(c.petition(0, "next day", 1), true);
});

test("v3 petitions: a lock must outlive the meeting; reweighed at the meeting, zeros dropped, the slot freed", () => {
  const c = new Chair();
  for (let id = 0; id < 5; id++) { c.holder(id).near = 100n * YOCTO; c.buy(id, 10n * YOCTO); }
  // id 0 locks for a day on day 0: its lock ends before day 1's meeting, so it can't petition on day 1.
  c.lock(0, 10000n * ONE, 1, 0);
  assert.equal(c.weightAt(0, 0), 10000n * ONE);
  assert.equal(c.weightAt(0, 1), 0n);
  assert.equal(c.petition(0, "too late", 1), false);
  // Filed on day 0 (the heaviest), then the meeting slips to day 1: id 0 is dropped, id 4 moves up.
  for (let id = 1; id < 5; id++) c.lock(id, BigInt(10 - id) * 100n * ONE, 7, 0);
  for (let id = 0; id < 5; id++) assert.equal(c.petition(id, `p${id}`, 0), true);
  assert.deepEqual(c.petitions.map((p) => p.text), ["p0", "p1", "p2", "p3", "p4"], "queued by weight at filing");
  assert.deepEqual(c.briefPetitions(0).map((p) => p.text), ["p0", "p1", "p2"]);
  assert.deepEqual(c.briefPetitions(1).map((p) => p.text), ["p1", "p2", "p3"]);
  assert.deepEqual(c.reweighed(1)[0], { owner: 0, filedWeight: 10000n * ONE, weight: 0n, inBrief: false });
  // A lock added after filing counts at the meeting (bob on token3): id 3 overtakes ids 1 and 2.
  c.lock(3, 1000n * ONE, 30, 0);
  assert.deepEqual(c.briefPetitions(0).map((p) => [p.text, p.weight]), [["p3", 7n * 700n * ONE + 30n * 1000n * ONE], ["p0", 10000n * ONE], ["p1", 7n * 900n * ONE]]);
  c.hold(0, null, "asleep");
  assert.equal(c.petitions.length, 0, "convene takes the queue");
});

test("v3 petitions: the queue holds 8, heaviest at filing first, one per account", () => {
  const c = new Chair();
  for (let id = 0; id < 11; id++) { c.holder(id).near = 100n * YOCTO; c.buy(id, 5n * YOCTO); c.lock(id, BigInt(10 + id) * ONE, 30, 0); }
  for (let id = 0; id < 10; id++) assert.equal(c.petition(id, `q${id}`, 0), true);
  assert.equal(c.petitions.length, CFG.petitionQueueMax);
  assert.equal(c.petitions[0].text, "q9");
  assert.ok(c.petitions.every((p) => p.text !== "q0" && p.text !== "q1"), "the lightest drop");
  // Too light for a full queue: filed and burned, not queued.
  c.holder(20).near = 100n * YOCTO; c.buy(20, 5n * YOCTO); c.lock(20, ONE, 7, 0);
  const burned = c.burned;
  assert.equal(c.petition(20, "too light", 0), true);
  assert.equal(c.burned, burned + CFG.petitionFee);
  assert.ok(!c.petitions.some((p) => p.owner === 20));
  // With no meeting in between, a newer petition from the same account replaces the older.
  assert.equal(c.petition(9, "q9 again", 1), true);
  assert.deepEqual(c.petitions.filter((p) => p.owner === 9).map((p) => p.text), ["q9 again"]);
  // Equal weights: earlier filing wins.
  const d = new Chair();
  for (let id = 0; id < 4; id++) { d.holder(id).near = 100n * YOCTO; d.buy(id, 5n * YOCTO); d.lock(id, 100n * ONE, 7, 0); }
  for (const id of [2, 0, 3, 1]) d.petition(id, `e${id}`, 0);
  assert.deepEqual(d.briefPetitions(0).map((p) => p.text), ["e2", "e0", "e3"]);
});

test("v3: a response_text over 64 KiB is unparseable before it is parsed", async () => {
  const c = new Chair();
  c.holder(1).near = 100n * YOCTO; c.buy(1, 50n * YOCTO);
  c.reportEndowment(10n * YOCTO);
  const content = JSON.stringify({ tax_bps: 250, endowment_share: 60, locker_share: 20, buyback_burn: 0, minutes: "m", answers: [] });
  const stub = (responseBytes: number) => ({ complete: async () => ({ key: "k", cached: true, content, responseBytes, promptTokens: 0, completionTokens: 0, usd: 0 }) }) as unknown as LlmClient;
  const ctx = { scenario: "steady", seed: 1 };
  const ok = await llmPolicy(stub(CFG.maxResponseBytes)).decide(c, 0, ctx);
  assert.equal(ok.reason, null);
  assert.equal(ok.ruling?.tax_bps, 250);
  assert.match(ok.seed!, /^[0-9a-f]{32}$/);
  assert.equal(JSON.parse(ok.brief!).seed, ok.seed);
  const big = await llmPolicy(stub(CFG.maxResponseBytes + 1)).decide(c, 0, ctx);
  assert.equal(big.reason, "unparseable");
  assert.equal(big.ruling, null);
});

test("constitution: the contract's clamp cases (v1 bound), and the v2 locker ceiling", () => {
  const v1 = withLockerMax(50);
  const lv = (t: number, e: number, l: number) => ({ tax_bps: t, endowment_share: e, locker_share: l });
  const ask = (t: number, e: number, l: number, b: number) => ({ tax_bps: t, endowment_share: e, locker_share: l, buyback_burn: b });
  const rule = (r: ReturnType<typeof clampRuling>, lever: string) => r.clamps.find((c) => c.lever === lever);
  let r = clampRuling(ask(200, 30, 99, 0), lv(200, 30, 45), v1);
  assert.equal(r.levers.locker_share, 50); assert.equal(rule(r, "locker_share")!.rule, "bounds");
  r = clampRuling(ask(200, 60, -3, 0), lv(200, 60, 5), v1);
  assert.equal(r.levers.locker_share, 0); assert.equal(rule(r, "locker_share")!.rule, "bounds");
  r = clampRuling(ask(200, 50, 45, 0), lv(200, 50, 20), v1);
  assert.equal(r.levers.locker_share, 30); assert.equal(rule(r, "locker_share")!.rule, "step");
  r = clampRuling(ask(200, 80, 30, 0), lv(200, 70, 30), v1);
  assert.deepEqual([r.levers.endowment_share, r.levers.locker_share], [80, 20]);
  assert.deepEqual(rule(r, "locker_share"), { lever: "locker_share", asked: 30, applied: 20, rule: "sum" });
  r = clampRuling(ask(200, 70, 50, 0), lv(200, 60, 30), v1);
  assert.deepEqual(rule(r, "locker_share"), { lever: "locker_share", asked: 50, applied: 30, rule: "step+sum" });
  r = clampRuling(ask(200, 60, 20, 10_000), lv(200, 60, 20), v1);
  assert.equal(r.buyback_burn, 50); assert.equal(rule(r, "buyback_burn")!.rule, "bounds");
  r = clampRuling(ask(9.2e18, -9.2e18, 9.2e18, 9.2e18), lv(200, 60, 20), v1);
  assert.deepEqual(r.levers, lv(250, 50, 30)); assert.equal(r.buyback_burn, 50); assert.equal(r.clamps.length, 4);
  // v2: locker_share tops out at 25; asking 30 from 20 is a bounds clamp, 25 is free.
  r = clampRuling(ask(200, 60, 30, 0), lv(200, 60, 20));
  assert.deepEqual(rule(r, "locker_share"), { lever: "locker_share", asked: 30, applied: 25, rule: "bounds" });
  assert.equal(clampRuling(ask(200, 60, 25, 0), lv(200, 60, 20)).clamps.length, 0);
});

test("fallback moves tax 10 bps toward 200 and holds the rest", () => {
  assert.deepEqual(fallbackRuling({ tax_bps: 300, endowment_share: 60, locker_share: 10 }), { tax_bps: 290, endowment_share: 60, locker_share: 10, buyback_burn: 0 });
  assert.equal(fallbackRuling({ tax_bps: 195, endowment_share: 60, locker_share: 10 }).tax_bps, 200);
  assert.equal(fallbackRuling({ tax_bps: 200, endowment_share: 60, locker_share: 10 }).tax_bps, 200);
});

test("ruling parse mirrors the contract's check 3", () => {
  const ok = (o: object) => JSON.stringify({ tax_bps: 210, endowment_share: 60, locker_share: 20, buyback_burn: 0, minutes: "m", ...o });
  for (const k of [0, 1, 2, 3]) {
    const exact = Array.from({ length: k }, (_, i) => `reply ${i}`);
    assert.deepEqual(parseRuling(ok({ answers: exact }), k)?.answers, exact, `${k} exact`);
    if (k > 0) assert.equal(parseRuling(ok({ answers: exact.slice(1) }), k), null, `${k} short`);
    assert.deepEqual(parseRuling(ok({ answers: ["a", "b", "c", 4, null] }), k)?.answers, ["a", "b", "c"].slice(0, k), `${k} extras`);
  }
  assert.ok(parseRuling('{"tax_bps":210,"endowment_share":60,"locker_share":20,"buyback_burn":0,"minutes":"quiet day"}', 0));
  assert.equal(parseRuling('{"tax_bps":210,"endowment_share":60,"locker_share":20,"buyback_burn":0,"minutes":"m"}', 1), null);
  assert.equal(parseRuling('{"tax_bps":"200","endowment_share":60,"locker_share":20,"buyback_burn":0,"minutes":"m","answers":["a"]}', 1), null);
  assert.equal(parseRuling('{"tax_bps":200.5,"endowment_share":60,"locker_share":20,"buyback_burn":0,"minutes":"m","answers":["a"]}', 1), null);
  assert.equal(parseRuling('{"tax_bps":200,"endowment_share":60,"locker_share":20,"buyback_burn":0,"answers":["a"]}', 1), null);
  assert.equal(parseRuling('{"tax_bps":200,"endowment_share":60,"locker_share":20,"buyback_burn":0,"minutes":"m","answers":[1]}', 1), null);
  assert.equal(parseRuling("[200,60,20,0]", 0), null);
  assert.equal(parseRuling("I cannot comply with that request.", 0), null);
  assert.equal(parseRuling(`Here is my ruling:\n\`\`\`json\n${ok({ answers: [] })}\n\`\`\``, 0)?.tax_bps, 210);
  assert.equal(parseRuling('{"tax_bps":99999999999999999999,"endowment_share":-5,"locker_share":0,"buyback_burn":0,"minutes":"m","answers":[]}', 0)?.tax_bps, 9223372036854775807);
  assert.equal(parseRuling('{"tax_bps":200.0,"endowment_share":60,"locker_share":20,"buyback_burn":0,"minutes":"m"}', 0)?.tax_bps, 200);
});

test("IQ ladder", () => {
  assert.equal(ladderModel(0n), null);
  assert.equal(ladderModel(YOCTO - 1n), null);
  assert.equal(ladderModel(YOCTO), "z-ai/glm-5.3-flash");
  assert.equal(ladderModel(50n * YOCTO), "deepseek-ai/DeepSeek-V4.1-Flash-1017");
  assert.equal(ladderModel(500n * YOCTO), "moonshotai/kimi-k3");
});
