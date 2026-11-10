"use client";

import { useEffect, useRef, useState } from "react";
import { getJson, postJson } from "@/lib/client/api";
import type { MeetingRecord } from "@/lib/chair-types";
import { clock } from "@/lib/format";
import type { StateView } from "@/lib/views";
import type { AppInitial } from "./types";

type Phase = "sent" | "convened" | "held" | "error";
interface Run {
  phase: Phase;
  t0: number;
  target: number;
  dry: boolean;
  n?: number;
  note?: string;
  error?: string;
  waited?: number;
}
interface Convened {
  ok: true;
  dry_run?: boolean;
  meeting: number;
  landed: boolean;
  note?: string;
  waited_s: number;
  timeline?: { convened_s: number; on_ruling_s: number };
  record: MeetingRecord | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const STAGES = [
  { key: "convened", name: "Convened", what: "The brief and the block’s seed are fixed on chain; the request’s sha256 is stored." },
  { key: "courier", name: "Courier", what: "OutLayer carries the request bytes to the model in a TEE and brings back the signed reply." },
  { key: "on_ruling", name: "on_ruling", what: "The contract checks the signature, clamps the ruling and applies it." },
];

/** Convene: enabled once the interval has passed; shows the meeting land, about ten seconds later. */
export function ConveneDesk({
  state,
  remaining,
  writes,
  onLanded,
}: {
  state: StateView | null;
  remaining: number | null;
  writes: AppInitial["writes"];
  onLanded: (n: number, record: MeetingRecord | null, dry: boolean) => void;
}) {
  const [run, setRun] = useState<Run | null>(null);
  const [now, setNow] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const running = run !== null && run.phase !== "held" && run.phase !== "error";
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(t);
  }, [running]);

  const open = state?.meetings.open ?? null;
  const next = state ? state.meetings.count + 1 : null;
  const ready = !!state && remaining === 0 && open == null;
  const dry = writes.dry_run;

  const update = (f: (r: Run) => Run) => {
    if (alive.current) setRun((r) => (r ? f(r) : r));
  };

  const start = async () => {
    if (!state || !next || running) return;
    const t0 = Date.now();
    setNow(t0);
    setRun({ phase: "sent", t0, target: next, dry });
    let watching = !dry;
    // On chain, watch the meeting open while the request waits for its ruling.
    (async () => {
      while (watching) {
        await sleep(1500);
        if (!watching) break;
        const r = await getJson<{ open_meeting: number | null }>("/api/convene", 8_000);
        if (r.ok && r.data.open_meeting === next) update((x) => (x.phase === "sent" ? { ...x, phase: "convened" } : x));
      }
    })();
    const r = await postJson<Convened>("/api/convene", {}, 130_000);
    watching = false;
    if (!r.ok) {
      update((x) => ({ ...x, phase: "error", error: r.error }));
      return;
    }
    const d = r.data;
    if (d.dry_run && d.timeline) {
      // A dry run plays the stand-in meeting's own convene-to-ruling timing.
      const at = (s: number) => sleep(Math.max(0, t0 + s * 1000 - Date.now()));
      await at(d.timeline.convened_s);
      update((x) => ({ ...x, phase: "convened" }));
      await at(d.timeline.on_ruling_s);
    }
    if (!d.landed) {
      update((x) => ({ ...x, phase: "convened", note: d.note, n: d.meeting }));
      return;
    }
    update((x) => ({ ...x, phase: "held", n: d.meeting, note: d.note, waited: d.dry_run ? d.timeline?.on_ruling_s : d.waited_s }));
    if (alive.current) onLanded(d.meeting, d.record, !!d.dry_run);
  };

  const stage = (i: number) => {
    if (!run) return "";
    const p = run.phase === "error" ? -1 : run.phase === "sent" ? 0 : run.phase === "convened" ? 1 : 3;
    return i < p ? "done" : i === p ? "now" : "";
  };
  const elapsed = run ? (running ? Math.max(0, (now - run.t0) / 1000) : (run.waited ?? (now - run.t0) / 1000)) : 0;

  return (
    <section className="asec" id="convene" aria-labelledby="conv-h">
      <div className="wrap">
        <header className="asec-head">
          <p className="eyebrow">Convene</p>
          <h2 id="conv-h">Anyone can call the&nbsp;meeting.</h2>
          <p className="lead">
            Once the interval has passed, <code>convene()</code> snapshots the brief and asks the model. The ruling lands in <code>on_ruling</code> about ten
            seconds later, checked and clamped, and the new meeting opens below.
          </p>
        </header>
        <div className="card conv">
          <div className="conv-l">
            <p className="res-k">
              {next ? `Meeting ${next}` : "Next meeting"} {dry ? <span className="badge">dry run</span> : null}
            </p>
            <p className={`conv-n${ready ? " vio" : ""}`}>
              {!state ? "–" : open != null ? `#${open} is open` : remaining && remaining > 0 ? clock(remaining) : "Open now"}
            </p>
            <p className="card-s">
              {!state
                ? "Reading the meeting clock…"
                : open != null
                  ? `Meeting ${open} was convened and is waiting for its ruling.`
                  : remaining && remaining > 0
                    ? `The interval is ${state.meetings.interval_s} s; the button opens when the clock reaches zero.`
                    : "The interval has passed. Convening costs you nothing: the demo account pays the OutLayer deposit."}
            </p>
            <div className="form-row" style={{ justifyContent: "flex-start" }}>
              <button className="btn sm" type="button" onClick={start} disabled={!ready || running || !writes.convene}>
                {running ? "Convening…" : dry ? `Convene meeting ${next ?? ""} (dry run)` : `Convene meeting ${next ?? ""}`}
              </button>
            </div>
            {!writes.convene ? <p className="err">Convening is not configured on this server.</p> : null}
            {dry ? (
              <p className="note">This server runs convene as a dry run: nothing is signed or sent, and it lands on the latest real meeting as a stand-in.</p>
            ) : null}
          </div>
          <div className="conv-r" aria-live="polite">
            <p className="res-k" style={{ marginBottom: 18 }}>
              {run ? `${run.dry ? "Dry run · " : ""}${run.phase === "held" ? "held" : run.phase === "error" ? "stopped" : "in progress"} · ${elapsed.toFixed(1)} s` : "Progress"}
            </p>
            <ol className="prog">
              {STAGES.map((s, i) => (
                <li key={s.key} className={stage(i)}>
                  <b>{s.name}</b>
                  {s.what}
                </li>
              ))}
            </ol>
            {run?.phase === "held" && run.n ? (
              <p className="conv-msg">
                {run.dry ? (
                  <>
                    Dry run: nothing was sent, and meeting {run.target} was not convened. Showing meeting {run.n}, the latest real one, as a stand-in:{" "}
                  </>
                ) : (
                  <>Meeting {run.n} held. </>
                )}
                <a href={`#meeting-${run.n}`}>open its record ↓</a>
              </p>
            ) : null}
            {run?.phase === "convened" && run.note ? <p className="conv-msg">{run.note}</p> : null}
            {run?.phase === "error" ? (
              <p className="err" role="alert">
                {run.error}
              </p>
            ) : null}
            {!run ? <p className="conv-msg">The three steps light up as the meeting goes through them.</p> : null}
          </div>
        </div>
      </div>
    </section>
  );
}
