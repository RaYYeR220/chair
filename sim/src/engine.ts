import { CFG, RULES, YOCTO, type Rules } from "./config.ts";
import { u } from "./rng.ts";
import { Chair, type Clamp, type MeetingRecord, priceAt, sellProceeds, bpsCeil, toNear, toTokens } from "./token.ts";
import { type Agent, type MarketView, act, population } from "./agents.ts";
import { DAYS, type Scenario } from "./scenarios.ts";
import type { Decision, Policy } from "./policies.ts";

export interface Series {
  supply: number[]; s: number[]; burned: number[]; reserve: number[]; price: number[]; floor: number[];
  endowment: number[]; buybackFund: number[]; lockerPool: number[];
  tax: number[]; endowShare: number[]; lockerShare: number[]; buybackBps: number[]; buybackNear: number[];
  volBuy: number[]; volSell: number[]; locked: number[]; rewards: number[]; tier: (string | null)[];
}

export interface Summary {
  finalSupply: number; minSupply: number; finalPrice: number; finalFloor: number; floorGainPct: number;
  maxDrawdownPct: number; volatilityPct: number; finalEndowment: number; totalVolume: number; taxCollected: number;
  buybackSpent: number; idleBuybackFund: number; lockerRewards: number;
  whalePnl: number; whaleShareOfGainsPct: number; whaleShareOfRewardsPct: number; whaleRewards: number; whaleTakePct: number;
  lockerShareMean: number; lockerShareMeanD3to32: number; endowShareMean: number; taxMean: number;
  lockerAtMaxMeetings: number; lockerAskedAboveMax: number;
  holderPnl: number; clampMeetings: number; clampEvents: number; clampBoundOrSum: number; fundLimited: number;
  fallbacks: number; fallbackReasons: Record<string, number>; tiers: Record<string, number>;
}

export interface MeetingLog {
  day: number; meeting: number; tier: string | null; fallback: string | null;
  requested: MeetingRecord["requested"]; applied: MeetingRecord["applied"]; clamps: Clamp[];
  seed?: string; brief?: string; content?: string; requestSha256?: string; cached?: boolean;
}

export interface RunResult {
  scenario: string; policy: string; seed: number; variant: string; lockerMax: number;
  series: Series; summary: Summary; meetings: MeetingLog[];
  llm?: { promptTokens: number; completionTokens: number; usd: number; calls: number; cached: number };
}

function view(day: number, c: Chair, closes: number[], scn: Scenario, seed: number): MarketView {
  const price = toNear(c.price());
  const at = (k: number) => closes[Math.max(0, closes.length - k)] ?? price;
  const hi10 = Math.max(price, ...closes.slice(-10));
  const lockedVal = toTokens(c.totalLocked()) * price;
  const apr = lockedVal > 0 ? (toNear(c.lastRewardsPaid) / lockedVal) * 365 : 5;
  return {
    day, price,
    ret3: closes.length ? price / at(3) - 1 : 0,
    dd10: 1 - price / hi10,
    floorRatio: toNear(c.floor()) / price,
    tax: c.levers.tax_bps / 10000,
    lockerApr: Math.min(5, apr),
    sentiment: scn.sentiment(day, seed * 1000 + scn.id),
    activity: scn.activity(day),
  };
}

const isLeverClamp = (k: Clamp) => k.rule !== "fund";
const isBoundOrSum = (k: Clamp) => /bounds|sum/.test(k.rule);

export async function runSim(scn: Scenario, policy: Policy, seed: number, opts: { rules?: Rules; variant?: string } = {}): Promise<RunResult> {
  const rules = opts.rules ?? RULES;
  const c = new Chair({ rules });
  const agents: Agent[] = population(seed, scn);
  for (const a of agents) c.holder(a.id).near = BigInt(Math.floor(a.budget * 1e6)) * (YOCTO / 1000000n);
  const S: Series = { supply: [], s: [], burned: [], reserve: [], price: [], floor: [], endowment: [], buybackFund: [], lockerPool: [], tax: [], endowShare: [], lockerShare: [], buybackBps: [], buybackNear: [], volBuy: [], volSell: [], locked: [], rewards: [], tier: [] };
  const meetings: MeetingLog[] = [];
  const closes: number[] = [];
  const llmAcc = { promptTokens: 0, completionTokens: 0, usd: 0, calls: 0, cached: 0 };
  const whale = agents.find((a) => a.type === "whale")!;

  for (let day = 0; day < DAYS; day++) {
    c.newDay(day);
    const mv = view(day, c, closes, scn, seed);
    const order = agents.filter((a) => a.join <= day).sort((x, y) => u(seed, scn.id, day, x.id, 77) - u(seed, scn.id, day, y.id, 77));
    for (const a of order) act({ chair: c, mv, seed, scn }, a);

    const volBuy = toNear(c.volBuy), volSell = toNear(c.volSell);
    const dec: Decision = await policy.decide(c, day, { scenario: scn.key, seed });
    const rec = c.hold(day, dec.ruling, dec.reason === "fixed_rule" ? null : dec.reason);
    c.reportEndowment(c.brain); // the brain stakes what it received and reports it before the next meeting
    c.checkInvariants();
    if (dec.llm) {
      llmAcc.promptTokens += dec.llm.promptTokens; llmAcc.completionTokens += dec.llm.completionTokens; llmAcc.usd += dec.llm.usd;
      if (dec.llm.cached) llmAcc.cached++; else llmAcc.calls++;
    }
    const tier = isLlm(policy) ? dec.model ?? null : null;
    meetings.push({
      day, meeting: rec.meeting, tier, fallback: dec.reason, requested: rec.requested, applied: rec.applied, clamps: rec.clamps,
      ...(dec.seed ? { seed: dec.seed } : {}), ...(dec.brief ? { brief: dec.brief } : {}), ...(dec.llm ? { content: dec.llm.content, requestSha256: dec.llm.requestSha256, cached: dec.llm.cached } : {}),
    });

    const price = toNear(c.price());
    closes.push(price);
    S.supply.push(toTokens(c.supply)); S.s.push(toTokens(c.s)); S.burned.push(toTokens(c.burned));
    S.reserve.push(toNear(c.reserve)); S.price.push(price); S.floor.push(toNear(c.floor()));
    S.endowment.push(toNear(c.brain)); S.buybackFund.push(toNear(c.buybackFund)); S.lockerPool.push(toNear(c.lockerPool));
    S.tax.push(c.levers.tax_bps); S.endowShare.push(c.levers.endowment_share); S.lockerShare.push(c.levers.locker_share);
    S.buybackBps.push(rec.applied.buyback_burn); S.buybackNear.push(toNear(rec.buybackCost));
    S.volBuy.push(volBuy); S.volSell.push(volSell); S.locked.push(toTokens(c.totalLocked())); S.rewards.push(toNear(rec.rewardsPaid));
    S.tier.push(tier);
  }

  // ---- summary ----
  let peak = 0, mdd = 0;
  for (const p of S.price) { peak = Math.max(peak, p); mdd = Math.max(mdd, 1 - p / peak); }
  // Daily volatility after the launch ramp (days 10–59): the first days are price discovery from p0.
  const rets = S.price.slice(VOL_FROM).map((p, i) => Math.log(p / S.price[VOL_FROM - 1 + i]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const vol = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1));

  // PnL: NEAR now + unclaimed locker rewards + what the holder would get selling its whole bag
  // alone right now, minus its starting NEAR. The storage deposit counts as spent.
  const pnl = (a: Agent) => {
    const h = c.holder(a.id);
    const bag = h.tokens + h.locked;
    const gross = bag > 0n ? sellProceeds(c.s, bag) : 0n;
    const net = gross - bpsCeil(gross, c.levers.tax_bps);
    const unclaimed = c.rewardsOf(a.id) - h.claimed;
    return toNear(h.near + net + unclaimed) - a.budget;
  };
  const pnls = agents.map((a) => ({ a, p: pnl(a) }));
  const gains = pnls.reduce((s, x) => s + Math.max(0, x.p), 0);
  const whalePnl = pnls.find((x) => x.a === whale)!.p;
  const totalRewards = agents.reduce((s, a) => s + toNear(c.rewardsOf(a.id)), 0);
  const whaleRewards = toNear(c.rewardsOf(whale.id));
  const taxCollected = toNear(c.taxCollected);
  const fallbackReasons: Record<string, number> = {};
  const tiers: Record<string, number> = {};
  for (const m of meetings) {
    if (m.fallback) fallbackReasons[m.fallback] = (fallbackReasons[m.fallback] ?? 0) + 1;
    if (isLlm(policy)) tiers[m.tier ?? "asleep"] = (tiers[m.tier ?? "asleep"] ?? 0) + 1;
  }
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const summary: Summary = {
    finalSupply: S.supply.at(-1)!, minSupply: Math.min(...S.supply), finalPrice: S.price.at(-1)!, finalFloor: S.floor.at(-1)!,
    floorGainPct: 100 * (S.floor.at(-1)! / Math.max(...S.floor.slice(0, 1)) - 1),
    maxDrawdownPct: 100 * mdd, volatilityPct: 100 * vol, finalEndowment: S.endowment.at(-1)!,
    totalVolume: S.volBuy.reduce((a, b) => a + b, 0) + S.volSell.reduce((a, b) => a + b, 0), taxCollected,
    buybackSpent: S.buybackNear.reduce((a, b) => a + b, 0), idleBuybackFund: S.buybackFund.at(-1)!, lockerRewards: totalRewards,
    whalePnl, whaleShareOfGainsPct: gains > 0 ? (100 * Math.max(0, whalePnl)) / gains : 0,
    whaleShareOfRewardsPct: totalRewards > 0 ? (100 * whaleRewards) / totalRewards : 0,
    whaleRewards, whaleTakePct: taxCollected > 0 ? (100 * whaleRewards) / taxCollected : 0,
    lockerShareMean: avg(S.lockerShare), lockerShareMeanD3to32: avg(S.lockerShare.slice(3, 33)),
    endowShareMean: avg(S.endowShare), taxMean: avg(S.tax),
    lockerAtMaxMeetings: S.lockerShare.filter((x) => x === rules.locker.max).length,
    lockerAskedAboveMax: meetings.filter((m) => m.requested && m.requested.locker_share > rules.locker.max).length,
    holderPnl: pnls.reduce((s, x) => s + x.p, 0),
    clampMeetings: meetings.filter((m) => m.clamps.some(isLeverClamp)).length,
    clampEvents: meetings.reduce((s, m) => s + m.clamps.filter(isLeverClamp).length, 0),
    clampBoundOrSum: meetings.filter((m) => m.clamps.some(isBoundOrSum)).length,
    fundLimited: meetings.filter((m) => m.clamps.some((k) => k.rule.includes("fund"))).length,
    fallbacks: meetings.filter((m) => m.fallback).length, fallbackReasons, tiers,
  };
  return {
    scenario: scn.key, policy: policy.key, seed, variant: opts.variant ?? CFG.tokenVersion, lockerMax: rules.locker.max,
    series: S, summary, meetings, ...(isLlm(policy) ? { llm: llmAcc } : {}),
  };
}
const isLlm = (p: Policy) => p.key.startsWith("llm");

export const VOL_FROM = 10;
export const LAUNCH_PRICE = toNear(priceAt(0n));
export const PARAMS = CFG;
