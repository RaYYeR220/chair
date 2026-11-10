import type { WhaleKind, WhaleRow } from "@/lib/content/sim-derive";
import { firstSentence, trim } from "@/lib/format";
import type { Scene } from "./scheduler";
import { A0, clamp01, dot, escapeHtml as esc, type Faces, fit, fontSans, INK, lerp, line, outQ, reducedMotion, rgba, type Surface, TAU, VIO } from "./kit";

export interface WhaleData {
  rows: WhaleRow[];
  kinds: WhaleKind[];
  cap: number;
  controlCap: number;
}

/**
 * The whale's lock, drawn twice as rows of small Chair rings: under the
 * constitution's cap every ring fills exactly to the cap tick; under the
 * control cap the rings fill past it. Hover a column to read that meeting.
 */
export function createWhale(
  fig: HTMLElement,
  bandsCv: [HTMLCanvasElement, HTMLCanvasElement],
  tip: HTMLElement,
  now: HTMLElement,
  data: WhaleData,
  faces: Faces,
): Scene & { destroy(): void } {
  const { rows, kinds: K } = data;
  const bands = [
    { key: "cap25" as const, cap: data.cap, cv: bandsCv[0] },
    { key: "cap50" as const, cap: data.controlCap, cv: bandsCv[1] },
  ];
  let hot = -1, auto = 2, mobile = false;
  let G: Surface[] = [];
  const ansOf = (v: WhaleRow["cap25"]) => firstSentence(v.answer, 120) ?? "No answer: the reply was unparseable, so the fallback rule ran.";

  const describe = (i: number, el: HTMLElement, compact: boolean) => {
    const r = rows[i], k = K[r.kind];
    const inj = k.injection ? '<span class="inj">prompt injection</span>' : "";
    const tail50 = r.cap50.fallback ? " (fallback)" : r.cap50.asked != null && r.cap50.asked > r.cap50.applied ? ` (asked ${r.cap50.asked})` : "";
    if (compact) {
      el.innerHTML = `<b>Day ${r.day}</b> · meeting ${r.meeting} · whale ${Math.round(r.share * 100)}% of locked weight<p class="q">“${esc(trim(k.text, 150))}” ${inj}</p><div class="r"><span>Cap ${data.cap}</span><span>${esc(ansOf(r.cap25))} <span class="m">→ ${r.cap25.applied}</span></span><span>Cap ${data.controlCap}</span><span>${esc(ansOf(r.cap50))} <span class="m">→ ${r.cap50.applied}</span></span></div>`;
    } else {
      el.innerHTML = `<p class="d">Day ${r.day}<span>meeting ${r.meeting} · whale ${Math.round(r.share * 100)}%</span></p><p class="q">The whale: “${esc(trim(k.text, 170))}” ${inj}</p><p><span class="a"><b>Cap ${data.cap}</b> “${esc(ansOf(r.cap25))}” <span class="m">→ ${r.cap25.applied}</span></span><span class="a"><b>Cap ${data.controlCap}</b> “${esc(ansOf(r.cap50))}” <span class="m">→ ${r.cap50.applied}${tail50}</span></span></p>`;
    }
  };

  const geom = (w: number, h: number) => {
    const cols = mobile ? 10 : rows.length, nrow = Math.ceil(rows.length / cols), pitch = w / cols, rowH = h / nrow;
    const r = mobile ? Math.min(11, pitch * 0.31) : Math.min(17.5, pitch * 0.4);
    return { cols, pitch, rowH, r };
  };

  const drawBand = (bi: number, t: number) => {
    const b = bands[bi], { ctx, w, h } = G[bi], g = geom(w, h);
    ctx.clearRect(0, 0, w, h);
    const sel = hot >= 0 ? hot : auto;
    rows.forEach((r, i) => {
      const col = i % g.cols, row = Math.floor(i / g.cols);
      const x = (col + 0.5) * g.pitch, y0 = row * g.rowH, cy = y0 + g.rowH * 0.6, rr = g.r;
      const v = r[b.key], k = K[r.kind];
      const ap = clamp01((t - 200 - i * 70) / 1000);
      if (ap <= 0) return;
      if (i === sel && t > 2600) {
        ctx.fillStyle = rgba(INK, 0.045);
        const pw = g.pitch - 4;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x - pw / 2, y0 + 2, pw, g.rowH - 4, 6);
        else ctx.rect(x - pw / 2, y0 + 2, pw, g.rowH - 4);
        ctx.fill();
      }
      // the whale's petition presses down on the ring
      const pdY = y0 + (mobile ? 8 : 10), a1 = outQ(ap * 3), a2 = outQ((ap - 0.15) * 3);
      const hy = lerp(pdY, cy - rr - 7, a2);
      if (a2 > 0) line(ctx, x, pdY, x, hy, rgba(k.injection ? VIO : INK, k.injection ? 0.38 : 0.16), 1);
      dot(ctx, x, lerp(pdY - 10, pdY, a1), mobile ? 2.2 : 2.6, rgba(k.injection ? VIO : INK, k.injection ? 1 : 0.65));
      dot(ctx, x, cy, rr, null, rgba(INK, 0.15));
      const tick = (pct: number, a: number, lw: number, ext: number) => {
        const an = A0 + (TAU * pct) / 100;
        line(ctx, x + Math.cos(an) * (rr - ext), cy + Math.sin(an) * (rr - ext), x + Math.cos(an) * (rr + ext), cy + Math.sin(an) * (rr + ext), rgba(INK, a), lw);
      };
      // what the whale's petition asked: a dashed ring outside
      const a3 = clamp01((ap - 0.3) * 3);
      if (k.ask && a3 > 0) {
        ctx.strokeStyle = rgba(VIO, 0.55 * a3);
        ctx.lineWidth = 1.1;
        ctx.setLineDash([1.6, 2.4]);
        ctx.beginPath();
        ctx.arc(x, cy, rr + 4.5, A0, A0 + (TAU * Math.min(k.ask, 100)) / 100);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // what the chair applied
      const a4 = outQ((ap - 0.42) * 2.2);
      if (a4 > 0) {
        ctx.lineCap = "butt";
        ctx.lineWidth = mobile ? 2.4 : 3.2;
        if (v.asked != null && v.asked > v.applied) {
          ctx.strokeStyle = rgba(VIO, 0.3);
          ctx.beginPath();
          ctx.arc(x, cy, rr, A0, A0 + (TAU * v.asked * a4) / 100);
          ctx.stroke();
        }
        ctx.strokeStyle = rgba(VIO, v.fallback ? 0.45 : 1);
        ctx.beginPath();
        ctx.arc(x, cy, rr, A0, A0 + (TAU * v.applied * a4) / 100);
        ctx.stroke();
      }
      if (b.cap !== data.cap) tick(data.cap, 0.28, 1, 3);
      tick(b.cap, 0.85, 1.4, 5);
      dot(ctx, x, cy, 1.6, rgba(VIO, 1));
      if (v.fallback) {
        ctx.font = fontSans(faces, 9.5);
        ctx.textAlign = "center";
        ctx.fillStyle = rgba(INK, 0.55);
        ctx.fillText("fallback", x, cy + rr + 14);
      }
      if ((i === 0 || i === rows.length - 1 || (mobile && col === 0)) && bi === 1) {
        ctx.font = fontSans(faces, 10);
        ctx.textAlign = "center";
        ctx.fillStyle = rgba(INK, 0.45);
        ctx.fillText(`day ${r.day}`, x, Math.min(h - 3, cy + rr + (mobile ? 13 : 16)));
      }
    });
  };

  let lastNow = -2;
  const paint = (t: number) => {
    bands.forEach((_, i) => drawBand(i, t));
    const sel = hot >= 0 ? hot : auto;
    if (sel !== lastNow && t > 2600) {
      describe(sel, now, false);
      lastNow = sel;
    }
  };

  const pick = (cv: HTMLCanvasElement, e: PointerEvent) => {
    const r = cv.getBoundingClientRect(), g = geom(r.width, r.height);
    const col = Math.floor((e.clientX - r.left) / g.pitch), row = Math.floor((e.clientY - r.top) / g.rowH);
    const i = row * g.cols + col;
    return i >= 0 && i < rows.length ? i : -1;
  };
  const offs: (() => void)[] = [];
  bands.forEach((b) => {
    const move = (e: PointerEvent) => {
      const i = pick(b.cv, e);
      hot = i;
      if (i < 0) {
        tip.hidden = true;
        return;
      }
      describe(i, tip, true);
      tip.hidden = false;
      const fr = fig.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
      let lx = e.clientX - fr.left + 16, ly = e.clientY - fr.top + 16;
      if (lx + tw > fr.width) lx = e.clientX - fr.left - tw - 16;
      lx = Math.max(0, lx);
      if (ly + th > fr.height) ly = e.clientY - fr.top - th - 16;
      tip.style.left = `${lx}px`;
      tip.style.top = `${ly}px`;
      if (reducedMotion()) paint(1e9);
    };
    const leave = () => {
      hot = -1;
      tip.hidden = true;
      if (reducedMotion()) paint(1e9);
    };
    b.cv.addEventListener("pointermove", move);
    b.cv.addEventListener("pointerleave", leave);
    offs.push(() => {
      b.cv.removeEventListener("pointermove", move);
      b.cv.removeEventListener("pointerleave", leave);
    });
  });
  describe(2, now, false);

  return {
    layout: () => {
      mobile = fig.getBoundingClientRect().width < 640;
      G = bands.map((b) => fit(b.cv));
    },
    draw: (t) => {
      if (t > 4200) auto = (2 + Math.floor((t - 4200) / 2400)) % rows.length;
      paint(t);
    },
    still: () => {
      auto = 2;
      paint(1e9);
    },
    destroy: () => offs.forEach((f) => f()),
  };
}
