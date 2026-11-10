"use client";

import { type DependencyList, useEffect, useRef } from "react";
import { register, type Scene } from "./scheduler";

/**
 * Mount a canvas scene on the returned ref's element: `make` builds it once
 * the element exists, the scheduler runs it while it is on screen, and it is
 * torn down (with its `destroy`, if any) when the component unmounts or the
 * deps change.
 */
export function useScene<T extends HTMLElement>(make: (el: T) => (Scene & { destroy?(): void }) | null, deps: DependencyList) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const scene = make(el);
    if (!scene) return;
    const off = register(el, scene);
    return () => {
      off();
      scene.destroy?.();
    };
  }, deps);
  return ref;
}
