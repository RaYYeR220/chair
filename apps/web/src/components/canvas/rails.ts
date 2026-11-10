import type { LeversView, Rules } from "@/lib/chair-types";
import type { ReplayMeeting } from "@/lib/views";
import type { Scene } from "./scheduler";
import { clamp01, dot, escapeHtml, type Faces, fit, fontMono, fontSans, GROUND, INK, inOut, lerp, line, outQ, type RGB, rgba, type Surface, VIO } from "./kit";

export const RAIL_LEVERS = ["tax_bps", "endowment_share", "locker_share", "buyback_burn"] as const;
export type RailLever = (typeof RAIL_LEVERS)[number];

/** The drawing domain of each rail. The bounds come from the contract's `get_constitution`. */
const DOMAIN: Record<RailLever, { d: [number, number]; ticks: number[]; old?: number; vio?: boolean }> = {
  tax_bps: { d: [0, 400], ticks: [0, 200, 400] },
  endowment_share: { d: [0, 100], ticks: [0, 50] },
  locker_share: { d: [0, 100], ticks: [50, 75, 100], old: 50, vio: true },
  buyback_burn: { d: [0, 100], ticks: [100] },
};

export interface RailsData {
  rules: Rules | null;
  levers: LeversView | null;
  /** Held meetings to replay on the rails, oldest first. Empty: the rails rest on today's levers. */
  meetings: ReplayMeeting[];
  /** The figcaption the replay narrates into (landing only). */
  caption?: HTMLElement | null;
  /** Show the old v1 cap mark on the locker rail. */
  showOldCap?: boolean;
}

/**
 * The constitution as four rails: each lever's domain, its bounds, today's
 * value and the window it can move in one meeting. In replay, each testnet
 * meeting's asks drop onto the rails and anything past a bound is cut back.
 */
export function createRails(canvases: Record<RailLever, HTMLCanvasElement>, data: RailsData, faces: Faces): Scene {
  const MT = 4800;
  const Ms = data.meetings;
  const PERIOD = MT * Math.max(1, Ms.length);
  const L = data.levers;
  let lastCap = "";
  const setCap = (html: string) => {
    if (data.caption && html !== lastCap) {
      data.caption.innerHTML = html;
      lastCap = html;
    }
  };
  const today = L
    ? `Today on testnet: tax <b class="m">${L.tax_bps}</b> · endowment <b class="m">${L.endowment_share}</b> · locker <b class="m">${L.locker_share}</b> · buyback <b class="m">${L.buyback_share}</b>`
    : "Couldn’t reach testnet just now, so today’s levers are not drawn.";

  const bounds = (k: RailLever): [number, number, number | null] => {
    const r = data.rules?.[k];
    return r ? [r.min, r.max, r.max_step] : [NaN, NaN, null];
  };

  const drawRail = (k: RailLever, G: Surface, m: ReplayMeeting | null, u: number) => {
    const { ctx, w, h } = G;
    const c = DOMAIN[k];
    const [b0, b1, step] = bounds(k);
    ctx.clearRect(0, 0, w, h);
    const pad = 16, y = Math.round(h * 0.55) + 0.5;
    const X = (v: number) => pad + ((Math.max(c.d[0], Math.min(c.d[1], v)) - c.d[0]) / (c.d[1] - c.d[0])) * (w - pad * 2);
    const col: RGB = c.vio ? VIO : INK;
    // the domain, then the bound
    line(ctx, X(c.d[0]), y, X(c.d[1]), y, rgba(INK, 0.13), 1);
    ctx.font = fontMono(faces, 10);
    ctx.textAlign = "center";
    ctx.fillStyle = rgba(INK, 0.4);
    c.ticks.forEach((v) => {
      line(ctx, X(v), y - 3, X(v), y + 3, rgba(INK, 0.2), 1);
      ctx.fillText(String(v), X(v), y + 20);
    });
    if (!Number.isNaN(b0)) {
      line(ctx, X(b0), y, X(b1), y, rgba(col, c.vio ? 1 : 0.85), 2);
      [b0, b1].forEach((v) => line(ctx, X(v), y - 9, X(v), y + 9, rgba(col, c.vio ? 1 : 0.85), 1.5));
      ctx.fillStyle = rgba(col, 0.9);
      ctx.font = fontMono(faces, 10.5);
      ctx.fillText(String(b0), X(b0), y + 20);
      ctx.fillText(String(b1), X(b1), y + 20);
    }
    if (c.old && data.showOldCap) {
      line(ctx, X(c.old), y - 12, X(c.old), y + 12, rgba(INK, 0.35), 1, [2, 2]);
      ctx.font = fontSans(faces, 10.5);
      ctx.fillStyle = rgba(INK, 0.45);
      ctx.fillText("v1 cap", X(c.old), y - 17);
    }
    const win = (v: number) => {
      if (!step || Number.isNaN(b0)) return;
      const lo = Math.max(b0, v - step), hi = Math.min(b1, v + step);
      ctx.fillStyle = rgba(INK, 0.06);
      ctx.fillRect(X(lo), y - 6, X(hi) - X(lo), 12);
      return [lo, hi];
    };
    if (!m) {
      // at rest: today's lever and the window it can move in one meeting
      const v = k === "buyback_burn" ? null : L?.[k];
      if (v != null) {
        win(v);
        dot(ctx, X(v), y, 5.2, rgba(INK, 1), GROUND, 2);
        ctx.font = fontMono(faces, 11);
        ctx.fillStyle = rgba(INK, 0.9);
        ctx.textAlign = "center";
        ctx.fillText(String(v), X(v), y - 13);
      }
      return;
    }
    const before = k === "buyback_burn" ? null : m.levers_before[k];
    const asked = m.asked[k];
    const applied = k === "buyback_burn" ? m.buyback_bps : m.applied[k];
    const cl = m.clamps.find((x) => x.lever === k);
    // the step window around the lever as it stood
    if (before != null) {
      const lh = win(before);
      if (lh) {
        line(ctx, X(lh[0]), y - 6, X(lh[0]), y + 6, rgba(INK, 0.25), 1);
        line(ctx, X(lh[1]), y - 6, X(lh[1]), y + 6, rgba(INK, 0.25), 1);
      }
    }
    // the ask drops in
    const drop = outQ((u - 450) / 600);
    if (drop > 0) {
      const ax = X(asked), off = asked > c.d[1];
      const ay = lerp(4, y, drop);
      if (drop < 1) line(ctx, ax, 4, ax, ay, rgba(VIO, 0.35), 1);
      // the overshoot, then the cut (260 ms)
      if (cl && drop >= 1) {
        const g = outQ((u - 1100) / 500), cut = clamp01((u - 1900) / 260);
        const x0 = X(applied), x1 = lerp(x0, ax, g * (1 - outQ(cut)));
        if (x1 > x0 + 0.5) line(ctx, x0, y, x1, y, rgba(VIO, 0.45), 3);
        if (cut >= 1) line(ctx, x0, y, ax, y, rgba(VIO, 0.4), 1.2, [2, 3]);
      }
      dot(ctx, ax, ay, 4, GROUND, rgba(VIO, 1), 1.3);
      ctx.font = fontMono(faces, 10.5);
      ctx.fillStyle = rgba(VIO, 1);
      ctx.textAlign = off ? "right" : "center";
      const lbl = cl && u > 1900 ? `asked ${asked} → ${applied} · ${cl.rule}` : `asked ${asked}`;
      ctx.fillText(lbl, off ? ax - 2 : Math.max(pad + 40, Math.min(w - pad - 60, ax)), y - 15);
    }
    // the lever moves to what was applied
    if (before != null) {
      const v = lerp(before, applied, inOut((u - 2300) / 700));
      dot(ctx, X(v), y, 5.2, rgba(INK, 1), GROUND, 2);
      if (!(drop > 0 && Math.abs(X(asked) - X(v)) < 40)) {
        ctx.font = fontMono(faces, 11);
        ctx.fillStyle = rgba(INK, 0.9);
        ctx.textAlign = "center";
        ctx.fillText(String(Math.round(v)), X(v), y - 13);
      }
    } else if (u > 2300) {
      dot(ctx, X(applied), y, 4, rgba(INK, 1), GROUND, 1.5);
    }
  };

  let G: Record<RailLever, Surface> | null = null;
  const paint = (mi: number, u: number) => {
    if (!G) return;
    const m = mi < 0 || !Ms.length ? null : Ms[mi];
    for (const k of RAIL_LEVERS) drawRail(k, G[k], m, u);
    if (!m) {
      setCap(`<span>${today}</span><span>Bounds and steps from <span class="m">get_constitution</span>.</span>`);
      return;
    }
    const cut = m.clamps.map((c) => `${escapeHtml(c.lever)} ${c.asked} → ${c.applied}`).join(", ");
    setCap(`<span>Replaying testnet meeting <b>${m.number}</b>: ${cut ? `clamped ${cut}` : "applied as asked, no clamps"}.</span><span>${today}</span>`);
  };
  return {
    layout: () => {
      G = Object.fromEntries(RAIL_LEVERS.map((k) => [k, fit(canvases[k])])) as Record<RailLever, Surface>;
    },
    draw: (t) => {
      if (!Ms.length) return paint(-1, 0);
      const tt = t % PERIOD;
      paint(Math.floor(tt / MT), tt % MT);
    },
    still: () => (Ms.length ? paint(0, 2600) : paint(-1, 0)),
  };
}
