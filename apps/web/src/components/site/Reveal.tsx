"use client";

import { useEffect } from "react";

/**
 * Scroll reveal for every `.rv` on the page, including sections that stream in
 * after the first paint. Failsafe: anything already scrolled past or on
 * screen is shown whatever the observer did, and printing shows everything.
 */
export function Reveal() {
  useEffect(() => {
    const root = document.documentElement;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || typeof IntersectionObserver === "undefined") {
      root.classList.add("revealed");
      return;
    }
    const seen = new WeakSet<Element>();
    const io = new IntersectionObserver(
      (es) =>
        es.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        }),
      { rootMargin: "0px 0px -6% 0px", threshold: 0.04 },
    );
    const scan = () =>
      document.querySelectorAll(".rv:not(.in)").forEach((el) => {
        if (seen.has(el)) return;
        seen.add(el);
        io.observe(el);
      });
    scan();
    const mo = new MutationObserver(scan);
    mo.observe(document.body, { childList: true, subtree: true });

    let q = 0;
    const failsafe = () => {
      q = 0;
      const H = window.innerHeight;
      document.querySelectorAll(".rv:not(.in)").forEach((el) => {
        if (el.getBoundingClientRect().top < H) el.classList.add("in");
      });
    };
    const onScroll = () => {
      if (!q) q = requestAnimationFrame(failsafe);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    const t = window.setTimeout(failsafe, 2500);
    const onPrint = () => root.classList.add("revealed");
    window.addEventListener("beforeprint", onPrint);
    return () => {
      io.disconnect();
      mo.disconnect();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("beforeprint", onPrint);
      window.clearTimeout(t);
      if (q) cancelAnimationFrame(q);
    };
  }, []);
  return null;
}
