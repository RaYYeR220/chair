import { modelName } from "@/lib/format";
import type { Scene } from "./scheduler";
import { chairNode, dot, fit, INK, lerp, line, reducedMotion, rgba, rng, type Surface, TAU, VIO } from "./kit";

export interface IqData {
  /** The ladder, lowest first: model and the endowment (NEAR) that wakes it. */
  ladder: { model: string; min_near: number }[];
  /** Testnet's endowment now, or null when it could not be read. */
  near: number | null;
  /** The simulated whale run: endowment (NEAR) and tier index per day. */
  trail: { endowment: number[]; tier: number[] };
}

/**
 * The IQ ladder as rings around the Chair on a log scale: asleep inside the
 * first, then one ring per model. A violet ring marks testnet's endowment
 * today; a trail of dots shows the simulated whale run, a dot a day.
 */
export function createIq(cv: HTMLCanvasElement, lbl: HTMLElement, data: IqData): Scene {
  const TH = data.ladder.map((t) => t.min_near);
  const run = data.trail;
  const firstDeep = run.tier.indexOf(2);
  const last = run.endowment[run.endowment.length - 1];
  const logMax = Math.log10(TH[TH.length - 1]);
  const rad = (n: number, R: number) => (n <= 1 ? R * 0.17 * n : R * (0.17 + (0.83 * Math.log10(Math.min(n, TH[TH.length - 1] * 4))) / logMax));
  let G: Surface | null = null;
  let cx = 0, cy = 0, R = 0, mobile = false;

  lbl.replaceChildren();
  const mk = (cls: string) => {
    const el = document.createElement("div");
    el.className = `il ${cls}`;
    lbl.appendChild(el);
    return el;
  };
  const lab = {
    asleep: mk("c dim"),
    t: TH.map(() => mk("c")),
    n: TH.map(() => mk("c dim")),
    now: data.near != null ? mk("c now") : null,
    deep: firstDeep > 0 ? mk("") : null,
    end: mk(""),
  };
  const bold = (el: HTMLElement, b: string, rest = "") => {
    const x = document.createElement("b");
    x.textContent = b;
    el.replaceChildren(x, rest);
  };

  const layout = () => {
    G = fit(cv);
    const { w, h } = G;
    mobile = w < 560;
    cx = w / 2;
    cy = h - (mobile ? 46 : 56);
    R = Math.min(w / 2 - (mobile ? 12 : 40), cy - (mobile ? 30 : 46));
    const r = TH.map((n) => rad(n, R));
    const nm = (m: string) => (mobile ? modelName(m).split("-")[0].replace(" K3", "") : modelName(m));
    const put = (el: HTMLElement, x: number, y: number) => {
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
    };
    bold(lab.asleep, "asleep");
    put(lab.asleep, cx - r[0] / 2, cy + 8);
    lab.asleep.style.display = mobile ? "none" : "";
    data.ladder.forEach((t, i) => {
      const top = i === data.ladder.length - 1;
      if (top) {
        bold(lab.t[i], nm(t.model), mobile ? "" : ` from ${t.min_near} NEAR · never reached in the simulation`);
        put(lab.t[i], cx, cy - R - (mobile ? 26 : 34));
        lab.t[i].style.whiteSpace = "nowrap";
        const b = lab.t[i].firstChild as HTMLElement;
        b.style.display = "inline";
        b.style.marginRight = "6px";
      } else {
        bold(lab.t[i], nm(t.model));
        put(lab.t[i], cx - (r[i] + r[i + 1]) / 2, cy + 8);
      }
      lab.n[i].textContent = mobile ? String(t.min_near) : `${t.min_near} NEAR`;
      put(lab.n[i], cx + r[i], cy + 8);
    });
    if (lab.now && data.near != null) {
      bold(lab.now, "testnet now", `${data.near.toFixed(2)} NEAR`);
      put(lab.now, cx, cy - rad(data.near, R) - (mobile ? 52 : 58));
    }
    const at = (d: number) => {
      const a = Math.PI + (Math.PI * (d + 0.5)) / run.endowment.length, rr = rad(run.endowment[d], R);
      return [cx + Math.cos(a) * rr, cy + Math.sin(a) * rr];
    };
    if (lab.deep) {
      const p = at(firstDeep);
      lab.deep.textContent = `day ${firstDeep} · ${modelName(data.ladder[1]?.model)} wakes`;
      put(lab.deep, p[0] + 10, p[1] - 22);
      lab.deep.style.display = mobile ? "none" : "";
    }
    const pe = at(run.endowment.length - 1);
    lab.end.textContent = `day ${run.endowment.length - 1} · ${last.toFixed(1)} NEAR`;
    put(lab.end, pe[0] - 150, pe[1] - 30);
    lab.end.style.display = mobile ? "none" : "";
  };

  const motes: { a: number; t0: number; dur: number }[] = [];
  const R0 = rng(31);
  const paint = (t: number) => {
    if (!G) return;
    const { ctx, w, h } = G;
    const RM = reducedMotion();
    ctx.clearRect(0, 0, w, h);
    const r = TH.map((n) => rad(n, R));
    // fees drifting in toward the Chair
    if (!RM) {
      while (motes.length < 26) motes.push({ a: Math.PI + R0() * Math.PI, t0: t + R0() * 9000, dur: 7000 + R0() * 4000 });
      for (let i = motes.length - 1; i >= 0; i--) {
        const m = motes[i], s = (t - m.t0) / m.dur;
        if (s >= 1) {
          motes.splice(i, 1);
          continue;
        }
        if (s <= 0) continue;
        const rr = lerp(R + 24, 10, s), al = Math.min(1, s * 5, (1 - s) * 5) * 0.55;
        dot(ctx, cx + Math.cos(m.a) * rr, cy + Math.sin(m.a) * rr, 1.5, rgba(VIO, al));
      }
    }
    // baseline and rings
    line(ctx, cx - R - 20, cy + 0.5, cx + R + 20, cy + 0.5, rgba(INK, 0.16), 1);
    r.forEach((rr, i) => {
      ctx.strokeStyle = rgba(INK, i === 0 ? 0.55 : 0.42);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, rr, Math.PI, TAU);
      ctx.stroke();
      line(ctx, cx + rr, cy - 4, cx + rr, cy + 4, rgba(INK, 0.5), 1);
      line(ctx, cx - rr, cy - 4, cx - rr, cy + 4, rgba(INK, 0.3), 1);
    });
    // the simulated whale run, a dot a day
    const n = run.endowment.length, k = RM || t >= 1e8 ? n : Math.min(n, Math.floor((t - 400) / 45));
    for (let d = 0; d < k; d++) {
      const a = Math.PI + (Math.PI * (d + 0.5)) / n, rr = rad(run.endowment[d], R), tier = run.tier[d];
      dot(ctx, cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, mobile ? 1.7 : 2.2, rgba(INK, tier === 0 ? 0.25 : tier === 1 ? 0.5 : 0.8));
    }
    if (lab.deep) lab.deep.style.opacity = k > firstDeep ? "1" : "0";
    lab.end.style.opacity = k >= n ? "1" : "0";
    // today on testnet
    if (data.near != null) {
      const rn = rad(data.near, R);
      const br = RM ? 0 : (Math.sin(t / 900) + 1) / 2;
      ctx.fillStyle = rgba(VIO, 0.05 + 0.03 * br);
      ctx.beginPath();
      ctx.arc(cx, cy, rn, Math.PI, TAU);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = rgba(VIO, 1);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, rn, Math.PI, TAU);
      ctx.stroke();
      line(ctx, cx, cy - rn - 2, cx, cy - rn - (mobile ? 12 : 16), rgba(VIO, 0.6), 1);
    }
    chairNode(ctx, cx, cy, mobile ? 0.8 : 1);
  };
  return { layout, draw: (t) => paint(t), still: () => paint(1e9) };
}
