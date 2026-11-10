/**
 * The drawing vocabulary every scene shares: weight-sized dots, hairlines,
 * cubic threads into the Chair, and the Chair's gauge (a hairline ring, the
 * 25% bound tick, what was asked, and the cut). Violet only where something
 * is decided or cut.
 */

export type RGB = readonly [number, number, number];
export const VIO: RGB = [94, 69, 216];
export const INK: RGB = [17, 16, 20];
export const GROUND = "#fbfaf7";
export const PAPER = "#fffefc";
export const A0 = -Math.PI / 2;
export const TAU = Math.PI * 2;

export const rgba = (c: RGB, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
export const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** ≈ cubic-bezier(.16, 1, .3, 1) */
export const outQ = (t: number) => 1 - Math.pow(1 - clamp01(t), 4);
export const inOut = (t: number) => {
  t = clamp01(t);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};

/** Mulberry32: deterministic layouts. */
export const rng = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The page's faces as canvas font families (next/font hashes the names, so read the CSS variables). */
export interface Faces {
  sans: string;
  mono: string;
}
export function readFaces(): Faces {
  const cs = getComputedStyle(document.documentElement);
  return {
    sans: cs.getPropertyValue("--font-sans").trim() || "system-ui, sans-serif",
    mono: cs.getPropertyValue("--font-mono").trim() || "ui-monospace, monospace",
  };
}
export const fontSans = (f: Faces, px: number, w = 400) => `${w} ${px}px ${f.sans}`;
export const fontMono = (f: Faces, px: number) => `400 ${px}px ${f.mono}`;

export interface Surface {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
}

/** Size the backing store to the element (DPR ≤ 2) and return a context in CSS pixels. */
export function fit(cv: HTMLCanvasElement): Surface {
  const r = cv.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  const ctx = cv.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

export function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string | null, stroke?: string | null, lw = 1) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lw;
    ctx.stroke();
  }
}

export function line(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, style: string, lw = 1, dash?: number[]) {
  ctx.strokeStyle = style;
  ctx.lineWidth = lw;
  if (dash) ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  if (dash) ctx.setLineDash([]);
}

/** A cubic as 8 numbers: start, two controls, end. */
export type Cubic = [number, number, number, number, number, number, number, number];

export function bez(c: Cubic, t: number): [number, number] {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t;
  return [a * c[0] + b * c[2] + d * c[4] + e * c[6], a * c[1] + b * c[3] + d * c[5] + e * c[7]];
}

export function curve(ctx: CanvasRenderingContext2D, c: Cubic, t0: number, t1: number, n = 40) {
  if (t1 <= t0) return;
  ctx.beginPath();
  for (let i = 0; i <= n; i++) {
    const [x, y] = bez(c, lerp(t0, t1, i / n));
    if (i) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  }
  ctx.stroke();
}

export interface GaugeOpts {
  bound?: number;
  asked?: number;
  applied?: number;
  grow?: number;
  cut?: number;
  lw?: number;
  ghost?: boolean;
  ground?: string;
}

/** The Chair's gauge: a hairline ring, the bound tick, what was asked, and the cut back to the bound. */
export function gauge(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, o: GaugeOpts) {
  const { bound = 25, asked = 0, applied = 0, grow = 1, cut = 1, lw = 3, ghost = true } = o;
  ctx.fillStyle = o.ground ?? GROUND;
  ctx.beginPath();
  ctx.arc(x, y, r + 5, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = rgba(INK, 0.2);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.stroke();
  const aB = A0 + (TAU * bound) / 100;
  let shown = asked * grow;
  if (asked > bound && cut > 0) shown = lerp(asked * grow, applied, outQ(cut));
  if (asked > bound && cut >= 1 && ghost) {
    ctx.strokeStyle = rgba(VIO, 0.5);
    ctx.lineWidth = 1.2;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.arc(x, y, r, aB, A0 + (TAU * Math.min(asked, 100)) / 100);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (shown > 0.2) {
    ctx.lineCap = "butt";
    ctx.strokeStyle = rgba(VIO, 1);
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.arc(x, y, r, A0, A0 + (TAU * Math.min(shown, bound)) / 100);
    ctx.stroke();
    if (shown > bound) {
      ctx.strokeStyle = rgba(VIO, 0.42);
      ctx.beginPath();
      ctx.arc(x, y, r, aB, A0 + (TAU * Math.min(shown, 100)) / 100);
      ctx.stroke();
    }
  }
  line(ctx, x + Math.cos(aB) * (r - 6), y + Math.sin(aB) * (r - 6), x + Math.cos(aB) * (r + 6), y + Math.sin(aB) * (r + 6), rgba(INK, 0.85), 1.5);
  dot(ctx, x, y, Math.max(5, r * 0.26), null, rgba(VIO, 1), 1.4);
  dot(ctx, x, y, Math.max(1.8, r * 0.08), rgba(VIO, 1));
}

/** The Chair as a small node: a violet ring with a violet centre, masked from the threads behind it. */
export function chairNode(ctx: CanvasRenderingContext2D, x: number, y: number, s = 1) {
  dot(ctx, x, y, 7 * s + 3, GROUND);
  dot(ctx, x, y, 7 * s, null, rgba(VIO, 1), 1.4);
  dot(ctx, x, y, 2.4 * s, rgba(VIO, 1));
}

/** Hex digits of a hash as numbers, for tick heights. */
export const hexDigits = (h: string) => h.split("").map((c) => parseInt(c, 16)).filter((n) => !Number.isNaN(n));

export const escapeHtml = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
