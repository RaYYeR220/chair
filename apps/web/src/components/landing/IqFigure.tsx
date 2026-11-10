"use client";

import { useRef } from "react";
import { createIq, type IqData } from "@/components/canvas/iq";
import { useScene } from "@/components/canvas/useScene";

/** The ladder's rings, testnet's endowment today, and the simulated run's trail. */
export function IqFigure({ ladder, near, trail }: IqData) {
  const lblRef = useRef<HTMLDivElement>(null);
  const ref = useScene<HTMLDivElement>(
    (art) => (lblRef.current ? createIq(art.querySelector("canvas")!, lblRef.current, { ladder, near, trail }) : null),
    [ladder, near, trail],
  );
  return (
    <figure
      className="iq rv"
      aria-label={`The IQ ladder as rings around the Chair: asleep below ${ladder[0]?.min_near} NEAR, then one ring per model. ${near != null ? `A violet ring marks today's testnet endowment, ${near.toFixed(2)} NEAR. ` : ""}A trail of dots shows the simulated whale run's endowment day by day.`}
    >
      <div className="iq-art" ref={ref}>
        <canvas aria-hidden="true" />
        <div className="iq-lbl" ref={lblRef} aria-hidden="true" />
      </div>
    </figure>
  );
}
