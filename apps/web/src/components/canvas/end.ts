import type { Scene } from "./scheduler";
import { type Cubic, curve, dot, fit, gauge, INK, lerp, reducedMotion, rgba, rng, type Surface } from "./kit";

/** The close: the hero's fan, small and quiet, every thread ending in the Chair at its cap. */
export function createEnd(cv: HTMLCanvasElement): Scene {
  let G: Surface | null = null;
  let pts: { x: number; y: number; r: number; c: Cubic }[] = [];
  let C = [0, 0];
  const layout = () => {
    G = fit(cv);
    const { w, h } = G, Rr = rng(42), n = w < 500 ? 11 : 17;
    C = [w / 2, h - 18];
    pts = [];
    for (let i = 0; i < n; i++) {
      const u = (i + 0.5) / n;
      const x = lerp(w * 0.04, w * 0.96, u) + (Rr() - 0.5) * w * 0.03;
      const y = lerp(h * 0.1, h * 0.62, Math.pow(Math.abs(u - 0.5) * 2, 1.6)) + (Rr() - 0.5) * 18;
      const r = 1.8 + Math.pow(Rr(), 3) * (w < 500 ? 9 : 14);
      pts.push({ x, y, r, c: [x, y, x, lerp(y, C[1], 0.55), lerp(C[0], x, 0.16), C[1] - Math.max(30, (C[1] - y) * 0.6), C[0], C[1]] });
    }
  };
  const paint = (t: number) => {
    if (!G) return;
    const { ctx, w, h } = G;
    ctx.clearRect(0, 0, w, h);
    const RM = reducedMotion();
    pts.forEach((p, i) => {
      ctx.strokeStyle = rgba(INK, 0.1);
      ctx.lineWidth = 1;
      curve(ctx, p.c, 0, 1, 30);
      if (!RM) {
        const ph = (t / 7000 + i * 0.173) % 1;
        ctx.strokeStyle = rgba(INK, 0.3);
        curve(ctx, p.c, ph, Math.min(1, ph + 0.06), 6);
      }
    });
    pts.forEach((p) => {
      dot(ctx, p.x, p.y, p.r, "#fbfaf7");
      dot(ctx, p.x, p.y, p.r, rgba(INK, 0.07), rgba(INK, 0.55));
    });
    gauge(ctx, C[0], C[1], 13, { bound: 25, asked: 25, applied: 25, lw: 2.4 });
  };
  return { layout, draw: paint, still: () => paint(0) };
}
