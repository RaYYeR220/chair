// POST-HOC sensitivity check, added after the pre-registration and NOT part of it.
// The pre-registered PID controller reacts to the raw 24 h net flow, which flips sign day to
// day, so its tax lever bang-bangs between 100 and 300 bps. A judge could fairly call that a
// straw man. This variant smooths the flow (EMA, alpha 0.3), drops the derivative term and
// halves the gains. It is reported next to the pre-registered controller, never instead of it.
import { type Chair, toNear } from "./token.ts";
import type { Policy } from "./policies.ts";

export function smoothControllerPolicy(): Policy {
  let ema = 0;
  let integ = 0;
  const ALPHA = 0.3, Kp = 0.5, Ki = 0.08, BR_TARGET = 0.6;
  return {
    key: "controller_smooth", name: "PID controller, smoothed (post-hoc)",
    async decide(c: Chair) {
      const buy = toNear(c.volBuy), sell = toNear(c.volSell);
      const nf = buy + sell > 0 ? (buy - sell) / (buy + sell) : 0;
      ema = ALPHA * nf + (1 - ALPHA) * ema;
      const e = -ema;
      integ = Math.max(-3, Math.min(3, 0.8 * integ + e));
      const ctl = Math.max(-1, Math.min(1, Kp * e + Ki * integ));
      const price = toNear(c.price());
      const br = price > 0 ? toNear(c.floor()) / price : 1;
      const gap = Math.max(0, BR_TARGET - br) / BR_TARGET;
      return {
        ruling: {
          tax_bps: Math.round(200 + 100 * ctl),
          endowment_share: Math.round(50 - 20 * ctl),
          locker_share: Math.round(20 + 20 * ctl),
          buyback_burn: Math.round(50 * Math.min(1, Math.max(0, ctl) + 2 * gap)),
        },
        reason: null,
      };
    },
  };
}
