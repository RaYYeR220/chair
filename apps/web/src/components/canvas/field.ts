import type { HeroSim } from "@/lib/content/hero-sim";
import { bez, clamp01, type Cubic, GROUND, INK, inOut, lerp, outQ, reducedMotion, rgba, rng, VIO } from "./kit";

/**
 * The hero: lockers lean in. Lockers are dots sized by weight (area ∝ CHAIR-days);
 * each petition is a hairline to the Chair. One meeting per cycle:
 * File → Rank (the top 3 brighten and pull in) → Answer (violet pulses travel
 * back, the answer's first words land by the dot) → Clamp (the 25% gauge: what
 * the chair asked, cut to the bound) → Pay (reward motes flow out pro rata; the
 * excess over the bound dies at the ring). Every labelled number is from the
 * whale-capture simulation (HERO_SIM).
 */

interface Dot {
  id: string;
  w: number;
  kind: "whale" | "locker" | "you";
  known: boolean;
  days?: number;
  x: number;
  y: number;
  r: number;
  px: number;
  py: number;
  c: Cubic;
  glint: number;
  tag?: HTMLElement;
}
interface Top {
  id: string;
  w: number;
  text: string;
  answer: string;
  rank: number;
  first: string;
  arrived: boolean;
}
interface Meet {
  meeting: number;
  tier: string;
  lockerWeight: number;
  lockerAsked: number;
  applied: number;
  top: Top[];
}
interface Mote {
  dot: Dot;
  t0: number;
  dur: number;
  done?: boolean;
}
interface Filed {
  dot: Dot;
  top?: Top;
  delay: number;
}
interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const BOUND = 25; // locker_share ceiling in the constitution
const T = { file: 500, rank: 2300, rule: 3300, answer: 3600, clamp: 6800, pay: 8200, hold: 11400, end: 13800 };
/** Hand-placed anchors for the known lockers: u ∈ [-1,1] across the stage, v ∈ [0,1] from the field top to the Chair. */
const POS_D: Record<string, [number, number]> = { W: [-0.68, 0.8], A: [0.74, 0.58], B: [0.3, 0.76], I: [0.92, 0.26], D: [0.36, 0.92], C: [-0.92, 0.24], E: [0.84, 0.08], H: [-0.4, 0.97], F: [0.56, 0.97], G: [-0.84, 0.06] };
const POS_M: Record<string, [number, number]> = { W: [-0.6, 0.42], A: [0.72, 0.26], B: [-0.2, 0.9], I: [0.92, 0.7], D: [0.32, 0.8], C: [-0.93, 0.1], E: [0.9, 0.04], H: [-0.9, 0.9], F: [0.64, 0.96], G: [-0.42, 0.02] };
/** Eleven more lockers drawn without numbers: illustrative weights, small, as in the run. */
const UNLABELLED = [11.8e6, 9.6e6, 8.1e6, 6.4e6, 5.2e6, 4.4e6, 3.6e6, 2.9e6, 2.3e6, 1.8e6, 1.2e6];

const fmtW = (w: number) => {
  const [s, d] = w >= 1e9 ? ["B", 1e9] : w >= 1e6 ? ["M", 1e6] : w >= 1e3 ? ["K", 1e3] : ["", 1];
  const x = w / (d as number);
  return parseFloat(x.toFixed(x >= 100 ? 0 : x >= 10 ? 1 : 2)).toString() + s;
};
const fmtPct = (s: number) => {
  const p = s * 100;
  return p >= 1 ? `${Math.round(p)}%` : p >= 0.1 ? `${p.toFixed(1)}%` : "<0.1%";
};
const tierName = (t: string) => (!t ? "asleep" : /glm/i.test(t) ? "GLM-5.3-flash" : /deepseek/i.test(t) ? "DeepSeek-V4.1-Flash" : t);
const firstWords = (a: string) => {
  let s = a.split(/(?<=\.)\s/)[0];
  if (s.length > 46) {
    const head = s.slice(0, 46);
    const k = Math.max(head.lastIndexOf(","), head.lastIndexOf(":"));
    s = k > 8 ? head.slice(0, k) : `${head.slice(0, head.lastIndexOf(" "))}…`;
  }
  return s.replace(/[,:;]$/, "");
};
const trim = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, s.lastIndexOf(" ", n - 1)).replace(/[,;:.\s]+$/, "")}…`);
const hits = (R: Rect, x: number, y: number, rad = 0) => x + rad > R.x0 && x - rad < R.x1 && y + rad > R.y0 && y - rad < R.y1;
const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

export interface FieldHandle {
  replay(): void;
  openChooser(): void;
  destroy(): void;
}

export function createField(hero: HTMLElement, data: HeroSim): FieldHandle {
  const RM = reducedMotion();
  const $ = <E extends Element = HTMLElement>(s: string) => hero.querySelector<E & Element>(s) as unknown as E;
  const $$ = <E extends Element = HTMLElement>(s: string, r: ParentNode = hero) => Array.from(r.querySelectorAll(s)) as unknown as E[];
  const cvs = $<HTMLCanvasElement>("[data-field]");
  const ctx = cvs.getContext("2d")!;
  const tagsEl = $("[data-tags]");
  const live = $("[data-live]");
  const steps = $$<HTMLLIElement>(".steps li");
  const chooser = $("[data-chooser]");
  const cleanups: (() => void)[] = [];
  const on = <K extends keyof HTMLElementEventMap>(el: EventTarget, ev: K | string, fn: (e: never) => void) => {
    el.addEventListener(ev, fn as EventListener);
    cleanups.push(() => el.removeEventListener(ev, fn as EventListener));
  };

  // ------------------------------------------------------------ population: the whale + the lockers
  const blank = { x: 0, y: 0, r: 0, px: 0, py: 0, c: [0, 0, 0, 0, 0, 0, 0, 0] as Cubic, glint: 0 };
  const pop: Dot[] = [];
  pop.push({ id: "W", w: data.population.whale.w, kind: "whale", days: data.population.whale.days, known: true, ...blank, c: [...blank.c] });
  data.population.known.forEach((k) => pop.push({ id: k.id, w: k.w, kind: "locker", known: true, ...blank, c: [...blank.c] }));
  UNLABELLED.forEach((w, i) => pop.push({ id: `x${i}`, w, kind: "locker", known: false, ...blank, c: [...blank.c] }));
  const byId = Object.fromEntries(pop.map((p) => [p.id, p]));
  let user: Dot | null = null;

  const meetings: Meet[] = data.meetings.map((m) => ({
    meeting: m.meeting,
    tier: tierName(m.tier),
    lockerWeight: m.lockerWeight,
    lockerAsked: m.lockerAsked,
    applied: Math.min(m.lockerAsked, BOUND),
    top: m.petitions.map((p, i) => ({ ...p, rank: i + 1, first: firstWords(p.answer), arrived: false })),
  }));

  // ------------------------------------------------------------ geometry
  let W = 0, H = 0, S = 0, cx = 0, cy = 0, mobile = false, rMax = 54, GR = 30;
  let obstacles: Rect[] = [];
  const rectOf = (el: Element, pad: number): Rect => {
    const r = el.getBoundingClientRect(), h = hero.getBoundingClientRect();
    return { x0: r.left - h.left - pad, y0: r.top - h.top - pad, x1: r.right - h.left + pad, y1: r.bottom - h.top + pad };
  };

  const layout = () => {
    const hb = hero.getBoundingClientRect();
    W = hb.width;
    H = hb.height;
    const DPR = Math.min(2, window.devicePixelRatio || 1);
    cvs.width = Math.round(W * DPR);
    cvs.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    mobile = W <= 640;
    S = Math.min(W - 32, 1320);
    cx = W / 2;
    const pad = mobile ? 8 : 22;
    obstacles = ["h1", ".sub", ".ctas", ".proof"].map((s) => rectOf($(s), pad));
    const foot = rectOf($(".hero-foot"), 6);
    const textBottom = Math.max(...obstacles.map((o) => o.y1));
    cy = mobile ? Math.min(H - 150, foot.y0 - 64) : Math.min(H - Math.max(120, Math.min(170, H * 0.15)), foot.y0 - 70);
    GR = mobile ? 24 : 34;
    rMax = mobile ? 30 : Math.max(40, Math.min(56, S * 0.042));
    const fieldTop = mobile ? textBottom + 14 : 96;
    const fieldBot = cy - (mobile ? 18 : 30);
    const half = S / 2;
    const P = mobile ? POS_M : POS_D;
    pop.forEach((p) => {
      p.r = Math.max(mobile ? 1.8 : 2.2, rMax * Math.sqrt(p.w / pop[0].w));
    });
    pop.filter((p) => p.known).forEach((p) => {
      const [u, v] = P[p.id];
      p.x = cx + u * (half - p.r - 10);
      p.y = lerp(fieldTop, fieldBot, v);
    });
    // illustrative lockers: deterministic rejection sampling around the text and the Chair
    const R = rng(20261110);
    const placed = pop.filter((p) => p.known);
    pop.filter((p) => !p.known).forEach((p) => {
      let ok = false;
      for (let k = 0; k < 600; k++) {
        const x = cx + (R() * 2 - 1) * (half - 14), y = lerp(fieldTop, fieldBot + 10, R());
        if (obstacles.some((o) => hits(o, x, y, 10))) continue;
        if (Math.hypot(x - cx, y - cy) < (mobile ? 70 : 120)) continue;
        if (placed.some((q) => Math.hypot(q.x - x, q.y - y) < q.r + p.r + (mobile ? 22 : 40))) continue;
        p.x = x;
        p.y = y;
        ok = true;
        break;
      }
      if (!ok) {
        p.x = cx + (R() * 2 - 1) * half * 0.9;
        p.y = fieldBot;
      }
      placed.push(p);
    });
    if (user) user.r = Math.max(2.4, rMax * Math.sqrt(user.w / pop[0].w));
    placeLabels();
  };

  /** A cubic from a dot down, then sweeping into the Chair. */
  const ctrl = (x: number, y: number): Cubic => [x, y, x, lerp(y, cy, 0.55), lerp(cx, x, 0.16), cy - Math.max(40, Math.min(mobile ? 90 : 150, (cy - y) * 0.6)), cx, cy];
  const strokeCurve = (c: Cubic, t0: number, t1: number, n = 44) => {
    if (t1 <= t0) return;
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const [x, y] = bez(c, lerp(t0, t1, i / n));
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    }
    ctx.stroke();
  };

  // ------------------------------------------------------------ one meeting
  let mi = 0, clock = 0, last = 0, paused = false;
  let cur: Meet = meetings[0];
  let motes: Mote[] = [], excess: Mote[] = [], filed: Filed[] = [];

  const enterMeeting = (i: number) => {
    mi = (i + meetings.length) % meetings.length;
    cur = meetings[mi];
    clock = 0;
    cur.top.forEach((p) => {
      p.arrived = false;
    });
    const R = rng(cur.meeting * 7919);
    const topIds = cur.top.map((p) => p.id);
    const others = pop
      .filter((p) => !topIds.includes(p.id))
      .map((p) => [R(), p] as const)
      .sort((a, b) => a[0] - b[0])
      .slice(0, 7)
      .map((x) => x[1]);
    filed = [...cur.top.map((p) => ({ dot: byId[p.id], top: p, delay: 0 })), ...others.map((p) => ({ dot: p, delay: 0 }))];
    if (user) filed.push({ dot: user, delay: 0 });
    filed.forEach((f, k) => {
      f.delay = T.file + k * 120 + (f.top ? 0 : 60);
    });
    // pro-rata reward motes for the applied share, and the excess the 25% ring stops
    const N = Math.round(cur.applied * 2.6);
    const everyone = user ? [...pop, user] : pop;
    const tot = everyone.reduce((s, p) => s + p.w, 0);
    motes = [];
    everyone.forEach((p) => {
      const n = Math.max(1, Math.round((N * p.w) / tot));
      for (let k = 0; k < n; k++) motes.push({ dot: p, t0: T.pay + R() * 1700, dur: 1300 + R() * 700 });
    });
    excess = [];
    const ex = Math.round((cur.lockerAsked - cur.applied) * 2.6);
    for (let k = 0; k < ex; k++) {
      const d = everyone[Math.floor(R() * Math.min(everyone.length, 6))];
      excess.push({ dot: d, t0: T.pay + R() * 1500, dur: 520 + R() * 260 });
    }
    buildTags();
    pop.forEach((p) => {
      p.glint = 0;
    });
    if (user) user.glint = 0;
  };

  // ------------------------------------------------------------ DOM labels
  let tagEls: { el: HTMLElement; dot: Dot; p?: Top }[] = [];
  let chairEl: HTMLElement | null = null, gaugeEl: HTMLElement | null = null;
  const div = (cls: string) => {
    const el = document.createElement("div");
    el.className = cls;
    return el;
  };
  const p = (cls: string, text = "") => {
    const el = document.createElement("p");
    el.className = cls;
    el.textContent = text;
    return el;
  };
  const buildTags = () => {
    tagsEl.replaceChildren();
    chairEl = div("chair-l");
    const cb = document.createElement("b");
    cb.textContent = "the Chair";
    const cs = document.createElement("span");
    cs.textContent = mobile ? `meeting ${cur.meeting} · simulation` : `meeting ${cur.meeting} · ${cur.tier} · simulation`;
    chairEl.append(cb, cs);
    gaugeEl = div("gauge-l");
    const gb = document.createElement("b");
    gb.textContent = "locker share ≤ 25%";
    const gs = document.createElement("span");
    gs.dataset.g = "";
    gaugeEl.append(gb, gs);
    tagsEl.append(chairEl, gaugeEl);
    tagEls = cur.top.map((t, i) => {
      const d = byId[t.id];
      const el = div(`tag${mobile && i > 0 ? " mini" : ""}`);
      const share = t.w / cur.lockerWeight;
      const k = p("tag-k");
      const b = document.createElement("b");
      b.textContent = d.kind === "whale" ? "whale" : "locker";
      k.append(b, d.kind === "whale" ? ` · ${d.days} d · ${fmtW(t.w)} CHAIR-days · ${fmtPct(share)}` : ` · ${fmtW(t.w)} CHAIR-days · ${fmtPct(share)}`);
      const a = p("tag-a");
      const ai = document.createElement("i");
      ai.textContent = `answer ${t.rank}/${cur.top.length}`;
      const as = document.createElement("span");
      as.textContent = t.first;
      a.append(ai, as);
      el.append(k, p("tag-p", `“${trim(t.text, mobile ? 64 : 92)}”`), a);
      el.title = `${t.text}\n\n${t.answer}`;
      tagsEl.appendChild(el);
      return { el, dot: d, p: t };
    });
    if (user) {
      const el = div("tag you");
      tagsEl.appendChild(el);
      user.tag = el;
      fillUserTag();
    }
    placeLabels();
  };
  const fillUserTag = () => {
    if (!user?.tag) return;
    const r = 1 + pop.filter((x) => x.w > user!.w).length;
    const k = p("tag-k");
    const b = document.createElement("b");
    b.textContent = "you";
    k.append(b, ` · ${user.days} d · ${fmtW(user.w)} CHAIR-days`);
    user.tag.replaceChildren(
      k,
      p("tag-p", `rank ${r} of ${pop.length + 1} by weight · ${r <= 3 ? "in the brief next meeting" : "below the top 3: no answer, still paid pro rata"} · illustrative`),
    );
  };

  const placeLabels = () => {
    if (!chairEl || !gaugeEl) return;
    chairEl.classList.toggle("below", mobile);
    chairEl.style.left = `${mobile ? cx : cx - GR - 16}px`;
    chairEl.style.top = `${mobile ? cy + GR + 6 : cy - 16}px`;
    gaugeEl.style.left = `${cx + GR + (mobile ? 10 : 16)}px`;
    gaugeEl.style.top = `${cy - 16}px`;
    const placed: Rect[] = [
      ...obstacles,
      mobile ? { x0: cx - 70, y0: cy - GR - 6, x1: cx + GR + 150, y1: cy + GR + 40 } : { x0: cx - GR - 230, y0: cy - GR - 8, x1: cx + GR + 200, y1: cy + GR + 12 },
    ];
    const sx0 = mobile ? 6 : cx - S / 2 - 12, sx1 = mobile ? W - 6 : cx + S / 2 + 12;
    const items: { el: HTMLElement; dot: Dot; p?: Top }[] = [...tagEls];
    if (user?.tag) items.push({ el: user.tag, dot: user });
    items.forEach((t) => {
      const el = t.el, d = t.dot;
      const w = el.offsetWidth || 236, h = el.offsetHeight || 70;
      const g = 12;
      const opts: Record<string, [number, number]> = {
        r: [d.x + d.r + g, d.y - 14],
        l: [d.x - d.r - g - w, d.y - 14],
        a: [d.x - (d.x < cx ? d.r : w - d.r), d.y - d.r - g - h],
        b: [d.x - (d.x < cx ? d.r : w - d.r), d.y + d.r + g],
      };
      const order = d.x < cx ? ["r", "a", "b", "l"] : ["l", "a", "b", "r"];
      let best = { k: "r", x: 0, y: 0, R: { x0: 0, y0: 0, x1: 0, y1: 0 } as Rect };
      let bestCost = Infinity;
      for (const k of order) {
        const [x, y] = opts[k];
        const R = { x0: x, y0: y, x1: x + w, y1: y + h };
        let cost = placed.reduce((s, o) => s + overlap(R, o), 0);
        if (R.x0 < sx0 || R.x1 > sx1 || R.y0 < 76 || R.y1 > H - 8) cost += 1e6;
        if (cost < bestCost) {
          bestCost = cost;
          best = { k, x, y, R };
        }
        if (cost === 0) break;
      }
      // on a phone, a secondary answer that cannot be placed cleanly is dropped (the whale's stays)
      el.classList.toggle("drop", mobile && bestCost > 0 && !!t.p && t.p.rank > 1);
      el.classList.toggle("l", best.k === "l");
      el.classList.toggle("r", best.k !== "l");
      el.style.left = `${Math.round(best.x)}px`;
      el.style.top = `${Math.round(best.y)}px`;
      placed.push(best.R);
    });
  };

  // ------------------------------------------------------------ drawing
  const isTop = (d: Dot) => cur.top.some((t) => byId[t.id] === d);
  const pullOf = (d: Dot, t: number): [number, number] => {
    if (!isTop(d)) return [d.x, d.y];
    const k = outQ((t - T.rank) / 800) * (1 - outQ((t - T.hold - 1200) / 900));
    const dx = cx - d.x, dy = cy - d.y, L = Math.hypot(dx, dy) || 1;
    const m = (mobile ? 6 : 12) * k;
    return [d.x + (dx / L) * m, d.y + (dy / L) * m];
  };

  const drawChair = (t: number) => {
    ctx.fillStyle = GROUND;
    ctx.beginPath();
    ctx.arc(cx, cy, GR + 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(INK, 0.2);
    ctx.beginPath();
    ctx.arc(cx, cy, GR, 0, Math.PI * 2);
    ctx.stroke();
    // the bound: 25% of the ring, a hard tick at 3 o'clock
    const a0 = -Math.PI / 2, aB = a0 + (Math.PI * 2 * BOUND) / 100;
    ctx.strokeStyle = rgba(INK, 0.85);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(aB) * (GR - 6), cy + Math.sin(aB) * (GR - 6));
    ctx.lineTo(cx + Math.cos(aB) * (GR + 6), cy + Math.sin(aB) * (GR + 6));
    ctx.stroke();
    // what the ruling asked, then the clamp
    const ask = cur.lockerAsked, app = cur.applied;
    const grow = outQ((t - T.clamp) / 700);
    let shown = ask * grow;
    if (ask > BOUND) {
      const r = outQ((t - T.clamp - 1150) / 260); // the cut: 260 ms
      shown = lerp(ask * grow, app, r);
      if (t > T.clamp + 1150) {
        ctx.strokeStyle = rgba(VIO, 0.5);
        ctx.lineWidth = 1.2;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.arc(cx, cy, GR, aB, a0 + (Math.PI * 2 * ask) / 100);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    if (shown > 0.2) {
      const over = Math.max(0, shown - BOUND);
      ctx.lineCap = "butt";
      ctx.strokeStyle = rgba(VIO, 1);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(cx, cy, GR, a0, a0 + (Math.PI * 2 * Math.min(shown, BOUND)) / 100);
      ctx.stroke();
      if (over > 0) {
        ctx.strokeStyle = rgba(VIO, 0.45);
        ctx.beginPath();
        ctx.arc(cx, cy, GR, aB, aB + (Math.PI * 2 * over) / 100);
        ctx.stroke();
      }
    }
    // the share asked beyond 25% runs out toward its locks and stops dead at the ring
    excess.forEach((m) => {
      const s = (t - m.t0) / m.dur;
      if (s <= 0 || s >= 1.6) return;
      const [ex, ey] = bez(m.dot.c, 0.985);
      const ang = Math.atan2(ey - cy, ex - cx) + (((m.t0 * 13.7) % 1) - 0.5) * 0.5;
      const rr = lerp(5, GR - 1.5, outQ(Math.min(1, s)));
      const a = s < 1 ? 0.9 : 0.9 * (1 - (s - 1) / 0.6);
      ctx.fillStyle = rgba(VIO, a);
      ctx.beginPath();
      ctx.arc(cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr, 1.8, 0, Math.PI * 2);
      ctx.fill();
      if (s >= 1) {
        ctx.strokeStyle = rgba(VIO, a * 0.6);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(cx + Math.cos(ang) * GR, cy + Math.sin(ang) * GR, 2 + (s - 1) * 9, 0, Math.PI * 2);
        ctx.stroke();
      }
    });
    // the Chair itself
    const pulse = clamp01((t - T.rule) / 1000);
    if (pulse > 0 && pulse < 1) {
      ctx.strokeStyle = rgba(VIO, 0.5 * (1 - pulse));
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, lerp(10, GR + 34, outQ(pulse)), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.strokeStyle = rgba(VIO, 1);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, mobile ? 8 : 10, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = rgba(VIO, 1);
    ctx.beginPath();
    ctx.arc(cx, cy, mobile ? 2.6 : 3.2, 0, Math.PI * 2);
    ctx.fill();
  };

  const draw = (t: number, now: number) => {
    ctx.clearRect(0, 0, W, H);
    const everyone = user ? [...pop, user] : pop;
    // 1. standing hairlines: every lock can petition; a slow flow runs toward the Chair
    ctx.lineWidth = 1;
    everyone.forEach((d) => {
      const [x, y] = pullOf(d, t);
      d.c = ctrl(x, y);
      d.px = x;
      d.py = y;
      ctx.strokeStyle = rgba(INK, 0.07);
      strokeCurve(d.c, 0, 1, 36);
    });
    if (!RM) {
      ctx.strokeStyle = rgba(INK, 0.16);
      ctx.lineWidth = 1;
      everyone.forEach((d, i) => {
        const ph = (now / 9000 + i * 0.137) % 1;
        strokeCurve(d.c, ph, Math.min(1, ph + 0.05), 6);
      });
    }
    // 2. filed petitions draw in
    filed.forEach((f) => {
      const k = outQ((t - f.delay) / 900);
      if (k <= 0) return;
      const fade = 1 - clamp01((t - T.hold - 1400) / 800);
      ctx.strokeStyle = rgba(f.dot === user ? VIO : INK, (f.top ? 0.2 : 0.16) * fade + (f.dot === user ? 0.3 : 0));
      ctx.lineWidth = 1;
      strokeCurve(f.dot.c, 0, k);
    });
    // 3. the top 3 brighten
    const rk = outQ((t - T.rank) / 700) * (1 - clamp01((t - T.hold - 1400) / 800));
    if (rk > 0) {
      cur.top.forEach((tp, i) => {
        const d = byId[tp.id];
        ctx.strokeStyle = rgba(INK, (0.62 - i * 0.1) * rk);
        ctx.lineWidth = 1.25;
        strokeCurve(d.c, 0, 1, 60);
      });
    }
    // 4. answers travel back out along the same hairlines
    cur.top.forEach((tp, i) => {
      const s = (t - T.answer - i * 450) / 1300;
      if (s <= 0 || s >= 1.25) return;
      const d = byId[tp.id], head = 1 - inOut(Math.min(1, s));
      const tail = Math.min(1, head + 0.09);
      const a = s < 1 ? 1 : 1 - (s - 1) / 0.25;
      ctx.strokeStyle = rgba(VIO, a);
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      strokeCurve(d.c, head, tail, 12);
      const [hx, hy] = bez(d.c, head);
      ctx.fillStyle = rgba(VIO, a);
      ctx.beginPath();
      ctx.arc(hx, hy, 2.6, 0, Math.PI * 2);
      ctx.fill();
      if (s >= 1 && !tp.arrived) {
        tp.arrived = true;
        d.glint = 1;
      }
    });
    // 5. rewards: motes leave the Chair through the gauge and run out to every lock, pro rata
    motes.forEach((m) => {
      const s = (t - m.t0) / m.dur;
      if (s <= 0 || s >= 1) {
        if (s >= 1 && !m.done) {
          m.done = true;
          m.dot.glint = Math.min(1, (m.dot.glint || 0) + 0.22);
        }
        return;
      }
      const [x, y] = bez(m.dot.c, 1 - inOut(s));
      ctx.fillStyle = rgba(VIO, 0.9);
      ctx.beginPath();
      ctx.arc(x, y, mobile ? 1.5 : 1.8, 0, Math.PI * 2);
      ctx.fill();
    });
    // 6. the lockers
    everyone.forEach((d) => {
      const top = isTop(d);
      ctx.fillStyle = GROUND;
      ctx.beginPath();
      ctx.arc(d.px, d.py, d.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = rgba(INK, d.kind === "whale" ? 0.05 : 0.1);
      ctx.fill();
      if (d.glint > 0.01) {
        ctx.fillStyle = rgba(VIO, (d.r > 16 ? 0.16 : 0.42) * d.glint);
        ctx.fill();
      }
      ctx.lineWidth = d === user ? 1.6 : 1;
      ctx.strokeStyle = d === user ? rgba(VIO, 1) : rgba(INK, top && rk > 0.5 ? 0.9 : d.known ? 0.62 : 0.4);
      ctx.stroke();
      if (d.kind === "whale") {
        // a fine inner hairline: one lock, most of the weight
        ctx.strokeStyle = rgba(INK, 0.09);
        ctx.beginPath();
        ctx.arc(d.px, d.py, d.r * 0.62, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (!RM) d.glint *= 0.965;
    });
    drawChair(t);
  };

  // ------------------------------------------------------------ DOM sync + steps
  const setStep = (name: string) => {
    let seen = false;
    steps.forEach((li) => {
      if (li.dataset.step === name) {
        li.setAttribute("aria-current", "step");
        seen = true;
        li.classList.remove("done");
      } else {
        li.removeAttribute("aria-current");
        li.classList.toggle("done", !seen && !!name);
      }
    });
  };
  let lastStep = "";
  const say = () => {
    const ans = cur.top.map((tp) => `${tp.id === "W" ? "the whale" : "a locker"}: ${tp.first}`).join("; ");
    live.textContent =
      `Simulation meeting ${cur.meeting}. Answers: ${ans}. The chair asked locker share ${cur.lockerAsked}%` +
      (cur.lockerAsked > BOUND ? `; the cap of ${BOUND}% cuts it to ${BOUND}%.` : ", inside the bound.");
  };
  const sync = (t: number) => {
    const step = t < T.rank ? "file" : t < T.answer ? "rank" : t < T.clamp ? "answer" : t < T.pay ? "clamp" : "pay";
    if (step !== lastStep) {
      setStep(step);
      lastStep = step;
      if (step === "pay") say();
    }
    const shown = t > T.rank + 200 && t < T.hold + 1500;
    chairEl?.classList.toggle("on", t > 200);
    gaugeEl?.classList.toggle("on", t > 200);
    tagEls.forEach((x, i) => {
      x.el.classList.toggle("on", shown && t > T.rank + 200 + i * 150);
      x.el.querySelector(".tag-a")?.classList.toggle("on", shown && t > T.answer + i * 450 + 1300);
    });
    user?.tag?.classList.add("on");
    const g = gaugeEl?.querySelector<HTMLElement>("[data-g]");
    if (!g) return;
    let txt = "", cut = false;
    if (t > T.clamp + 700) {
      if (cur.lockerAsked > BOUND) {
        cut = t > T.clamp + 1150;
        txt = cut ? `asked ${cur.lockerAsked} → ${cur.applied} · clamped` : `asked ${cur.lockerAsked}`;
      } else txt = mobile ? `asked ${cur.lockerAsked} · in bounds` : `asked ${cur.lockerAsked} · inside the bound`;
    }
    if (g.textContent !== txt) g.textContent = txt;
    g.classList.toggle("cut", cut);
  };

  // ------------------------------------------------------------ loop
  let raf = 0;
  let visible = true;
  const frame = (now: number) => {
    raf = 0;
    const dt = Math.min(64, now - (last || now));
    last = now;
    if (!paused) clock += dt;
    if (clock >= T.end) enterMeeting(mi + 1);
    draw(clock, now);
    sync(clock);
    if (visible) raf = requestAnimationFrame(frame);
  };
  const still = () => {
    // reduced motion: one still frame after the clamp, answers in place
    cur.top.forEach((tp) => {
      tp.arrived = true;
    });
    draw(T.pay - 50, 0);
    sync(T.pay - 50);
    setStep("clamp");
  };

  // ------------------------------------------------------------ your lock (the signature interaction)
  let amt = 1e6;
  let at = { x: 0, y: 0 };
  const openChooserAt = (x: number, y: number) => {
    at = { x, y };
    chooser.hidden = false;
    const w = chooser.offsetWidth, h = chooser.offsetHeight;
    let left = x + 14;
    let top = y - h / 2;
    if (left + w > W - 12) left = x - 14 - w;
    left = Math.max(12, Math.min(W - w - 12, left));
    top = Math.max(80, Math.min(H - h - 12, top));
    chooser.style.left = `${left}px`;
    chooser.style.top = `${top}px`;
    paused = true;
    chooser.querySelector<HTMLElement>(".ch-go")?.focus({ preventScroll: true });
  };
  const closeChooser = () => {
    chooser.hidden = true;
    paused = false;
  };
  on(hero, "click", (e: MouseEvent) => {
    if (e.target !== cvs && e.target !== hero && e.target !== tagsEl) return;
    const hb = hero.getBoundingClientRect();
    const x = e.clientX - hb.left, y = e.clientY - hb.top;
    if (obstacles.some((o) => hits(o, x, y))) return;
    if (Math.hypot(x - cx, y - cy) < GR + 20 || y < 80) return;
    openChooserAt(x, y);
  });
  const amts = $$<HTMLButtonElement>("[data-amt]", chooser);
  amts.forEach((b) =>
    on(b, "click", () => {
      amts.forEach((x) => x.setAttribute("aria-checked", String(x === b)));
      amt = Number(b.dataset.amt);
    }),
  );
  $$<HTMLButtonElement>("[data-days]", chooser).forEach((b) =>
    on(b, "click", () => {
      const days = Number(b.dataset.days);
      user?.tag?.remove();
      user = { id: "U", kind: "you", known: true, days, w: amt * days, ...blank, c: [...blank.c], x: at.x, y: at.y, glint: 1 };
      user.r = Math.max(2.4, rMax * Math.sqrt(user.w / pop[0].w));
      const el = div("tag you on");
      tagsEl.appendChild(el);
      user.tag = el;
      fillUserTag();
      placeLabels();
      // your hairline files at once; you're in every meeting's pro-rata payout from now on
      filed.push({ dot: user, delay: clock });
      const R = rng(7);
      for (let k = 0; k < 3; k++) motes.push({ dot: user, t0: Math.max(clock, T.pay) + 400 + R() * 600, dur: 1400 });
      closeChooser();
      if (RM) still();
    }),
  );
  const closeBtn = chooser.querySelector("[data-chooser-close]");
  if (closeBtn) on(closeBtn, "click", closeChooser);
  on(document, "keydown", (e: KeyboardEvent) => {
    if (e.key === "Escape" && !chooser.hidden) closeChooser();
  });

  // ------------------------------------------------------------ boot
  let rz = 0;
  const onResize = () => {
    window.clearTimeout(rz);
    rz = window.setTimeout(() => {
      layout();
      if (RM) still();
    }, 120);
  };
  on(window, "resize", onResize);
  const io =
    typeof IntersectionObserver !== "undefined"
      ? new IntersectionObserver(([e]) => {
          visible = e.isIntersecting;
          if (visible && !raf && !RM) {
            last = 0;
            raf = requestAnimationFrame(frame);
          }
        })
      : null;
  let alive = true;
  let settle = 0;
  const boot = () => {
    if (!alive) return;
    layout();
    if (RM) {
      enterMeeting(2);
      still();
      return;
    }
    enterMeeting(0);
    clock = 120;
    raf = requestAnimationFrame(frame);
    io?.observe(hero);
    settle = window.setTimeout(layout, 1400); // re-measure the type once the entrance has settled
  };
  (document.fonts?.ready ?? Promise.resolve()).then(boot);

  return {
    replay: () => enterMeeting(mi),
    openChooser: () => openChooserAt(cx + (mobile ? 0.28 : 0.3) * S, cy - (mobile ? 60 : 90)),
    destroy: () => {
      alive = false;
      if (raf) cancelAnimationFrame(raf);
      window.clearTimeout(rz);
      window.clearTimeout(settle);
      io?.disconnect();
      cleanups.forEach((f) => f());
      tagsEl.replaceChildren();
    },
  };
}
