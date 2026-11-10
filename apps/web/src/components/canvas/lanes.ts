import type { PreviewView } from "@/lib/views";
import type { Scene } from "./scheduler";
import { bez, clamp01, type Cubic, curve, dot, type Faces, fit, fontMono, fontSans, gauge, INK, inOut, lerp, line, outQ, PAPER, rgba, type Surface, VIO } from "./kit";

export interface LanesScene extends Scene {
  /** Show a run: the packet goes through the checks again from the start. */
  set(p: PreviewView): void;
}

/** Which gate a fallback reason stops at: 1 hashes, 2 signer, 3 parse. */
export const FAIL_GATE: Record<string, number> = { unsigned: 0, bad_hash: 0, bad_signature: 1, unparseable: 2 };

/**
 * The gate a run stopped at (0-based), or -1 when every check passed. A reply
 * over 64 KiB is `unparseable` too, but the contract refuses it before it
 * hashes anything, so it stops at the first gate.
 */
export function failGate(p: PreviewView): number {
  if (p.valid) return -1;
  if (p.variant === "oversize") return 0;
  return FAIL_GATE[p.reason ?? ""] ?? 0;
}

/**
 * A courier result running the contract's checks, left to right: hashes match,
 * signer allowed, ruling parses. A failure drops the packet to the fallback
 * lane; a pass reaches the clamp ring, which cuts locker_share to the bound.
 */
export function createLanes(cv: HTMLCanvasElement, first: PreviewView, faces: Faces, opts: { onCycleDone?: () => void } = {}): LanesScene {
  let p = first;
  let runT0 = 0;
  let G: Surface | null = null;
  let doneFired = false;

  const paint = (u: number) => {
    if (!G) return 0;
    const { ctx, w, h } = G;
    ctx.clearRect(0, 0, w, h);
    const mob = w < 480;
    const y = h * 0.38, yf = h * 0.84, xs = w * 0.04, gx = [w * 0.27, w * 0.45, w * 0.63], rx = w * 0.85, R = Math.min(30, h * 0.13, w * 0.08);
    const fail = failGate(p);
    // lanes
    line(ctx, xs, y, rx, y, rgba(INK, 0.14), 1);
    line(ctx, rx, y, w - 4, y, rgba(INK, 0.14), 1);
    line(ctx, gx[0], yf, w - 4, yf, rgba(INK, 0.24), 1, [3, 3]);
    ctx.font = fontSans(faces, mob ? 10 : 11);
    ctx.textAlign = "left";
    ctx.fillStyle = rgba(INK, 0.55);
    ctx.fillText("fallback rule", xs, yf + 4);
    ctx.textAlign = "center";
    ctx.fillText(mob ? "result" : "courier result", xs + (mob ? 14 : 30), y + 32);
    const gl = mob ? ["1 hashes", "2 signer", "3 ruling"] : ["1 · hashes match", "2 · signer allowed", "3 · parses"];
    // timeline: the check at gate k ends at tGate(k) + 350
    const tGate = (k: number) => 900 + k * 950;
    const tRing = tGate(3) - 250;
    let px = xs, py = y, hidden = false;
    const lastGate = fail < 0 ? 2 : fail;
    for (let k = 0; k <= lastGate; k++) {
      const a = tGate(k) - 600;
      if (u >= a) px = lerp(k === 0 ? xs : gx[k - 1], gx[k], inOut((u - a) / 600));
    }
    if (fail < 0 && u >= tRing) {
      px = lerp(gx[2], rx, inOut((u - tRing) / 500));
      if (u > tRing + 500) hidden = true;
    }
    if (fail >= 0 && u > tGate(fail) + 350) {
      const t0 = tGate(fail) + 350, d = inOut((u - t0) / 650), r2 = inOut((u - t0 - 650) / 900);
      const c: Cubic = [gx[fail], y, gx[fail] + 22, y, gx[fail] + 6, yf, gx[fail] + 34, yf];
      ctx.strokeStyle = rgba(INK, 0.22);
      ctx.lineWidth = 1;
      curve(ctx, c, 0, d, 20);
      if (r2 <= 0) [px, py] = bez(c, d);
      else {
        px = lerp(gx[fail] + 34, w * 0.9, r2);
        py = yf;
      }
      if (r2 > 0) line(ctx, gx[fail] + 34, yf, px, yf, rgba(INK, 0.5), 1);
      if (r2 >= 1) {
        ctx.font = fontMono(faces, mob ? 10 : 10.5);
        ctx.textAlign = "right";
        ctx.fillStyle = rgba(INK, 0.85);
        ctx.fillText(`tax ${p.levers_before.tax_bps} → ${p.levers.tax_bps} · rest held`, w - 6, yf - 9);
      }
    }
    // the trail on the main lane
    if (fail < 0 || u < tGate(fail) + 350) line(ctx, xs, y, Math.min(px, fail < 0 ? rx : gx[fail]), y, rgba(INK, 0.45), 1);
    else line(ctx, xs, y, gx[fail], y, rgba(INK, 0.45), 1);
    // the gates
    gx.forEach((x, k) => {
      line(ctx, x, y - 20, x, y + 14, rgba(INK, 0.3), 1);
      const done = u > tGate(k) + 350, checking = u > tGate(k) && !done;
      const reached = k <= lastGate;
      const failed = done && k === fail, passed = done && reached && k !== fail;
      if (checking && reached) {
        const q = (u - tGate(k)) / 350;
        dot(ctx, x, y, lerp(6, 15, q), null, rgba(VIO, 0.5 * (1 - q)));
      }
      dot(ctx, x, y, 5.5, PAPER, rgba(INK, failed ? 0.95 : 0.45), failed ? 1.3 : 1);
      if (passed) dot(ctx, x, y, 5.5, rgba(VIO, 1));
      if (failed) {
        line(ctx, x - 4, y - 4, x + 4, y + 4, rgba(INK, 0.95), 1.4);
        line(ctx, x - 4, y + 4, x + 4, y - 4, rgba(INK, 0.95), 1.4);
        ctx.font = fontMono(faces, mob ? 10 : 11);
        ctx.textAlign = "center";
        ctx.fillStyle = rgba(INK, 0.95);
        ctx.fillText(p.reason ?? "", x, y - 28);
      }
      ctx.font = fontSans(faces, mob ? 10 : 11);
      ctx.textAlign = "center";
      ctx.fillStyle = rgba(INK, k > lastGate ? 0.3 : 0.62);
      ctx.fillText(gl[k], x, y + 32);
    });
    // the ring: the clamp
    const ringOn = fail < 0 && u > tRing + 500;
    const cl = p.clamps.find((c) => c.lever === "locker_share");
    const asked = cl ? cl.asked : (p.asked?.locker_share ?? 0);
    const applied = cl ? cl.applied : p.levers.locker_share;
    gauge(ctx, rx, y, R, {
      bound: 25,
      asked: ringOn ? asked : 0,
      applied,
      grow: outQ((u - tRing - 500) / 800),
      cut: u > tRing + 1450 ? clamp01((u - tRing - 1450) / 260) : 0,
      ground: PAPER,
      lw: 3,
    });
    ctx.font = fontSans(faces, mob ? 10 : 11);
    ctx.textAlign = "center";
    ctx.fillStyle = rgba(INK, fail < 0 ? 0.62 : 0.3);
    ctx.fillText("clamp", rx, y - R - 12);
    if (ringOn && u > tRing + 1450) {
      ctx.font = fontMono(faces, mob ? 10 : 10.5);
      ctx.fillStyle = rgba(VIO, 1);
      ctx.fillText(cl ? `locker_share ${asked} → ${applied}` : `locker_share ${applied}`, rx, y + R + 20);
      const bb = p.clamps.find((c) => c.lever === "buyback_burn");
      if (bb) {
        ctx.fillStyle = rgba(INK, 0.62);
        ctx.fillText(`buyback_burn ${bb.asked} → ${bb.applied}`, rx, y + R + 35);
      }
    }
    // the packet
    if (!hidden) {
      dot(ctx, px, py, 5.5, PAPER);
      dot(ctx, px, py, 4.2, p.mode === "forge" && u > 2000 ? PAPER : rgba(INK, 0.92), rgba(INK, 0.92), 1.2);
    }
    return fail < 0 ? tRing + 3000 : tGate(fail) + 2400;
  };

  return {
    layout: () => {
      G = fit(cv);
    },
    onStart: (now) => {
      runT0 = now;
    },
    draw: (_t, now) => {
      const u = now - runT0;
      const doneAt = paint(u);
      if (!doneFired && u > doneAt + 2600) {
        doneFired = true;
        opts.onCycleDone?.();
      }
    },
    still: () => {
      paint(1e9);
    },
    set: (next) => {
      p = next;
      runT0 = performance.now();
      doneFired = false;
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) paint(1e9);
    },
  };
}
