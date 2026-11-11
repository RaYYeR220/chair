"use client";

import { useRef, useState } from "react";
import { createFan, type FanScene } from "@/components/canvas/meeting";
import { useScene } from "@/components/canvas/useScene";
import type { MeetingView } from "@/lib/views";
import { MeetingRecord } from "../shared/MeetingRecord";

const firstWords = (a: string) => {
  const s = a.split(/[,:.]/)[0];
  return s.length > 28 ? `${s.slice(0, 28)}…` : s;
};

/**
 * One meeting read from the chain: the fan on the left (its briefed petitions
 * joined to the Chair, the answers travelling back, locker_share asked and
 * applied under the 25% ring), the full record on the right.
 */
export function MeetingFan({
  m,
  names,
  signerLabel,
  tokenKeys,
  label,
}: {
  m: MeetingView;
  /** The fan's short name for each petitioner. */
  names: (from: string, i: number) => string;
  signerLabel: string;
  tokenKeys?: string[] | null;
  label: string;
}) {
  const [hot, setHot] = useState(-1);
  const fan = useRef<FanScene | null>(null);
  const lblRef = useRef<HTMLDivElement>(null);
  const ref = useScene<HTMLDivElement>(
    (art) => {
      if (!m.asked || !m.applied || !lblRef.current) return null;
      const cl = m.clamps.find((c) => c.lever === "locker_share");
      const s = createFan(art.querySelector("canvas")!, lblRef.current, {
        meeting: m.number,
        signerLabel,
        petitions: m.petitions.map((p, i) => ({
          name: names(p.from, i),
          weight: Number(p.weight),
          answer: p.answer ? firstWords(p.answer) : null,
        })),
        totalWeight: Number(m.locker_weight ?? 0) || m.petitions.reduce((s, p) => s + Number(p.weight), 0),
        asked: m.asked.locker_share,
        applied: m.applied.locker_share,
        bound: 25,
        rule: cl?.rule ?? null,
      });
      fan.current = s;
      return s;
    },
    [m],
  );
  const hover = (i: number) => {
    setHot(i);
    fan.current?.setHot(i);
  };

  return (
    <div className="m1 rv">
      <div className="m1-art" ref={ref}>
        <canvas role="img" aria-label={label} />
        <div className="m1-lbl" ref={lblRef} aria-hidden="true" />
      </div>
      <MeetingRecord m={m} tokenKeys={tokenKeys} hot={hot} onHover={hover} flag />
    </div>
  );
}

/** The record's shell while the chain is read. */
export function MeetingLoading({ n, contract }: { n: number; contract: string }) {
  return (
    <div className="m1 rv">
      <div className="m1-art" aria-hidden="true" />
      <div className="rec">
        <div className="rec-top">
          <div>
            <p className="rec-t">Meeting {n}</p>
            <p className="rec-meta loading">
              Reading meeting {n} from {contract}…
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
