import "server-only";

/**
 * Per-IP cooldowns and a per-instance mutex. In-memory: on a serverless host
 * each instance keeps its own, so the on-chain caps (the relay's balance
 * floor and its pool of petitioner accounts, each limited by the contract to
 * one petition a day) are the hard limits; these only slow a single visitor.
 */

export function clientIp(req: Request): string {
  const h = req.headers;
  const fwd = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || h.get("x-real-ip") || h.get("cf-connecting-ip") || "local";
}

interface Slot {
  last: number;
  day: string;
  count: number;
}

const today = () => new Date().toISOString().slice(0, 10);

export class Limiter {
  private slots = new Map<string, Slot>();
  constructor(
    readonly name: string,
    readonly cooldownS: number,
    readonly dailyMax = Number.POSITIVE_INFINITY,
  ) {}

  /** Seconds to wait, or 0 if `ip` may go now. Does not record anything. */
  check(ip: string): { ok: true } | { ok: false; retry_after_s: number; reason: string } {
    const s = this.slots.get(ip);
    if (!s) return { ok: true };
    const wait = Math.ceil((s.last + this.cooldownS * 1000 - Date.now()) / 1000);
    if (wait > 0) return { ok: false, retry_after_s: wait, reason: `${this.name}: one per ${this.cooldownS} s per visitor` };
    if (s.day === today() && s.count >= this.dailyMax) {
      const midnight = new Date(`${today()}T00:00:00Z`).getTime() + 86_400_000;
      return { ok: false, retry_after_s: Math.ceil((midnight - Date.now()) / 1000), reason: `${this.name}: ${this.dailyMax} per day per visitor` };
    }
    return { ok: true };
  }

  record(ip: string) {
    const s = this.slots.get(ip);
    const d = today();
    this.slots.set(ip, { last: Date.now(), day: d, count: s && s.day === d ? s.count + 1 : 1 });
    if (this.slots.size > 10_000) {
      const cutoff = Date.now() - 86_400_000;
      for (const [k, v] of this.slots) if (v.last < cutoff) this.slots.delete(k);
    }
  }
}

/** Runs `fn` after every earlier call has settled (one demo-account tx flow at a time). */
let chain: Promise<unknown> = Promise.resolve();
export function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

/** NEAR the demo account moved today on this instance (a soft daily cap). */
const spent = { day: today(), yocto: 0n };
export function spentToday(): bigint {
  if (spent.day !== today()) {
    spent.day = today();
    spent.yocto = 0n;
  }
  return spent.yocto;
}
export function addSpend(yocto: bigint) {
  spentToday();
  spent.yocto += yocto;
}
