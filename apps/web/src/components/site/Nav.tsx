"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { Brand } from "./Brand";

export interface NavLink {
  href: string;
  label: string;
}

/**
 * The fixed top bar. It turns frosted once the page scrolls, and marks the
 * section in view among its in-page links.
 */
export function Nav({ links, cta, solid = false }: { links: NavLink[]; cta: NavLink; solid?: boolean }) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const nav = ref.current;
    if (!nav) return;
    const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 24);
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    const anchors = Array.from(nav.querySelectorAll<HTMLAnchorElement>(".links a[href^='#']"));
    const byId = new Map(anchors.map((a) => [a.getAttribute("href")!.slice(1), a]));
    const io =
      typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver(
            (es) =>
              es.forEach((e) => {
                const a = byId.get(e.target.id);
                if (!a || !e.isIntersecting) return;
                anchors.forEach((x) => x.removeAttribute("aria-current"));
                a.setAttribute("aria-current", "true");
              }),
            { rootMargin: "-45% 0px -50% 0px" },
          )
        : null;
    byId.forEach((_, id) => {
      const s = document.getElementById(id);
      if (s && io) io.observe(s);
    });
    return () => {
      window.removeEventListener("scroll", onScroll);
      io?.disconnect();
    };
  }, []);

  return (
    <header className={`nav reveal${solid ? " solid" : ""}`} style={{ ["--d" as string]: 0 }} ref={ref}>
      <div className="wrap nav-in">
        <Brand />
        <nav className="links" aria-label="Primary">
          {links.map((l) => (
            <a key={l.href} href={l.href}>
              {l.label}
            </a>
          ))}
        </nav>
        <Link className="btn-ghost" href={cta.href}>
          {cta.label}
        </Link>
      </div>
    </header>
  );
}
