import { reducedMotion } from "./kit";

/**
 * One animation loop for every scene below the fold. A scene starts its clock
 * the first time it scrolls into view and draws only while visible; until then
 * (and always, under reduced motion) it shows a still key frame. Resizes
 * re-lay out every scene.
 */

export interface Scene {
  /** Measure canvases and place labels. */
  layout(): void;
  /** One frame, `t` ms after the scene first came into view. */
  draw(t: number, now: number): void;
  /** A key frame for before the scene starts, and for reduced motion. */
  still(): void;
  /** Called once, the first time the scene is visible. */
  onStart?(now: number): void;
}

interface Entry {
  el: Element;
  scene: Scene;
  vis: boolean;
  started: boolean;
  t0: number;
}

const entries = new Set<Entry>();
let io: IntersectionObserver | null = null;
let raf = 0;
let resizeTimer = 0;
let listening = false;

function loop(now: number) {
  raf = 0;
  for (const e of entries) if (e.vis && e.started) e.scene.draw(now - e.t0, now);
  if (entries.size) raf = requestAnimationFrame(loop);
}

function onResize() {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    for (const e of entries) {
      e.scene.layout();
      if (reducedMotion() || !e.started) e.scene.still();
    }
  }, 140);
}

function observer() {
  if (io || typeof IntersectionObserver === "undefined") return io;
  io = new IntersectionObserver(
    (records) => {
      for (const r of records) {
        for (const e of entries) {
          if (e.el !== r.target) continue;
          e.vis = r.isIntersecting;
          if (e.vis && !e.started && !reducedMotion()) {
            e.started = true;
            e.t0 = performance.now();
            e.scene.onStart?.(e.t0);
          }
        }
      }
    },
    { threshold: 0.12 },
  );
  return io;
}

/** Register a scene; returns its unregister. */
export function register(el: Element, scene: Scene): () => void {
  const e: Entry = { el, scene, vis: false, started: false, t0: 0 };
  entries.add(e);
  scene.layout();
  scene.still();
  const o = observer();
  if (o) o.observe(el);
  else if (!reducedMotion()) Object.assign(e, { vis: true, started: true, t0: performance.now() });
  if (!listening) {
    window.addEventListener("resize", onResize);
    listening = true;
  }
  if (!raf && !reducedMotion()) raf = requestAnimationFrame(loop);
  // canvas text uses the web fonts: redraw the key frame once they have loaded
  document.fonts?.ready.then(() => {
    if (entries.has(e) && !e.started) {
      e.scene.layout();
      e.scene.still();
    }
  });
  return () => {
    entries.delete(e);
    io?.unobserve(el);
    if (!entries.size) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      window.removeEventListener("resize", onResize);
      listening = false;
    }
  };
}

/** Restart a scene's clock (a replay button, a new result). */
export function restart(scene: Scene) {
  for (const e of entries) {
    if (e.scene !== scene) continue;
    e.t0 = performance.now();
    if (!e.started && !reducedMotion()) e.started = true;
  }
}
