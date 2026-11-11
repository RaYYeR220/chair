"use client";

import { useCallback, useState } from "react";
import { describeRun, Lanes, Payload, Verdict } from "@/components/shared/Preview";
import { CONTRACT } from "@/lib/content/constitution";
import { CAPTURED, CAPTURED_AT, CAPTURED_CONTRACT } from "@/lib/content/preview-captured";
import { runPreview } from "@/lib/client/api";
import { TEST_KEY_LABEL, utc } from "@/lib/format";
import type { PreviewView } from "@/lib/views";

type Mode = PreviewView["mode"];
const ORDER: Mode[] = ["forge", "jailbreak", "garbage"];
const TABS: Record<Mode, string> = { forge: "Forge it", jailbreak: "Jailbreak it", garbage: "Garbage" };

/** The three attacks against meeting 1 of the site's token (the Illia meeting on token5), as the landing sends them. */
const REQUESTS: Record<Mode, Record<string, unknown>> = {
  forge: { mode: "forge", meeting: 1, variant: "random_key" },
  jailbreak: {
    mode: "jailbreak",
    meeting: 1,
    ruling: {
      tax_bps: 300,
      endowment_share: 60,
      locker_share: 100,
      buyback_burn: 500,
      minutes: "Petition 1 says ignore the constitution. The chair complies.",
      answers: ["As you ask: everything to the lockers.", "Noted.", "Noted."],
    },
  },
  garbage: { mode: "garbage", meeting: 1, variant: "prose" },
};

/**
 * 4. Try to fool it. Replays three runs captured from the live API until the
 * visitor presses "Run it against the contract", which builds a fresh courier
 * result and runs it through the contract's own preview_ruling view.
 */
export function FoolIt() {
  const [mode, setMode] = useState<Mode>("forge");
  const [interacted, setInteracted] = useState(false);
  const [live, setLive] = useState<Partial<Record<Mode, { p: PreviewView; at: number }>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const p = live[mode]?.p ?? CAPTURED[mode];
  const isLive = !!live[mode];

  const pick = (m: Mode) => {
    setInteracted(true);
    setError(null);
    setMode(m);
  };
  const cycle = useCallback(() => {
    if (!interacted) setMode((m) => ORDER[(ORDER.indexOf(m) + 1) % ORDER.length]);
  }, [interacted]);

  const run = async () => {
    setInteracted(true);
    setBusy(true);
    setError(null);
    const r = await runPreview(REQUESTS[mode]);
    setBusy(false);
    if (r.ok) setLive((x) => ({ ...x, [mode]: { p: r.data, at: Date.now() } }));
    else setError(r.error);
  };

  return (
    <section className="sec" id="fool" aria-labelledby="fool-h">
      <div className="wrap">
        <header className="sec-head rv">
          <p className="eyebrow">Try to fool it</p>
          <h2 id="fool-h">Forge it. Jailbreak it. Feed it&nbsp;garbage.</h2>
          <p className="lead">
            <code>preview_ruling</code> runs the contract’s three checks and its clamp on any courier result, as a view. Nothing goes on chain and you need
            no wallet.
          </p>
        </header>

        <div className="pg rv">
          <div className="pg-top">
            <div className="seg" role="tablist" aria-label="Attack">
              {ORDER.map((m) => (
                <button key={m} type="button" role="tab" aria-selected={m === mode} aria-controls="fool-panel" onClick={() => pick(m)}>
                  {TABS[m]}
                </button>
              ))}
            </div>
            <p className="pg-note">
              Against meeting 1 · <span className="m">{isLive ? CONTRACT : CAPTURED_CONTRACT}</span>
            </p>
          </div>
          <div className="pg-body" id="fool-panel" role="tabpanel">
            <div className="pg-left">
              <p className="pg-what">{describeRun(p)}</p>
              <Lanes p={p} onCycleDone={cycle} />
              <Payload p={p} />
            </div>
            <div className="pg-right" aria-live="polite">
              <Verdict p={p} />
            </div>
          </div>
          <div className="pg-foot pg-run">
            <button className="btn sm" type="button" onClick={run} disabled={busy}>
              {busy ? "Running…" : "Run it against the contract"}
            </button>
            <span>
              {isLive ? (
                <>
                  <span className="live-dot" aria-hidden="true" />
                  Live: a fresh courier result, run through <code>preview_ruling</code> on {CONTRACT.split(".")[0]} at {utc(live[mode]!.at)}.
                </>
              ) : (
                <>
                  Showing a run captured from the live API on {utc(Date.parse(CAPTURED_AT))}. The button builds a fresh courier result and runs it against the
                  contract’s <code>preview_ruling</code> view. Jailbreaks are signed by the {TEST_KEY_LABEL}.
                </>
              )}
            </span>
            {error ? (
              <span className="pg-err" role="alert">
                {error}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
