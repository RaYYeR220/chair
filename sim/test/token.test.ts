import { test } from "node:test";
import assert from "node:assert/strict";
import { CFG, ONE, YOCTO } from "../src/config.ts";
import { Chair, N, buyCost, sellProceeds, maxBuyFor, isqrt, clampRuling, fallbackRuling, ladderModel, priceAt } from "../src/token.ts";
import { u } from "../src/rng.ts";

const D = 2n * ONE * ONE;

test("isqrt is exact", () => {
  for (const n of [0n, 1n, 2n, 15n, 16n, 17n, 10n ** 40n, 10n ** 70n + 12345n, 4n * 10n ** 80n - 1n]) {
    const r = isqrt(n);
    assert.ok(r * r <= n && (r + 1n) * (r + 1n) > n, `isqrt(${n})`);
  }
});

test("buy then sell never returns more than paid (rounding favours the reserve)", () => {
  let s = 123456789n * ONE;
  for (let i = 0; i < 200; i++) {
    const delta = BigInt(Math.floor(u(7, i) * 1e9)) * ONE + BigInt(Math.floor(u(8, i) * 1e9));
    const c = buyCost(s, delta);
    const p = sellProceeds(s + delta, delta);
    assert.ok(p <= c);
    assert.ok(c - p <= 1n);
    s += delta;
  }
});

test("maxBuyFor returns the largest affordable delta", () => {
  for (let i = 0; i < 100; i++) {
    const s = BigInt(Math.floor(u(1, i) * 1e9)) * ONE;
    const budget = BigInt(Math.floor(u(2, i) * 1e6)) * (YOCTO / 1000n);
    const d = maxBuyFor(s, budget);
    assert.ok(buyCost(s, d) <= budget);
    assert.ok(buyCost(s, d + 1n) > budget);
  }
});

test("reserve stays >= curve integral and supply + burned == s through random activity", () => {
  const c = new Chair();
  for (let id = 0; id < 20; id++) c.holder(id).near = 1000n * YOCTO;
  for (let day = 0; day < 30; day++) {
    c.expireLocks(day);
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
    c.checkInvariants();
    assert.ok(c.levers.tax_bps >= CFG.tax.min && c.levers.tax_bps <= CFG.tax.max);
    assert.ok(c.levers.endowment_share + c.levers.locker_share <= 100);
  }
  assert.ok(c.reserve * D >= N(c.s));
});

test("buyback-and-burn leaves supply unchanged, raises s, reserve and the floor", () => {
  const c = new Chair();
  c.holder(1).near = 5000n * YOCTO;
  c.buy(1, 4000n * YOCTO);
  c.hold(0, null, "asleep");
  const before = { s: c.s, supply: c.supply, reserve: c.reserve, floor: c.floor(), price: c.price(), fund: c.buybackFund };
  assert.ok(before.fund > 0n);
  const rec = c.hold(1, { tax_bps: 300, endowment_share: 60, locker_share: 10, buyback_burn: 50 }, null);
  assert.ok(rec.buybackTokens > 0n);
  assert.equal(c.supply, before.supply);
  assert.ok(c.s > before.s && c.reserve > before.reserve && c.floor() > before.floor && c.price() > before.price);
  assert.equal(c.reserve - before.reserve, rec.buybackCost);
  c.checkInvariants();
});

test("constitution clamps bounds, steps and the share sum", () => {
  const prev = { tax_bps: 200, endowment_share: 60, locker_share: 40 };
  const r = clampRuling({ tax_bps: 1000, endowment_share: 75, locker_share: 50, buyback_burn: 500 }, prev);
  assert.deepEqual(r.levers, { tax_bps: 250, endowment_share: 70, locker_share: 30 });
  assert.equal(r.buyback_burn, CFG.buybackMaxBps);
  const kinds = r.clamps.map((x) => `${x.field}:${x.kind}`).sort();
  assert.deepEqual(kinds, ["buyback_burn:bound", "endowment_share:step", "locker_share:sum", "tax_bps:bound"].sort());
  const ok = clampRuling({ tax_bps: 180, endowment_share: 55, locker_share: 35, buyback_burn: 10 }, prev);
  assert.equal(ok.clamps.length, 0);
});

test("fallback moves tax 10 bps toward 200 and holds the rest", () => {
  assert.deepEqual(fallbackRuling({ tax_bps: 300, endowment_share: 60, locker_share: 10 }), { tax_bps: 290, endowment_share: 60, locker_share: 10, buyback_burn: 0 });
  assert.equal(fallbackRuling({ tax_bps: 195, endowment_share: 60, locker_share: 10 }).tax_bps, 200);
  assert.equal(fallbackRuling({ tax_bps: 200, endowment_share: 60, locker_share: 10 }).tax_bps, 200);
});

test("IQ ladder", () => {
  assert.equal(ladderModel(0n), null);
  assert.equal(ladderModel(YOCTO - 1n), null);
  assert.equal(ladderModel(YOCTO), "z-ai/glm-5.3-flash");
  assert.equal(ladderModel(50n * YOCTO), "deepseek-ai/DeepSeek-V4.1-Flash-1017");
  assert.equal(ladderModel(500n * YOCTO), "moonshotai/kimi-k3");
});

test("price is linear in s", () => {
  assert.equal(priceAt(0n), CFG.p0);
  assert.equal(priceAt(1000n * ONE) - priceAt(0n), 1000n * CFG.k);
});
