import type { Scene } from "./scheduler";
import { bez, clamp01, type Cubic, curve, dot, fit, GROUND, gauge, INK, inOut, lerp, outQ, rgba, rng, type Surface, VIO } from "./kit";

export interface FanPetition {
  /** Short name for the label: "the whale", "locker", an account. */
  name: string;
  weight: number;
  /** The answer's first words, or null when there is none. */
  answer: string | null;
}

export interface FanData {
  meeting: number;
  signerLabel: string;
  petitions: FanPetition[];
  totalWeight: number;
  /** locker_share as the ruling asked it and as the contract applied it. */
  asked: number;
  applied: number;
  bound: number;
  rule: string | null;
}

export interface FanScene extends Scene {
  setHot(i: number): void;
}

const fmtW = (w: number) => (w >= 1e6 ? `${parseFloat((w / 1e6).toFixed(w >= 1e7 ? 1 : 2))}M` : w >= 1e3 ? `${Math.round(w / 1e3)}K` : String(w));

/**
 * One real meeting as a fan: its briefed petitions as dots sized by weight,
 * joined to the Chair; the answers travel back, rewards flow out pro rata, and
 * the gauge shows the ruling's locker_share asked, then cut to the bound.
 */
export function createFan(cv: HTMLCanvasElement, lbl: HTMLElement, data: FanData): FanScene {
  const P = [
    { u: 0.27, v: 0.3 },
    { u: 0.15, v: 0.76 },
    { u: 0.6, v: 0.12 },
  ];
  const CU = 0.68, CV = 0.7;
  const pets = data.petitions.slice(0, 3);
  const W8 = pets.map((p) => p.weight);
  const pct = (w: number) => `${((w / data.totalWeight) * 100).toFixed(1)}%`;
  let G: Surface | null = null;
  let geo: { x: number; y: number; r: number; c: Cubic }[] = [];
  let C = [0, 0], R = 0, hot = -1, still = false;

  // labels: built once, positioned on layout
  lbl.replaceChildren();
  const mk = (cls: string) => {
    const el = document.createElement("div");
    el.className = `ml ${cls}`;
    lbl.appendChild(el);
    return el;
  };
  const span = (cls: string, text: string) => {
    const s = document.createElement("span");
    s.className = cls;
    s.textContent = text;
    return s;
  };
  const labels = pets.map((p) => {
    const el = mk("");
    const b = document.createElement("b");
    b.textContent = p.name;
    const ans = span("m v", p.answer ? ` · “${p.answer}”` : "");
    ans.dataset.ans = "";
    el.append(b, span("m", `${fmtW(p.weight)} · ${pct(p.weight)}`), ans);
    return el;
  });
  const chairL = mk("c");
  {
    const b = document.createElement("b");
    b.textContent = "the Chair";
    chairL.append(b, span("m", `meeting ${data.meeting} · ${data.signerLabel}`));
  }
  const gaugeL = mk("");
  const gText = span("m v", "asked …");
  {
    const b = document.createElement("b");
    b.textContent = `locker share ≤ ${data.bound}%`;
    gaugeL.append(b, gText);
  }

  const T = { rank: 1200, ans: 2000, ask: 3500, cut: 4700, pay: 5300, fade: 11000, end: 12000 };
  // pro-rata reward motes: 20 split by weight
  const total = W8.reduce((s, x) => s + x, 0) || 1;
  const motes: { i: number; t0: number; dur: number }[] = [];
  {
    const Rr = rng(7);
    W8.forEach((w, i) => {
      const n = Math.max(1, Math.round((20 * w) / total));
      for (let k = 0; k < n; k++) motes.push({ i, t0: T.pay + Rr() * 1800, dur: 1000 + Rr() * 500 });
    });
  }

  const layout = () => {
    G = fit(cv);
    const { w, h } = G;
    const mobile = w < 420;
    C = [w * CU, h * CV];
    R = w * (mobile ? 0.11 : 0.1);
    const rm = w * 0.15;
    geo = pets.map((_, i) => {
      const x = P[i].u * w, y = P[i].v * h, r = Math.max(4, rm * Math.sqrt(W8[i] / W8[0]));
      const c: Cubic = [x, y, i === 1 ? lerp(x, C[0], 0.45) : x, i === 1 ? y : lerp(y, C[1], 0.62), C[0] - R * 2.1, C[1], C[0], C[1]];
      return { x, y, r, c };
    });
    const put = (el: HTMLElement, x: number, y: number) => {
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
    };
    if (geo[0]) put(labels[0], geo[0].x + geo[0].r + 12, geo[0].y - 18);
    if (geo[1]) put(labels[1], geo[1].x + geo[1].r + 10, geo[1].y + 2);
    if (geo[2]) put(labels[2], geo[2].x + geo[2].r + 10, geo[2].y - 16);
    labels.slice(1).forEach((el) => {
      el.style.display = mobile ? "none" : "";
    });
    put(chairL, C[0], C[1] + R + 14);
    if (mobile) put(gaugeL, C[0] - 60, C[1] - R - 46);
    else put(gaugeL, C[0] + R + 14, C[1] - 17);
  };

  const paint = (t: number) => {
    if (!G) return;
    const { ctx, w, h } = G;
    ctx.clearRect(0, 0, w, h);
    const fade = 1 - clamp01((t - T.fade) / (T.end - T.fade));
    ctx.globalAlpha = fade;
    const glint = [0, 0, 0];
    geo.forEach((g, i) => {
      ctx.strokeStyle = rgba(INK, 0.07);
      ctx.lineWidth = 1;
      curve(ctx, g.c, 0, 1, 40);
      const k = outQ((t - i * 220) / 1000);
      const rk = outQ((t - T.rank) / 600);
      ctx.strokeStyle = rgba(INK, hot === i ? 0.9 : i === 0 ? lerp(0.38, 0.7, rk) : 0.32);
      ctx.lineWidth = hot === i || (i === 0 && rk > 0.5) ? 1.5 : 1;
      curve(ctx, g.c, 0, k, 48);
    });
    // answers travel back along the same hairlines
    geo.forEach((g, i) => {
      if (!pets[i].answer) return;
      const s = (t - T.ans - i * 300) / 1100;
      if (s >= 1) glint[i] = 1 - clamp01((t - T.ans - i * 300 - 1100) / 2500) * 0.6;
      if (s <= 0 || s >= 1.2) return;
      const head = 1 - inOut(Math.min(1, s)), a = s < 1 ? 1 : 1 - (s - 1) / 0.2;
      ctx.strokeStyle = rgba(VIO, a);
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      curve(ctx, g.c, head, Math.min(1, head + 0.1), 10);
      ctx.lineCap = "butt";
      const [x, y] = bez(g.c, head);
      dot(ctx, x, y, 2.6, rgba(VIO, a));
    });
    // rewards out, pro rata
    motes.forEach((m) => {
      const s = (t - m.t0) / m.dur;
      if (s <= 0 || s >= 1 || !geo[m.i]) return;
      const [x, y] = bez(geo[m.i].c, 1 - inOut(s));
      dot(ctx, x, y, 1.8, rgba(VIO, 0.9));
    });
    geo.forEach((g, i) => {
      dot(ctx, g.x, g.y, g.r, GROUND);
      dot(ctx, g.x, g.y, g.r, rgba(INK, i === 0 ? 0.045 : 0.08), rgba(hot === i ? VIO : INK, hot === i ? 1 : 0.7), hot === i ? 1.5 : 1);
      if (glint[i] > 0) dot(ctx, g.x, g.y, g.r, rgba(VIO, (g.r > 30 ? 0.1 : 0.3) * glint[i]));
      if (i === 0) dot(ctx, g.x, g.y, g.r * 0.62, null, rgba(INK, 0.08));
    });
    gauge(ctx, C[0], C[1], R, {
      bound: data.bound,
      asked: data.asked,
      applied: data.applied,
      grow: outQ((t - T.ask) / 1000),
      cut: t > T.cut ? clamp01((t - T.cut) / 260) : 0,
      lw: 3.4,
    });
    ctx.globalAlpha = 1;
    const on = fade > 0.3 && t > 600;
    labels.forEach((el, i) => {
      el.classList.toggle("on", on);
      const a = el.querySelector<HTMLElement>("[data-ans]");
      if (a) a.style.opacity = t > T.ans + i * 300 + 1100 && on ? "1" : "0";
    });
    chairL.classList.toggle("on", on);
    gaugeL.classList.toggle("on", on);
    const clamped = data.asked > data.applied;
    const txt =
      t > T.cut
        ? clamped
          ? `asked ${data.asked} → ${data.applied}${data.rule ? ` · ${data.rule}` : ""}`
          : `asked ${data.asked} · inside the bound`
        : t > T.ask
          ? `asked ${data.asked}`
          : "asked …";
    if (gText.textContent !== txt) gText.textContent = txt;
  };

  const STILL = T.pay + 2500;
  return {
    layout,
    draw: (t) => {
      still = false;
      paint(t % T.end);
    },
    still: () => {
      still = true;
      paint(STILL);
    },
    setHot: (i) => {
      hot = i;
      if (still) paint(STILL);
    },
  };
}
