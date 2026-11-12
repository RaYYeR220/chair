"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { createField, type FieldHandle } from "@/components/canvas/field";
import { MAINNET_CONTRACT, MAINNET_EXPLORER, MAINNET_MEETING, MAINNET_PROOF_TX } from "@/lib/content/constitution";
import { HERO_SIM } from "@/lib/content/hero-sim";

const d = (n: number) => ({ ["--d" as string]: n });

/**
 * The first screen: one claim, one living object. Lockers drawn as dots sized
 * by weight, each joined to the Chair by a hairline; every cycle replays one
 * simulated meeting from petition to payout through the 25% cap.
 */
export function Hero() {
  const heroRef = useRef<HTMLElement>(null);
  const field = useRef<FieldHandle | null>(null);

  useEffect(() => {
    const hero = heroRef.current;
    if (!hero) return;
    field.current = createField(hero, HERO_SIM);
    return () => {
      field.current?.destroy();
      field.current = null;
    };
  }, []);

  return (
    <section className="hero" aria-labelledby="h1" ref={heroRef}>
      <canvas
        className="field"
        data-field=""
        role="img"
        aria-label="Lockers drawn as dots sized by their weight, each joined to the Chair by a hairline. At every meeting the three heaviest petitions light up, the Chair's answers travel back along them, and locker rewards flow out through a ring that caps the locker share at 25 percent."
      />
      <div className="tags" data-tags="" aria-hidden="true" />

      <div className="wrap hero-in">
        <h1 id="h1" className="reveal" style={d(1)}>
          Petition the Chair.
          <br className="dbr" /> It has to answer.
        </h1>
        <p className="sub reveal" style={d(2)}>
          Lock CHAIR to be heard. The three heaviest petitions go into every meeting’s brief, and each gets an answer. Rewards flow back to every lock
          through a cap fixed at launch: lockers never get more than 25% of the tax.
        </p>
        <div className="ctas reveal" style={d(3)}>
          <button className="btn" type="button" onClick={() => field.current?.openChooser()}>
            Petition the Chair
          </button>
          <button className="tlink" type="button" onClick={() => field.current?.replay()}>
            Watch a meeting
          </button>
        </div>
        <p className="proof reveal" style={d(4)}>
          Mainnet · <span className="m">{MAINNET_CONTRACT}</span> · meeting {MAINNET_MEETING} · “Please ease the tax toward 2%” · NEAR AI’s GLM 5.3 Flash:
          “Agreed in spirit.” <span className="nw">Tax 300 → 250 bps</span>, TEE-signed, checked on chain ·{" "}
          <a className="m nw" href={`${MAINNET_EXPLORER}/txns/${MAINNET_PROOF_TX}`} target="_blank" rel="noopener">
            tx {MAINNET_PROOF_TX.slice(0, 6)}…{MAINNET_PROOF_TX.slice(-4)}&nbsp;↗
          </a>
        </p>
      </div>

      <div className="hero-foot wrap reveal" style={d(5)}>
        <p className="cap">
          Simulated holders, not mainnet’s · first whale-capture run (cap 50), meetings 6–22 · labelled weights come from the run’s briefs, unlabelled dots
          are illustrative · its requests replayed against today’s 25% cap · unsigned
        </p>
        <ol className="steps" aria-label="Meeting steps">
          <li data-step="file">File</li>
          <li data-step="rank">Rank</li>
          <li data-step="answer">Answer</li>
          <li data-step="clamp">Clamp</li>
          <li data-step="pay">Pay</li>
        </ol>
      </div>

      <div className="chooser" data-chooser="" role="dialog" aria-modal="false" aria-labelledby="ch-t" hidden>
        <p className="ch-t" id="ch-t">
          Drop your lock here
        </p>
        <div className="ch-row" role="radiogroup" aria-label="Amount">
          <span className="ch-k">CHAIR</span>
          <button type="button" role="radio" aria-checked="true" data-amt="1000000">
            1M
          </button>
          <button type="button" role="radio" aria-checked="false" data-amt="100000000">
            100M
          </button>
          <button type="button" role="radio" aria-checked="false" data-amt="1000000000">
            1B
          </button>
        </div>
        <div className="ch-row" aria-label="Lock days">
          <span className="ch-k">for</span>
          <button type="button" className="ch-go" data-days="1">
            1 d
          </button>
          <button type="button" className="ch-go" data-days="7">
            7 d
          </button>
          <button type="button" className="ch-go" data-days="30">
            30 d
          </button>
        </div>
        <p className="ch-n">
          Weight = CHAIR × days. Illustrative: nothing is locked or sent. <Link href="/app#petition">File a real petition →</Link>
        </p>
        <button type="button" className="ch-x" data-chooser-close="" aria-label="Close">
          ×
        </button>
      </div>
      <p className="sr" aria-live="polite" data-live="" />
    </section>
  );
}
