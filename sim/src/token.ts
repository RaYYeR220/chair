// Exact integer model of the CHAIR token contract (contracts/token, SPEC §2–§5).
// All money is bigint: NEAR in yocto (1e-24), tokens in base units (1e-18). Every formula and
// rounding mirrors the contract; the golden tests (sim/test/golden*.test.ts) replay all three testnet
// deployments' transactions through this class and get the contract's request bytes back.
import { CFG, ONE, RULES, type LeverSet, type Rules } from "./config.ts";

export type Levers = LeverSet;
export interface Ruling {
  tax_bps: number;
  endowment_share: number;
  locker_share: number;
  buyback_burn: number; // bps of current supply
  minutes?: string;
  answers?: string[];
}
export type FallbackReason = "unsigned" | "bad_signature" | "bad_hash" | "unparseable" | "asleep" | "lapsed";

export interface Lock { owner: number; amount: bigint; days: number; weight: bigint; start: number; end: number; accStart: bigint }
/** A petition. In the queue `weight` is the weight at filing; in a brief, the weight at the meeting. */
export interface Petition { owner: number; weight: bigint; text: string; filedAt: number }
/** One row of `meeting_convened.reweighed`. */
export interface Reweighed { owner: number; filedWeight: bigint; weight: bigint; inBrief: boolean }
export interface Holder {
  near: bigint;
  tokens: bigint; // unlocked
  locked: bigint;
  claimed: bigint; // locker rewards claimed (NEAR)
  taxPaid: bigint;
  storage: bigint; // NEP-145 deposit paid at the first buy
  registered: boolean;
  lastPetitionDay: number;
}

/** One clamp, in the contract's shape: rule is bounds | step | sum | fund, or a `+` join. */
export interface Clamp { lever: string; asked: number; applied: number; rule: string }
export interface MeetingRecord {
  meeting: number;
  day: number;
  fallback: FallbackReason | null;
  requested: Ruling | null;
  applied: Levers & { buyback_burn: number }; // buyback_burn: effective bps after the fund limit
  clamps: Clamp[];
  buybackTokens: bigint;
  buybackCost: bigint;
  rewardsPaid: bigint;
  endowmentSent: bigint;
}

export const D = ONE;
const TWO_D2 = 2n * ONE * ONE;
const ceilDiv = (a: bigint, b: bigint) => (a <= 0n ? 0n : (a + b - 1n) / b);
const clampN = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
export const bpsCeil = (amount: bigint, bps: number) => ceilDiv(amount * BigInt(bps), 10000n);

export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("isqrt of negative");
  if (n < 2n) return n;
  // Newton from an over-estimate converges down to ⌊√n⌋.
  let x = BigInt(Math.ceil(Math.sqrt(Number(n)) * (1 + 1e-9))) + 1n;
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) break;
    x = y;
  }
  while ((x + 1n) * (x + 1n) <= n) x += 1n;
  while (x * x > n) x -= 1n;
  return x;
}

/** 2·D²·∫₀ˢ p, exact: 2·p0·D·s + k·s². */
export function N(s: bigint): bigint { return 2n * CFG.p0 * D * s + CFG.k * s * s; }
/** R(s) = ⌈∫₀ˢ p⌉ yocto: the reserve requirement. The contract's reserve always equals R(sold). */
export function R(s: bigint): bigint { return ceilDiv(N(s), TWO_D2); }
/** Spot price p(s) = p0 + ⌊k·s/D⌋, yocto per whole token. */
export function priceAt(s: bigint): bigint { return CFG.p0 + (CFG.k * s) / D; }
/** NEAR to buy Δ at s: R(s+Δ) − R(s). */
export function buyCost(s: bigint, delta: bigint): bigint { return R(s + delta) - R(s); }
/** NEAR returned for selling Δ at s: R(s) − R(s−Δ). */
export function sellProceeds(s: bigint, delta: bigint): bigint { return R(s) - R(s - delta); }
/** Largest Δ with R(s+Δ) ≤ R(s) + budget, and its cost (the contract's `max_buy`). */
export function maxBuy(s: bigint, budget: bigint): [bigint, bigint] {
  if (budget < 0n) return [0n, 0n];
  const T = (R(s) + budget) * TWO_D2; // R(x) ≤ L ⇔ N(x) ≤ L·2D²
  const b = 2n * CFG.p0 * D;
  let x = CFG.k > 0n ? (isqrt(b * b + 4n * CFG.k * T) - b) / (2n * CFG.k) : T / b;
  while (x > s && N(x) > T) x -= 1n;
  while (N(x + 1n) <= T) x += 1n;
  if (x <= s) return [0n, 0n];
  return [x - s, buyCost(s, x - s)];
}
export const maxBuyFor = (s: bigint, budget: bigint) => maxBuy(s, budget)[0];

/** The contract's `clamp_lever`: bounds and per-meeting step, recorded as one clamp. */
function clampLever(lever: string, asked: number, current: number, b: { min: number; max: number; max_step: number }, out: Clamp[]): number {
  const lo = Math.max(b.min, current - b.max_step);
  const hi = Math.min(b.max, current + b.max_step);
  let applied: number, rule: string;
  if (asked > hi) { applied = hi; rule = asked > b.max && hi === b.max ? "bounds" : "step"; }
  else if (asked < lo) { applied = lo; rule = asked < b.min && lo === b.min ? "bounds" : "step"; }
  else return asked;
  out.push({ lever, asked, applied, rule });
  return applied;
}

/** The constitution (`clamp_ruling`): tax, endowment, locker (then the share sum), buyback. Pure. */
export function clampRuling(r: Ruling, prev: Levers, rules: Rules = RULES): { levers: Levers; buyback_burn: number; clamps: Clamp[] } {
  const clamps: Clamp[] = [];
  const tax_bps = clampLever("tax_bps", r.tax_bps, prev.tax_bps, rules.tax, clamps);
  const endowment_share = clampLever("endowment_share", r.endowment_share, prev.endowment_share, rules.endowment, clamps);
  let locker_share = clampLever("locker_share", r.locker_share, prev.locker_share, rules.locker, clamps);
  if (endowment_share + locker_share > 100) {
    const applied = 100 - endowment_share;
    const c = clamps.find((x) => x.lever === "locker_share");
    if (c) { c.applied = applied; c.rule = `${c.rule}+sum`; }
    else clamps.push({ lever: "locker_share", asked: r.locker_share, applied, rule: "sum" });
    locker_share = applied;
  }
  let bb = r.buyback_burn;
  if (bb > rules.buybackMaxBps || bb < 0) {
    bb = clampN(bb, 0, rules.buybackMaxBps);
    clamps.push({ lever: "buyback_burn", asked: r.buyback_burn, applied: bb, rule: "bounds" });
  }
  return { levers: { tax_bps, endowment_share, locker_share }, buyback_burn: bb, clamps };
}

/** The fallback rule: tax moves 10 bps toward 200, everything else holds, no buyback. */
export function fallbackLevers(prev: Levers, rules: Rules = RULES): Levers {
  const t = rules.fallbackTaxTarget, st = rules.fallbackTaxStep;
  const tax = prev.tax_bps > t ? prev.tax_bps - Math.min(prev.tax_bps - t, st) : prev.tax_bps + Math.min(t - prev.tax_bps, st);
  return { ...prev, tax_bps: tax };
}
export const fallbackRuling = (prev: Levers, rules: Rules = RULES): Ruling => ({ ...fallbackLevers(prev, rules), buyback_burn: 0 });

/** The IQ ladder: the highest tier the reported endowment reaches; null = asleep. */
export function ladderModel(endowmentReported: bigint): string | null {
  let m: string | null = null;
  for (const r of CFG.ladder) if (endowmentReported >= r.min) m = r.model;
  return m;
}

export const MAX_LOCKS = 8;

export class Chair {
  s = 0n; // sold
  supply = 0n;
  burned = 0n;
  reserve = 0n;
  buybackFund = 0n;
  lockerPool = 0n;
  lockerOwed = 0n;
  endowmentPending = 0n;
  brain = 0n; // endowment sent to the brain (it stakes all of it)
  brainReported = 0n; // what the brain last reported
  levers: Levers;
  rules: Rules;
  acc = 0n; // reward per weight, scaled by rewardScale
  locks: Lock[] = [];
  petitions: Petition[] = []; // the queue for the next meeting: at most 8, one per account, heaviest at filing first
  petitionsFiled = 0;
  private filedSeq = 0; // filing order (the contract's filed_at)
  volBuy = 0n; // curve amounts traded today (the brief's 24 h window on a daily grid)
  volSell = 0n;
  day = 0;
  meeting = 0;
  lastRewardsPaid = 0n;
  taxCollected = 0n;
  holders = new Map<number, Holder>();
  names = new Map<number, string>();

  constructor(opts: { rules?: Rules; launch?: Levers } = {}) {
    this.rules = opts.rules ?? RULES;
    this.levers = { ...(opts.launch ?? CFG.launch) };
  }

  holder(id: number): Holder {
    let h = this.holders.get(id);
    if (!h) {
      h = { near: 0n, tokens: 0n, locked: 0n, claimed: 0n, taxPaid: 0n, storage: 0n, registered: false, lastPetitionDay: -1 };
      this.holders.set(id, h);
    }
    return h;
  }

  /** NEAR account id shown as a petition's `from`. */
  nameOf(id: number): string { return this.names.get(id) ?? `holder-${String(id).padStart(3, "0")}.near`; }

  price(): bigint { return priceAt(this.s); }

  private collectTax(t: bigint) {
    const e = (t * BigInt(this.levers.endowment_share)) / 100n;
    const l = (t * BigInt(this.levers.locker_share)) / 100n;
    this.endowmentPending += e;
    this.lockerPool += l;
    this.buybackFund += t - e - l;
    this.taxCollected += t;
  }

  /** A new simulated day: the 24 h volume window rolls over, expired locks are released and claimed. */
  newDay(day: number) {
    this.day = day;
    this.volBuy = 0n;
    this.volSell = 0n;
    this.expireLocks(day);
  }

  /** `buy` with `deposit` yocto attached. Returns tokens bought (0 if the contract would refuse). */
  buy(id: number, deposit: bigint): bigint {
    const h = this.holder(id);
    if (deposit > h.near) deposit = h.near;
    let budget = deposit;
    if (!h.registered) {
      if (budget <= CFG.storageDeposit) return 0n;
      budget -= CFG.storageDeposit;
    }
    const net = (budget * 10000n) / (10000n + BigInt(this.levers.tax_bps));
    const [delta, cost] = maxBuy(this.s, net);
    if (delta <= 0n) return 0n;
    const tax = bpsCeil(cost, this.levers.tax_bps);
    if (!h.registered) { h.registered = true; h.near -= CFG.storageDeposit; h.storage = CFG.storageDeposit; }
    if (cost + tax > h.near) throw new Error("buy overspend");
    h.near -= cost + tax;
    h.tokens += delta;
    h.taxPaid += tax;
    this.reserve += cost;
    this.s += delta;
    this.supply += delta;
    this.volBuy += cost;
    this.collectTax(tax);
    return delta;
  }

  /** `sell` of `delta` unlocked tokens. Returns NEAR received after tax. */
  sell(id: number, delta: bigint): bigint {
    const h = this.holder(id);
    if (delta > h.tokens) delta = h.tokens;
    if (delta <= 0n) return 0n;
    const gross = sellProceeds(this.s, delta);
    let tax = bpsCeil(gross, this.levers.tax_bps);
    if (tax > gross) tax = gross;
    h.tokens -= delta;
    h.near += gross - tax;
    h.taxPaid += tax;
    this.reserve -= gross;
    this.s -= delta;
    this.supply -= delta;
    this.volSell += gross;
    this.collectTax(tax);
    return gross - tax;
  }

  activeLocks(id: number): Lock[] { return this.locks.filter((l) => l.owner === id); }

  lock(id: number, amount: bigint, days: number, today: number): boolean {
    if (!CFG.lockDays.includes(days)) throw new Error(`bad lock days ${days}`);
    const h = this.holder(id);
    if (amount > h.tokens) amount = h.tokens;
    if (amount <= 0n) return false;
    if (this.activeLocks(id).length >= MAX_LOCKS) return false;
    h.tokens -= amount;
    h.locked += amount;
    this.locks.push({ owner: id, amount, days, weight: amount * BigInt(days), start: today, end: today + days, accStart: this.acc });
    return true;
  }

  lockReward(l: Lock): bigint { return (l.weight * (this.acc - l.accStart)) / CFG.rewardScale; }

  /** Releases locks whose term has ended; the holder claims what they earned. */
  expireLocks(today: number) {
    const keep: Lock[] = [];
    for (const l of this.locks) {
      if (l.end <= today) {
        const h = this.holder(l.owner);
        const r = this.lockReward(l);
        h.locked -= l.amount;
        h.tokens += l.amount;
        h.near += r;
        h.claimed += r;
        this.lockerOwed -= r;
      } else keep.push(l);
    }
    this.locks = keep;
  }

  /** Claimed plus earned-but-unclaimed locker rewards of a holder. */
  rewardsOf(id: number): bigint {
    let r = this.holder(id).claimed;
    for (const l of this.locks) if (l.owner === id) r += this.lockReward(l);
    return r;
  }

  weightOf(id: number): bigint { return this.activeLocks(id).reduce((a, l) => a + l.weight, 0n); }
  /**
   * `active_weight` at the meeting held at the end of `day`: the holder's locks whose end is after
   * that day. The sim holds one meeting per day, after the agents act, so a petition filed on `day`
   * is for that day's meeting: this is both the filing weight (a lock that runs past the next
   * meeting) and the weight `convene` recomputes.
   */
  weightAt(id: number, day: number): bigint {
    return this.locks.reduce((a, l) => (l.owner === id && l.end > day ? a + l.weight : a), 0n);
  }
  totalWeight(): bigint { return this.locks.reduce((a, l) => a + l.weight, 0n); }
  totalLocked(): bigint { return this.locks.reduce((a, l) => a + l.amount, 0n); }

  /**
   * `petition`: only with a lock that runs past the next meeting, one per day, fee burned from
   * unlocked tokens. Queued by that weight: at most 8, heaviest first, one per account (a newer
   * petition replaces the older); a lighter one past the 8th is filed and burned but not queued.
   */
  petition(id: number, text: string, today = this.day): boolean {
    const chars = [...text].length;
    if (chars === 0 || chars > CFG.petitionMaxChars) throw new Error("petition must be 1-280 characters");
    if (/\p{Cc}/u.test(text)) throw new Error("petition has control characters");
    const w = this.weightAt(id, today);
    if (w === 0n) return false;
    const h = this.holder(id);
    if (h.lastPetitionDay >= 0 && today < h.lastPetitionDay + 1) return false;
    if (h.tokens < CFG.petitionFee) return false;
    h.tokens -= CFG.petitionFee;
    h.lastPetitionDay = today;
    this.supply -= CFG.petitionFee;
    this.burned += CFG.petitionFee;
    this.petitionsFiled += 1;
    const p: Petition = { owner: id, weight: w, text, filedAt: this.filedSeq++ };
    this.petitions = this.petitions.filter((q) => q.owner !== id);
    let pos = this.petitions.findIndex((q) => q.weight < w);
    if (pos < 0) pos = this.petitions.length;
    if (pos < CFG.petitionQueueMax) {
      this.petitions.splice(pos, 0, p);
      this.petitions.length = Math.min(this.petitions.length, CFG.petitionQueueMax);
    }
    return true;
  }

  /**
   * The brief's petitions (`brief_petitions`) for the meeting at the end of `day`: every queued
   * petitioner reweighed from their locks still active then, zeros dropped, the three heaviest kept
   * (earlier filing wins ties).
   */
  briefPetitions(day = this.day): Petition[] {
    return this.petitions
      .map((p) => ({ ...p, weight: this.weightAt(p.owner, day) }))
      .filter((p) => p.weight > 0n)
      .sort((a, b) => (a.weight === b.weight ? a.filedAt - b.filedAt : b.weight > a.weight ? 1 : -1))
      .slice(0, CFG.petitionTopN);
  }
  topPetitions(): Petition[] { return this.briefPetitions(); }

  /** `meeting_convened.reweighed`: every queued petition, its weight at filing and now, and whether it made the brief. */
  reweighed(day = this.day): Reweighed[] {
    const brief = new Set(this.briefPetitions(day).map((p) => p.owner));
    return this.petitions.map((p) => ({ owner: p.owner, filedWeight: p.weight, weight: this.weightAt(p.owner, day), inBrief: brief.has(p.owner) }));
  }

  /** The brain reports its staked endowment; the IQ ladder reads this. */
  reportEndowment(staked: bigint) { this.brainReported = staked; }

  /** Buyback for `bps` of supply: [tokens, cost, fundLimited] (the contract's `plan_buyback`). */
  planBuyback(bps: number): [bigint, bigint, boolean] {
    if (bps === 0 || this.supply === 0n) return [0n, 0n, false];
    const target = (this.supply * BigInt(bps)) / 10000n;
    const cost = buyCost(this.s, target);
    if (cost <= this.buybackFund) return [target, cost, false];
    const [t, c] = maxBuy(this.s, this.buybackFund);
    return [t, c, true];
  }

  /** The meeting's locker payout: the whole pool, per weight, into the accumulator. */
  private payLockers(): bigint {
    const W = this.totalWeight();
    if (this.lockerPool === 0n || W === 0n) return 0n;
    const inc = (this.lockerPool * CFG.rewardScale) / W;
    if (inc === 0n) return 0n;
    this.acc += inc;
    const paid = this.lockerPool;
    this.lockerOwed += paid;
    this.lockerPool = 0n;
    return paid;
  }

  /** Applies a meeting (the contract's `hold`): levers, buyback-and-burn, locker payout, endowment. */
  hold(day: number, ruling: Ruling | null, fallback: FallbackReason | null): MeetingRecord {
    this.meeting += 1;
    const prev = { ...this.levers };
    let levers: Levers, bbBps: number, clamps: Clamp[];
    if (ruling) ({ levers, buyback_burn: bbBps, clamps } = clampRuling(ruling, prev, this.rules));
    else { levers = fallbackLevers(prev, this.rules); bbBps = 0; clamps = []; }
    this.levers = levers;

    const [bbTokens, bbCost, limited] = this.planBuyback(bbBps);
    let effBps = bbBps;
    if (limited) {
      const b = (bbTokens * 10000n) / this.supply; // bps_of_supply, floor
      effBps = Number(b > 10000n ? 10000n : b);
      const c = clamps.find((x) => x.lever === "buyback_burn");
      if (c) { c.applied = effBps; c.rule = `${c.rule}+fund`; }
      else clamps.push({ lever: "buyback_burn", asked: bbBps, applied: effBps, rule: "fund" });
    }
    if (bbTokens > 0n) {
      this.buybackFund -= bbCost;
      this.reserve += bbCost;
      this.s += bbTokens; // bought on the curve...
      this.burned += bbTokens; // ...and burned at once: supply unchanged
    }

    const paid = this.payLockers();
    this.lastRewardsPaid = paid;
    const sent = this.endowmentPending;
    this.brain += sent;
    this.endowmentPending = 0n;
    this.petitions = [];
    this.petitionsFiled = 0;
    return {
      meeting: this.meeting, day, fallback, requested: ruling,
      applied: { ...levers, buyback_burn: effBps }, clamps, buybackTokens: bbTokens, buybackCost: bbCost, rewardsPaid: paid, endowmentSent: sent,
    };
  }

  /** Floor = reserve per token in existence, yocto per whole token. */
  floor(): bigint { return this.supply > 0n ? (this.reserve * ONE) / this.supply : priceAt(0n); }

  /** Invariants that must hold after every operation. */
  checkInvariants() {
    if (this.reserve !== R(this.s)) throw new Error("reserve != R(s)");
    if (this.supply + this.burned !== this.s) throw new Error("supply + burned != s");
    let held = 0n;
    for (const h of this.holders.values()) held += h.tokens + h.locked;
    if (held !== this.supply) throw new Error(`holder tokens ${held} != supply ${this.supply}`);
    let owed = 0n;
    for (const l of this.locks) owed += this.lockReward(l);
    if (owed > this.lockerOwed) throw new Error("locker rewards exceed locker_owed");
  }
}

export const toNear = (y: bigint) => Number(y) / 1e24;
export const toTokens = (b: bigint) => Number(b) / Number(ONE);
export const nearToYocto = (x: number) => BigInt(Math.floor(x * 1e6)) * (10n ** 24n / 1000000n);
