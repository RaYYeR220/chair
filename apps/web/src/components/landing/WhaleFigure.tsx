"use client";

import { type ReactNode, useRef } from "react";
import { readFaces } from "@/components/canvas/kit";
import { useScene } from "@/components/canvas/useScene";
import { createWhale } from "@/components/canvas/whale";
import type { WhaleKind, WhaleRow } from "@/lib/content/sim-derive";

interface Band {
  title: string;
  sub: string;
  line: ReactNode;
  near: number;
  take: number;
}

/** The whale's lock, drawn under both caps, with a hover read-out per meeting. */
export function WhaleFigure({
  rows,
  kinds,
  cap,
  controlCap,
  bands,
  source,
}: {
  rows: WhaleRow[];
  kinds: WhaleKind[];
  cap: number;
  controlCap: number;
  bands: [Band, Band];
  source: ReactNode;
}) {
  const tipRef = useRef<HTMLDivElement>(null);
  const nowRef = useRef<HTMLDivElement>(null);
  const ref = useScene<HTMLElement>(
    (fig) => {
      const cvs = Array.from(fig.querySelectorAll<HTMLCanvasElement>("[data-whale-cv]")) as [HTMLCanvasElement, HTMLCanvasElement];
      if (!tipRef.current || !nowRef.current || cvs.length < 2) return null;
      return createWhale(fig, cvs, tipRef.current, nowRef.current, { rows, kinds, cap, controlCap }, readFaces());
    },
    [rows, kinds, cap, controlCap],
  );
  return (
    <figure
      className="whale rv"
      ref={ref}
      aria-label={`${rows.length} meetings of the whale's lock, drawn twice as rows of small Chair rings. Top row, the constitution's cap of ${cap}: every ring fills to the ${cap} tick. Bottom row, a control with the cap at ${controlCap}: the rings fill past ${cap}.`}
    >
      {bands.map((b, i) => (
        <div className={`band${i === 0 ? " band-lead" : ""}`} key={b.title}>
          <div className="band-head">
            <div className="band-k">
              <p className="band-t">
                <b>{b.title}</b> {b.sub}
              </p>
              <p className="band-s">{b.line}</p>
            </div>
            <p className="band-n">
              {b.near.toFixed(2)} NEAR
              <span>
                to the whale · {b.take.toFixed(2)}% of all tax
              </span>
            </p>
          </div>
          <div className="whale-art">
            <canvas data-whale-cv="" aria-hidden="true" />
          </div>
        </div>
      ))}
      <div className="whale-tip" ref={tipRef} hidden />
      <div className="whale-now" ref={nowRef} aria-live="off" />
      <figcaption className="whale-key">
        <span>
          <i className="k-arc" />
          locker share applied
        </span>
        <span>
          <i className="k-ghost" />
          what the whale’s petition asked
        </span>
        <span>
          <i className="k-inj" />
          petition was a prompt injection
        </span>
        <span>
          <i className="k-tick" />
          the cap
        </span>
        <span className="whale-src">{source}</span>
      </figcaption>
    </figure>
  );
}
