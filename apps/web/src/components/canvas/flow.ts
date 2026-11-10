import type { Scene } from "./scheduler";
import {
  bez,
  chairNode,
  clamp01,
  type Cubic,
  curve,
  dot,
  type Faces,
  fit,
  fontMono,
  fontSans,
  GROUND,
  gauge,
  INK,
  inOut,
  lerp,
  line,
  outQ,
  rgba,
  rng,
  type Surface,
  VIO,
} from "./kit";

/** What the five step scenes draw from meeting 1. `null` draws the mechanism without its numbers. */
export interface FlowData {
  seed: string;
  requestSha256: string;
  /** Brief petition weights, heaviest first. */
  weights: number[];
}

/**
 * How a meeting works: five small scenes, one per step, played in turn.
 * Convene (the brief's three heaviest petitions, the block seed as ticks),
 * Ask (the request hash stored, the request carried to a TEE), Verify (a
 * genuine ruling passes the allowlist gate, a forged one drops to the
 * fallback rule), Clamp (asked 100, cut to 25), Apply (rewards pro rata,
 * buyback burned, the floor rises a hair).
 */
export function createFlow(items: HTMLElement[], data: FlowData | null, faces: Faces): Scene {
  const STEP = 3600, N = 5, PERIOD = STEP * N;
  const hex = (h: string) => h.split("").map((c) => parseInt(c, 16));
  const seedN = data ? hex(data.seed) : Array.from({ length: 32 }, () => 7);
  const reqN = data ? hex(data.requestSha256.slice(0, 32)) : Array.from({ length: 32 }, () => 7);
  const W8 = data && data.weights.length >= 3 ? data.weights : [1, 1, 1];
  let G: Surface[] = [];

  const thread = (ctx: CanvasRenderingContext2D, x0: number, x1: number, y: number, a = 0.13) => line(ctx, x0, y, x1, y, rgba(INK, a), 1);
  const pulse = (ctx: CanvasRenderingContext2D, x0: number, x1: number, y: number, k: number) => {
    if (k <= 0 || k >= 1) return;
    const x = lerp(x0, x1, k);
    line(ctx, x0, y, x, y, rgba(INK, 0.42), 1);
    dot(ctx, x, y, 2.6, rgba(VIO, 1));
  };

  const sConvene = ({ ctx, w, h }: Surface, u: number) => {
    const TY = h * 0.5, B = [w * 0.56, TY], rmax = Math.min(w, h) * 0.12;
    const pts: [number, number, number, number][] = [
      [0.17, 0.27, W8[0], 1],
      [0.3, 0.8, W8[1], 1],
      [0.42, 0.17, W8[2], 1],
      [0.08, 0.72, W8[0] * 0.021, 0],
      [0.46, 0.66, W8[0] * 0.013, 0],
    ];
    pts.forEach(([px, py, wt, top], i) => {
      const x = px * w, y = py * h, r = Math.max(2.2, rmax * Math.sqrt(wt / W8[0]));
      const c: Cubic = [x, y, lerp(x, B[0], 0.5), y, B[0] - 26, B[1], B[0], B[1]];
      ctx.strokeStyle = rgba(INK, 0.08);
      ctx.lineWidth = 1;
      curve(ctx, c, 0, 1, 30);
      if (top) {
        const k = outQ((u - 250 - i * 180) / 800);
        ctx.strokeStyle = rgba(INK, i === 0 ? 0.62 : 0.42);
        ctx.lineWidth = i === 0 ? 1.3 : 1;
        curve(ctx, c, 0, k, 36);
      }
      dot(ctx, x, y, r, GROUND);
      dot(ctx, x, y, r, rgba(INK, top ? 0.07 : 0.04), rgba(INK, top ? 0.75 : 0.32));
    });
    // the seed: 32 hex digits of the convening block's randomness, drawn in as ticks
    thread(ctx, B[0], w, TY);
    const x0 = B[0] + 18, x1 = w - 8, n = seedN.length, k = clamp01((u - 1500) / 1100);
    for (let i = 0; i < n * k; i++) {
      const x = lerp(x0, x1, i / (n - 1)), hh = 3 + seedN[i] * 0.95;
      line(ctx, x, TY - 3, x, TY - 3 - hh, rgba(INK, 0.55), 1);
    }
    pulse(ctx, B[0], w, TY, (u - 2700) / 850);
    chairNode(ctx, B[0], B[1], 0.85);
  };

  const sAsk = ({ ctx, w, h }: Surface, u: number) => {
    const TY = h * 0.5, px0 = w * 0.15, bx0 = w * 0.66, bx1 = w * 0.94, bh = Math.min(30, h * 0.17);
    thread(ctx, 0, w, TY);
    // the TEE: a plain box with a hatch; nothing readable inside
    ctx.save();
    ctx.beginPath();
    ctx.rect(bx0, TY - bh, bx1 - bx0, bh * 2);
    ctx.clip();
    for (let x = bx0 - bh * 2; x < bx1; x += 6) line(ctx, x, TY + bh, x + bh * 2, TY - bh, rgba(INK, 0.07), 1);
    ctx.restore();
    ctx.strokeStyle = rgba(INK, 0.42);
    ctx.lineWidth = 1;
    ctx.strokeRect(bx0 + 0.5, TY - bh + 0.5, bx1 - bx0 - 1, bh * 2 - 1);
    ctx.font = fontSans(faces, 10.5);
    ctx.fillStyle = rgba(INK, 0.55);
    ctx.textAlign = "center";
    ctx.fillText("NEAR AI · TEE", (bx0 + bx1) / 2, TY + bh + 15);
    // sha256(request) stored: 32 ticks from the real hash
    const hk = clamp01((u - 250) / 900), hx0 = px0 + 12, hx1 = Math.min(bx0 - 14, px0 + w * 0.42);
    for (let i = 0; i < reqN.length * hk; i++) {
      const x = lerp(hx0, hx1, i / (reqN.length - 1)), l = 3 + reqN[i] * 0.9;
      line(ctx, x, TY + 4, x, TY + 4 + l, rgba(INK, 0.5), 1);
    }
    if (hk > 0.5) {
      ctx.font = fontSans(faces, 10.5);
      ctx.textAlign = "left";
      ctx.fillStyle = rgba(INK, 0.5 * hk);
      ctx.fillText("stored", hx0, TY + 34);
    }
    // the request travels out, unchanged
    const tk = inOut((u - 1200) / 1300), x = lerp(px0, bx0 + 12, tk);
    if (tk > 0) line(ctx, px0, TY, x, TY, rgba(INK, 0.42), 1);
    const inside = tk >= 1;
    ctx.fillStyle = GROUND;
    ctx.fillRect(x - 7, TY - 9, 14, 18);
    ctx.strokeStyle = rgba(INK, inside ? 0.35 : 0.85);
    ctx.lineWidth = 1;
    ctx.strokeRect(x - 6.5, TY - 8.5, 13, 17);
    for (let i = 0; i < 3; i++) line(ctx, x - 3.5, TY - 4 + i * 4, x + 3.5 - (i === 2 ? 3 : 0), TY - 4 + i * 4, rgba(INK, inside ? 0.3 : 0.7), 1);
    if (inside) {
      const p = clamp01((u - 2500) / 900);
      dot(ctx, (bx0 + bx1) / 2 + 8, TY, 3 + Math.sin(p * Math.PI) * 2.5, rgba(VIO, 0.35 + 0.65 * Math.sin(p * Math.PI)));
    }
    pulse(ctx, bx1, w, TY, (u - 3000) / 550);
  };

  const sVerify = ({ ctx, w, h }: Surface, u: number) => {
    const TY = h * 0.44, gx = w * 0.5, y2 = TY + Math.min(30, h * 0.16), y3 = h * 0.86;
    thread(ctx, 0, w, TY);
    line(ctx, gx, y3, w, y3, rgba(INK, 0.22), 1, [3, 3]);
    ctx.font = fontSans(faces, 10.5);
    ctx.fillStyle = rgba(INK, 0.55);
    ctx.textAlign = "right";
    ctx.fillText("fallback rule", w - 6, y3 - 7);
    // the gate and the allowlist
    line(ctx, gx, TY - 30, gx, y2 + 12, rgba(INK, 0.35), 1);
    dot(ctx, gx, TY - 36, 4, GROUND, rgba(INK, 0.6));
    dot(ctx, gx, TY - 36, 1.4, rgba(INK, 0.8));
    // genuine: arrives, recovers to the allowlisted key, passes
    const g1 = inOut(u / 1100), gIn = lerp(w * 0.04, gx, g1);
    const passed = u > 1250, g2 = inOut((u - 1400) / 1100);
    if (!passed) {
      line(ctx, 0, TY, gIn, TY, rgba(INK, 0.42), 1);
      dot(ctx, gIn, TY, 3.6, rgba(INK, 0.9));
    } else {
      const x = lerp(gx, w - 4, g2);
      line(ctx, 0, TY, x, TY, rgba(INK, 0.42), 1);
      const pk = clamp01((u - 1100) / 700);
      if (pk < 1) dot(ctx, gx, TY, lerp(4, 16, outQ(pk)), null, rgba(VIO, 0.6 * (1 - pk)));
      dot(ctx, gx, TY, 4.2, rgba(VIO, 1));
      if (g2 < 1) dot(ctx, x, TY, 3.6, rgba(INK, 0.9));
    }
    // forged: same format, wrong key, bounced to the fallback rule
    const f1 = inOut((u - 900) / 1100), fx = lerp(w * 0.04, gx - 6, f1);
    if (u > 900 && u < 2000) dot(ctx, fx, y2, 3.6, GROUND, rgba(INK, 0.85), 1.2);
    if (u >= 2000) {
      const cx = gx - 6;
      line(ctx, cx - 4, y2 - 14, cx + 4, y2 - 6, rgba(INK, 0.85), 1.2);
      line(ctx, cx - 4, y2 - 6, cx + 4, y2 - 14, rgba(INK, 0.85), 1.2);
      const d = inOut((u - 2050) / 650), r2 = inOut((u - 2700) / 800);
      const c: Cubic = [cx, y2, cx + 18, y2, cx + 4, y3, gx + 26, y3];
      const p = r2 <= 0 ? bez(c, d) : [lerp(gx + 26, w * 0.82, r2), y3];
      dot(ctx, p[0], p[1], 3.6, GROUND, rgba(INK, 0.85), 1.2);
      if (d > 0) {
        ctx.strokeStyle = rgba(INK, 0.18);
        ctx.lineWidth = 1;
        curve(ctx, c, 0, d, 20);
      }
    }
    ctx.font = fontMono(faces, 9.5);
    ctx.textAlign = "left";
    ctx.fillStyle = rgba(INK, 0.55);
    if (u > 2050) ctx.fillText("bad_signature", gx + 8, y2 + 2);
  };

  const sClamp = ({ ctx, w, h }: Surface, u: number) => {
    const TY = h * 0.5, cx = w * 0.5, R = Math.min(h * 0.2, 36);
    thread(ctx, 0, w, TY);
    line(ctx, 0, TY, lerp(0, cx, inOut(u / 450)), TY, rgba(INK, 0.42), 1);
    const grow = outQ((u - 450) / 1100), cut = clamp01((u - 1750) / 260);
    gauge(ctx, cx, TY, R, { bound: 25, asked: 100, applied: 25, grow, cut: u > 1750 ? cut : 0 });
    ctx.font = fontSans(faces, 10.5);
    ctx.textAlign = "center";
    ctx.fillStyle = rgba(INK, 0.62);
    ctx.fillText("locker share ≤ 25%", cx, TY - R - 12);
    if (u > 2000) pulse(ctx, cx + R + 6, w, TY, (u - 2400) / 1000);
  };

  const sApply = ({ ctx, w, h }: Surface, u: number) => {
    const TY = h * 0.46, C = [w * 0.17, TY], rmax = Math.min(w, h) * 0.12;
    thread(ctx, 0, C[0], TY);
    const pts = [
      [0.8, 0.22],
      [0.88, 0.6],
      [0.68, 0.8],
    ].map(([px, py], i) => {
      const x = px * w, y = py * h;
      const c: Cubic = [C[0], C[1], lerp(C[0], x, 0.45), C[1], x - (x - C[0]) * 0.25, y, x, y];
      return { x, y, r: Math.max(2.6, rmax * Math.sqrt(W8[i] / W8[0])), c };
    });
    pts.forEach((p) => {
      ctx.strokeStyle = rgba(INK, 0.16);
      ctx.lineWidth = 1;
      curve(ctx, p.c, 0, 1, 30);
    });
    // pro rata: motes per petitioner in proportion to its weight
    const total = W8[0] + W8[1] + W8[2];
    const counts = W8.slice(0, 3).map((x) => Math.max(1, Math.round((20 * x) / total)));
    const R = rng(11);
    const glint = [0, 0, 0];
    counts.forEach((n, i) => {
      for (let k = 0; k < n; k++) {
        const t0 = 250 + R() * 1700, s = (u - t0) / 900;
        if (s >= 1) glint[i] = Math.min(1, glint[i] + 0.12);
        if (s <= 0 || s >= 1) continue;
        const [x, y] = bez(pts[i].c, inOut(s));
        dot(ctx, x, y, 1.6, rgba(VIO, 0.9));
      }
    });
    pts.forEach((p, i) => {
      dot(ctx, p.x, p.y, p.r, GROUND);
      dot(ctx, p.x, p.y, p.r, rgba(VIO, 0.22 * glint[i]), rgba(INK, 0.7));
    });
    // buyback and burn: bought on the curve, burned; the floor rises a hair
    const fx0 = w * 0.3, fx1 = w * 0.54, fy = h * 0.9 - 2.5 * outQ((u - 2600) / 500);
    line(ctx, fx0, fy, fx1, fy, rgba(INK, 0.5), 1);
    ctx.font = fontSans(faces, 10.5);
    ctx.textAlign = "left";
    ctx.fillStyle = rgba(INK, 0.55);
    ctx.fillText("floor", fx1 + 6, fy + 3.5);
    const R2 = rng(5);
    for (let k = 0; k < 6; k++) {
      const x = lerp(fx0 + 8, fx1 - 8, R2()), t0 = 700 + k * 220, s = (u - t0) / 800;
      if (s <= 0 || s >= 1.2) continue;
      dot(ctx, x, lerp(TY + 10, fy - 2, inOut(Math.min(1, s))), 1.8, rgba(INK, 0.75 * (s < 1 ? 1 : 1 - (s - 1) / 0.2)));
    }
    chairNode(ctx, C[0], C[1], 0.85);
  };

  const draws = [sConvene, sAsk, sVerify, sClamp, sApply];
  const paint = (k: number, u: number) => {
    items.forEach((li, i) => li.classList.toggle("on", i === k));
    G.forEach((g, i) => {
      g.ctx.clearRect(0, 0, g.w, g.h);
      g.ctx.globalAlpha = i === k || k < 0 ? 1 : 0.5;
      draws[i](g, i === k ? u : STEP);
      g.ctx.globalAlpha = 1;
    });
  };
  return {
    layout: () => {
      G = items.map((li) => fit(li.querySelector("canvas")!));
    },
    draw: (t) => {
      const tt = t % PERIOD;
      paint(Math.floor(tt / STEP), tt % STEP);
    },
    still: () => paint(-1, STEP),
  };
}
