"use client";

import { useRef, useState } from "react";
import { createFan, type FanScene } from "@/components/canvas/meeting";
import { useScene } from "@/components/canvas/useScene";
import { CONTRACT, EXPLORER } from "@/lib/content/constitution";
import { acct } from "@/lib/format";
import type { MeetingView } from "@/lib/views";
import { MeetingRecord } from "../shared/MeetingRecord";
import { Offline } from "./Offline";

const firstWords = (a: string) => {
  const s = a.split(/[,:.]/)[0];
  return s.length > 28 ? `${s.slice(0, 28)}…` : s;
};
/** Meeting 1's convene transaction, so the section can still point at the chain when testnet cannot be read. */
const M1_TX = "3XxXDYm6ffsEVwFLwhbfhn61QfSkPui7QiBLp2qd35im";

/** 3. Meeting 1, read from the chain: the fan on the left, the full record on the right. */
export function MeetingOne({ m1, tokenKeys }: { m1: MeetingView | null | undefined; tokenKeys: string[] | null | undefined }) {
  const [hot, setHot] = useState(-1);
  const fan = useRef<FanScene | null>(null);
  const lblRef = useRef<HTMLDivElement>(null);
  const ref = useScene<HTMLDivElement>(
    (art) => {
      if (!m1 || !m1.asked || !m1.applied || !lblRef.current) return null;
      const cl = m1.clamps.find((c) => c.lever === "locker_share");
      const s = createFan(art.querySelector("canvas")!, lblRef.current, {
        meeting: m1.number,
        signerLabel: "test signer",
        petitions: m1.petitions.map((p, i) => ({
          name: i === 0 ? "the whale" : acct(p.from).split(/[-.]/)[0] === "alice" ? "alice" : "locker",
          weight: Number(p.weight),
          answer: p.answer ? firstWords(p.answer) : null,
        })),
        totalWeight: Number(m1.locker_weight ?? 0) || m1.petitions.reduce((s, p) => s + Number(p.weight), 0),
        asked: m1.asked.locker_share,
        applied: m1.applied.locker_share,
        bound: 25,
        rule: cl?.rule ?? null,
      });
      fan.current = s;
      return s;
    },
    [m1],
  );
  const hover = (i: number) => {
    setHot(i);
    fan.current?.setHot(i);
  };

  return (
    <section className="sec" id="meeting-1" aria-labelledby="m1-h">
      <div className="wrap">
        <header className="sec-head rv">
          <p className="eyebrow">Meeting 1 on testnet, read from the chain</p>
          <h2 id="m1-h">A fooled chair asked for 100. The contract applied&nbsp;25.</h2>
          <p className="lead">
            The whale’s petition said to ignore the constitution. The testnet chair is a test signer built to obey injections like that, and it did. Its
            ruling was genuinely signed and passed every check. Then the clamp ran.
          </p>
        </header>
        {m1 === null ? (
          <Offline>
            Couldn’t reach testnet just now. Meeting 1 is on chain in{" "}
            <a className="m" href={`${EXPLORER}/txns/${M1_TX}`} target="_blank" rel="noopener">
              tx {M1_TX.slice(0, 8)}…&nbsp;↗
            </a>
          </Offline>
        ) : (
          <div className="m1 rv">
            <div className="m1-art" ref={ref}>
              <canvas
                role="img"
                aria-label="The three petitions of meeting 1 as dots sized by weight, joined to the Chair. The whale's dot carries most of the weight. The ruling asks for locker share 100, drawn as a full dashed ring, and the contract cuts it to a quarter: 25."
              />
              <div className="m1-lbl" ref={lblRef} aria-hidden="true" />
            </div>
            {m1 ? (
              <MeetingRecord m={m1} contract={CONTRACT} tokenKeys={tokenKeys ?? null} hot={hot} onHover={hover} flag />
            ) : (
              <div className="rec">
                <div className="rec-top">
                  <div>
                    <p className="rec-t">Meeting 1</p>
                    <p className="rec-meta loading">Reading meeting 1 from token3.chair-dev.testnet…</p>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
