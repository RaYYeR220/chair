// Exact integer model of the CHAIR token contract (SPEC §2–§5).
// All money is bigint: NEAR in yocto (1e-24), tokens in base units (1e-18).
import { CFG, ONE, YOCTO, type Bound } from "./config.ts";

export interface Levers { tax_bps: number; endowment_share: number; locker_share: number }
export interface Ruling {
  tax_bps: number;
  endowment_share: number;
  locker_share: number;
  buyback_burn: number; // bps of current supply
  minutes?: string;
  answers?: string[];
}
export type FallbackReason = "unsigned" | "bad_signature" | "bad_hash" | "unparseable" | "asleep";

export interface Lock { owner: number; amount: bigint; days: number; weight: bigint; start: number; end: number }
export interface Petition { owner: number; weight: bigint; text: string; order: number }
export interface Holder { near: bigint; tokens: bigint; locked: bigint; rewards: bigint; taxPaid: bigint }

export interface ClampEvent { field: string; requested: number; applied: number; kind: "bound" | "step" | "sum" | "fund" }
export interface MeetingRecord {
  meeting: number;
  day: number;
  fallback: FallbackReason | null;
  requested: Ruling | null;
  applied: Levers & { buyback_burn: number };
  clamps: ClampEvent[];
  buybackTokens: bigint;
  buybackCost: bigint;
  rewardsPaid: bigint;
}

const D = 2n * ONE * ONE;
const ceilDiv = (a: bigint, b: bigint) => (a <= 0n ? 0n : (a + b - 1n) / b);
const clampN = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

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

/** 2·ONE²·∫₀ˢ p, an exact integer. p(s) = p0 + k·s/ONE yocto per whole token. */
export function N(s: bigint): bigint { return 2n * CFG.p0 * s * ONE + CFG.k * s * s; }
/** ∫₀ˢ p rounded down, in yocto. */
export function F(s: bigint): bigint { return N(s) / D; }
/** Spot price in yocto per whole token (floored). */
export function priceAt(s: bigint): bigint { return CFG.p0 + (CFG.k * s) / ONE; }
/** Curve cost of buying Δ at s: ⌈∫ p over [s, s+Δ]⌉ (rounded in the reserve's favour). */
export function buyCost(s: bigint, delta: bigint): bigint { return ceilDiv(N(s + delta) - N(s), D); }
/** Curve proceeds of selling Δ at s: ⌊∫ p over [s−Δ, s]⌋ (rounded in the reserve's favour). */
export function sellProceeds(s: bigint, delta: bigint): bigint { return (N(s) - N(s - delta)) / D; }
/** Largest Δ with buyCost(s, Δ) ≤ budget. */
export function maxBuyFor(s: bigint, budget: bigint): bigint {
  if (budget <= 0n) return 0n;
  const R = N(s) + budget * D; // ⌈a/D⌉ ≤ c ⇔ a ≤ c·D
  const b = 2n * CFG.p0 * ONE;
  let x = (isqrt(b * b + 4n * CFG.k * R) - b) / (2n * CFG.k);
  while (x > s && N(x) > R) x -= 1n;
  while (N(x + 1n) <= R) x += 1n;
  return x > s ? x - s : 0n;
}

export function clampLever(req: number, prev: number, b: Bound, field: string, out: ClampEvent[]): number {
  const inBound = clampN(req, b.min, b.max);
  const lo = Math.max(b.min, prev - b.max_step);
  const hi = Math.min(b.max, prev + b.max_step);
  const applied = clampN(req, lo, hi);
  if (applied !== req) out.push({ field, requested: req, applied, kind: inBound !== req ? "bound" : "step" });
  return applied;
}

/** The constitution (SPEC §4) applied to a ruling. Pure; the fund limit is applied at execution. */
export function clampRuling(r: Ruling, prev: Levers): { levers: Levers; buyback_burn: number; clamps: ClampEvent[] } {
  const clamps: ClampEvent[] = [];
  const tax_bps = clampLever(r.tax_bps, prev.tax_bps, CFG.tax, "tax_bps", clamps);
  const endowment_share = clampLever(r.endowment_share, prev.endowment_share, CFG.endowment, "endowment_share", clamps);
  let locker_share = clampLever(r.locker_share, prev.locker_share, CFG.locker, "locker_share", clamps);
  if (endowment_share + locker_share > 100) {
    const cut = 100 - endowment_share;
    clamps.push({ field: "locker_share", requested: r.locker_share, applied: cut, kind: "sum" });
    locker_share = cut;
  }
  const bb = clampN(r.buyback_burn, 0, CFG.buybackMaxBps);
  if (bb !== r.buyback_burn) clamps.push({ field: "buyback_burn", requested: r.buyback_burn, applied: bb, kind: "bound" });
  return { levers: { tax_bps, endowment_share, locker_share }, buyback_burn: bb, clamps };
}

/** SPEC §4 fallback: tax moves 10 bps toward 200, everything else holds, no buyback. */
export function fallbackRuling(prev: Levers): Ruling {
  const t = CFG.fallbackTaxTarget, st = CFG.fallbackTaxStep;
  const tax = prev.tax_bps > t ? Math.max(t, prev.tax_bps - st) : Math.min(t, prev.tax_bps + st);
  return { tax_bps: tax, endowment_share: prev.endowment_share, locker_share: prev.locker_share, buyback_burn: 0 };
}

export function ladderModel(endowmentReported: bigint): string | null {
  let m: string | null = null;
  for (const r of CFG.ladder) if (endowmentReported >= r.min) m = r.model;
  return m;
}

export class Chair {
  s = 0n;
  supply = 0n;
  burned = 0n;
  reserve = 0n;
  buybackFund = 0n;
  lockerPool = 0n;
  brain = 0n; // endowment held by `brain`
  brainReported = 0n; // as last reported (updated at each meeting)
  levers: Levers = { ...CFG.launch };
  locks: Lock[] = [];
  petitions: Petition[] = [];
  volBuy = 0n; // curve amounts since last meeting
  volSell = 0n;
  meeting = 0;
  lastRewardsPaid = 0n;
  holders = new Map<number, Holder>();
  taxCollected = 0n;
  private petitionOrder = 0;

  holder(id: number): Holder {
    let h = this.holders.get(id);
    if (!h) { h = { near: 0n, tokens: 0n, locked: 0n, rewards: 0n, taxPaid: 0n }; this.holders.set(id, h); }
    return h;
  }

  price(): bigint { return priceAt(this.s); }

  private taxOf(amount: bigint): bigint { return ceilDiv(amount * BigInt(this.levers.tax_bps), 10000n); }

  private splitTax(t: bigint) {
    const e = (t * BigInt(this.levers.endowment_share)) / 100n;
    const l = (t * BigInt(this.levers.locker_share)) / 100n;
    this.brain += e;
    this.lockerPool += l;
    this.buybackFund += t - e - l;
    this.taxCollected += t;
  }

  /** Spend up to `gross` yocto (curve cost + tax). Returns tokens bought. */
  buy(id: number, gross: bigint): bigint {
    const h = this.holder(id);
    if (gross > h.near) gross = h.near;
    if (gross <= 1n) return 0n;
    const net = ((gross - 1n) * 10000n) / (10000n + BigInt(this.levers.tax_bps));
    const delta = maxBuyFor(this.s, net);
    if (delta <= 0n) return 0n;
    const cost = buyCost(this.s, delta);
    const tax = this.taxOf(cost);
    if (cost + tax > gross) throw new Error("buy overspend");
    h.near -= cost + tax;
    h.tokens += delta;
    h.taxPaid += tax;
    this.reserve += cost;
    this.s += delta;
    this.supply += delta;
    this.volBuy += cost;
    this.splitTax(tax);
    return delta;
  }

  /** Sell `delta` free tokens. Returns NEAR received (after tax). */
  sell(id: number, delta: bigint): bigint {
    const h = this.holder(id);
    if (delta > h.tokens) delta = h.tokens;
    if (delta <= 0n) return 0n;
    const proceeds = sellProceeds(this.s, delta);
    const tax = this.taxOf(proceeds);
    h.tokens -= delta;
    h.near += proceeds - tax;
    h.taxPaid += tax;
    this.reserve -= proceeds;
    this.s -= delta;
    this.supply -= delta;
    this.volSell += proceeds;
    this.splitTax(tax);
    return proceeds - tax;
  }

  lock(id: number, amount: bigint, days: number, today: number): boolean {
    if (!CFG.lockDays.includes(days)) throw new Error(`bad lock days ${days}`);
    const h = this.holder(id);
    if (amount > h.tokens) amount = h.tokens;
    if (amount <= 0n) return false;
    h.tokens -= amount;
    h.locked += amount;
    this.locks.push({ owner: id, amount, days, weight: amount * BigInt(days), start: today, end: today + days });
    return true;
  }

  expireLocks(today: number) {
    const keep: Lock[] = [];
    for (const l of this.locks) {
      if (l.end <= today) { const h = this.holder(l.owner); h.locked -= l.amount; h.tokens += l.amount; }
      else keep.push(l);
    }
    this.locks = keep;
  }

  weightOf(id: number): bigint {
    let w = 0n;
    for (const l of this.locks) if (l.owner === id) w += l.weight;
    return w;
  }

  totalWeight(): bigint { return this.locks.reduce((a, l) => a + l.weight, 0n); }
  totalLocked(): bigint { return this.locks.reduce((a, l) => a + l.amount, 0n); }

  /** One petition per locker per day; the fee is burned (supply falls, s does not). */
  petition(id: number, text: string): boolean {
    if (text.length > CFG.petitionMaxChars) throw new Error("petition too long");
    const w = this.weightOf(id);
    if (w === 0n) return false;
    if (this.petitions.some((p) => p.owner === id)) return false;
    const h = this.holder(id);
    if (h.tokens < CFG.petitionFee) return false;
    h.tokens -= CFG.petitionFee;
    this.supply -= CFG.petitionFee;
    this.burned += CFG.petitionFee;
    this.petitions.push({ owner: id, weight: w, text, order: this.petitionOrder++ });
    return true;
  }

  topPetitions(): Petition[] {
    return [...this.petitions]
      .sort((a, b) => (a.weight === b.weight ? a.order - b.order : a.weight > b.weight ? -1 : 1))
      .slice(0, CFG.petitionTopN);
  }

  /** Apply a meeting: a ruling (clamped) or the fallback, then buyback, rewards, report. */
  hold(day: number, ruling: Ruling | null, fallback: FallbackReason | null): MeetingRecord {
    this.meeting += 1;
    const prev = { ...this.levers };
    const r = ruling ?? fallbackRuling(prev);
    const { levers, buyback_burn, clamps } = ruling ? clampRuling(ruling, prev) : { ...clampRuling(r, prev), clamps: [] as ClampEvent[] };
    this.levers = levers;

    // Buyback-and-burn: buy on the curve with fund NEAR (tax-exempt), then burn. s stays up.
    let bbTokens = (this.supply * BigInt(buyback_burn)) / 10000n;
    let bbCost = bbTokens > 0n ? buyCost(this.s, bbTokens) : 0n;
    if (bbCost > this.buybackFund) {
      bbTokens = maxBuyFor(this.s, this.buybackFund);
      bbCost = bbTokens > 0n ? buyCost(this.s, bbTokens) : 0n;
      if (ruling) clamps.push({ field: "buyback_burn", requested: buyback_burn, applied: Number((bbTokens * 10000n) / (this.supply || 1n)), kind: "fund" });
    }
    if (bbTokens > 0n) {
      this.buybackFund -= bbCost;
      this.reserve += bbCost;
      this.s += bbTokens; // minted to the contract...
      this.burned += bbTokens; // ...and burned: supply unchanged, s unchanged by the burn
    }

    // Locker rewards: whole pool, pro rata to weight of locks active at this meeting.
    let paid = 0n;
    const W = this.totalWeight();
    if (W > 0n && this.lockerPool > 0n) {
      const pool = this.lockerPool;
      for (const l of this.locks) {
        const amt = (pool * l.weight) / W;
        if (amt > 0n) { const h = this.holder(l.owner); h.near += amt; h.rewards += amt; paid += amt; }
      }
      this.lockerPool -= paid;
    }
    this.lastRewardsPaid = paid;
    this.brainReported = this.brain;
    this.volBuy = 0n;
    this.volSell = 0n;
    this.petitions = [];
    return {
      meeting: this.meeting, day, fallback, requested: ruling,
      applied: { ...levers, buyback_burn }, clamps, buybackTokens: bbTokens, buybackCost: bbCost, rewardsPaid: paid,
    };
  }

  /** Floor = reserve per token in existence, yocto per whole token. */
  floor(): bigint { return this.supply > 0n ? (this.reserve * ONE) / this.supply : priceAt(0n); }

  /** Invariants that must hold after every operation. */
  checkInvariants() {
    if (this.reserve * D < N(this.s)) throw new Error("reserve below curve integral");
    if (this.supply + this.burned !== this.s) throw new Error("supply + burned != s");
    let held = 0n;
    for (const h of this.holders.values()) held += h.tokens + h.locked;
    if (held !== this.supply) throw new Error(`holder tokens ${held} != supply ${this.supply}`);
  }
}

export const toNear = (y: bigint) => Number(y) / 1e24;
export const toTokens = (b: bigint) => Number(b) / Number(ONE);
export const nearToYocto = (x: number) => BigInt(Math.floor(x * 1e6)) * (YOCTO / 1000000n);
