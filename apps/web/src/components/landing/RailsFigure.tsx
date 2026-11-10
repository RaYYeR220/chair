"use client";

import { useRef } from "react";
import { readFaces } from "@/components/canvas/kit";
import { createRails, RAIL_LEVERS, type RailLever } from "@/components/canvas/rails";
import { useScene } from "@/components/canvas/useScene";
import type { LeversView, Rules } from "@/lib/chair-types";
import type { ReplayMeeting } from "@/lib/views";

const COPY: Record<RailLever, { name: string; what: string }> = {
  tax_bps: { name: "Tax", what: "On every buy and sell." },
  endowment_share: { name: "Endowment share", what: "Of the tax, staked to pay for the brain." },
  locker_share: { name: "Locker share", what: "Of the tax, paid to lockers pro rata." },
  buyback_burn: { name: "Buyback-and-burn", what: "Bought on the curve from the buyback fund, then burned." },
};

/**
 * The four levers on their constitution rails. With `meetings`, each one's asks
 * replay onto the rails (the landing); without, the rails rest on today's
 * levers and the window each can move next meeting (the app).
 */
export function RailsFigure({
  rules,
  levers,
  meetings,
  numbers,
  loading = false,
  caption = true,
  showOldCap = true,
}: {
  rules: Rules | null;
  levers: LeversView | null;
  meetings: ReplayMeeting[];
  numbers: Record<RailLever, [string, string]>;
  loading?: boolean;
  caption?: boolean;
  showOldCap?: boolean;
}) {
  const capRef = useRef<HTMLElement>(null);
  const ref = useScene<HTMLElement>(
    (fig) => {
      const cv = Object.fromEntries(RAIL_LEVERS.map((k) => [k, fig.querySelector<HTMLCanvasElement>(`[data-rail="${k}"]`)!])) as Record<RailLever, HTMLCanvasElement>;
      return createRails(cv, { rules, levers, meetings, caption: caption && !loading ? capRef.current : null, showOldCap }, readFaces());
    },
    [rules, levers, meetings, caption, showOldCap, loading],
  );
  return (
    <figure
      className="rails rv"
      ref={ref}
      aria-label="The four levers drawn as rails. Each rail shows its bounds, the lever's value today and the window it can move in one meeting. The asks from testnet meetings land on the rails, and anything past a bound is cut back."
    >
      {RAIL_LEVERS.map((k) => (
        <div className={`rail-row${k === "locker_share" ? " is-cap" : ""}`} key={k}>
          <div className="rail-k">
            <b>{COPY[k].name}</b>
            <span className="m">{k}</span>
            <em>{COPY[k].what}</em>
          </div>
          <div className="rail-v">
            <canvas data-rail={k} aria-hidden="true" />
          </div>
          <div className="rail-n">
            <b>{numbers[k][0]}</b>
            <span>{numbers[k][1]}</span>
          </div>
        </div>
      ))}
      {caption ? (
        <figcaption className="rail-cap" ref={capRef}>
          {loading ? <span className="loading">Reading token3.chair-dev.testnet…</span> : null}
        </figcaption>
      ) : null}
    </figure>
  );
}
