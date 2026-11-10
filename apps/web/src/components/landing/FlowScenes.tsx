"use client";

import type { ReactNode } from "react";
import { createFlow, type FlowData } from "@/components/canvas/flow";
import { readFaces } from "@/components/canvas/kit";
import { useScene } from "@/components/canvas/useScene";

/** The five step scenes, played in turn while the list is on screen. */
export function FlowScenes({ data, children }: { data: FlowData | null; children: ReactNode }) {
  const ref = useScene<HTMLOListElement>((list) => createFlow(Array.from(list.querySelectorAll<HTMLElement>(":scope > li")), data, readFaces()), [data]);
  return (
    <ol className="flow rv" ref={ref}>
      {children}
    </ol>
  );
}
