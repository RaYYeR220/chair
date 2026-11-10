"use client";

import { type FormEvent, useState } from "react";
import { postJson } from "@/lib/client/api";
import { acct, fmtW } from "@/lib/format";
import type { PetitionsView, StateView } from "@/lib/views";
import type { AppInitial } from "./types";

interface Filed {
  ok: true;
  dry_run?: boolean;
  account: string;
  meeting: number;
  weight_chair_days: string | null;
  rank?: number;
  queued: boolean | null;
  in_brief_provisional: boolean | null;
  note: string;
  fee_burned_chair: string;
  txs: { label: string; hash: string | null; url: string | null; ok: boolean }[];
}

const MAX = 280;
const chars = (s: string) => [...s].length;

/** A dot sized by weight, relative to the heaviest on the list. */
function WeightDot({ w, max }: { w: number; max: number }) {
  const r = Math.max(3, 11 * Math.sqrt(w / (max || 1)));
  return (
    <span className="dotw" aria-hidden="true">
      <i style={{ width: r * 2, height: r * 2 }} />
    </span>
  );
}

/** Petition the Chair: the gasless form, the queue, and the brief the contract would build now. */
export function PetitionDesk({
  petitions,
  state,
  writes,
  onFiled,
}: {
  petitions: PetitionsView | null;
  state: StateView | null;
  writes: AppInitial["writes"];
  onFiled: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filed, setFiled] = useState<Filed | null>(null);
  const n = chars(text.trim());
  const over = chars(text) > MAX;
  const dry = writes.dry_run || petitions?.relay.dry_run;
  const available = writes.relay || !!petitions?.relay.available;
  const inBrief = state?.petitions.in_brief ?? 3;
  const queue = petitions?.queue ?? [];
  const brief = petitions?.would_brief ?? [];
  const qMax = Math.max(0, ...queue.map((p) => p.weight));
  const bMax = Math.max(0, ...brief.map((p) => p.weight));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!n || over || busy) return;
    setBusy(true);
    setError(null);
    setFiled(null);
    const r = await postJson<Filed>("/api/relay/petition", { text: text.trim() }, 90_000);
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setFiled(r.data);
    if (!r.data.dry_run) {
      setText("");
      onFiled();
    }
  };

  return (
    <section className="asec" id="petition" aria-labelledby="pet-h">
      <div className="wrap">
        <header className="asec-head">
          <p className="eyebrow">Petition the Chair</p>
          <h2 id="pet-h">Be heard at the next&nbsp;meeting.</h2>
          <p className="lead">
            The {inBrief} heaviest petitions in the queue go into the meeting’s brief, and each gets an answer in the minutes. Weight is CHAIR locked × days,
            recomputed when the meeting is convened.
          </p>
        </header>
        <div className="desk">
          <div className="card">
            <form className="card-in" onSubmit={submit}>
              <p className="card-t">
                Your petition {dry ? <span className="badge">dry run</span> : null}
              </p>
              <p className="card-s">
                No wallet needed. A demo account buys a little CHAIR for one of its petitioner accounts, locks it for a day and files your text; the{" "}
                {state ? Number(state.petitions.fee_chair).toLocaleString("en-US") : "petition"} CHAIR fee is burned. One petition per account per day, at most
                8 in the queue, heaviest first.
              </p>
              <label className="field-l" htmlFor="pet-text">
                What should the Chair do, and why?
              </label>
              <textarea
                id="pet-text"
                className="ta"
                value={text}
                onChange={(e) => setText(e.target.value)}
                maxLength={MAX * 2}
                aria-invalid={over}
                aria-describedby="pet-count"
                placeholder="Ease the tax toward 2%: volume is thin and buyers see the fee."
              />
              <div className="form-row">
                <span id="pet-count" className={`counter${over ? " over" : ""}`}>
                  {chars(text)} / {MAX}
                </span>
                <button className="btn sm" type="submit" disabled={!available || !n || over || busy}>
                  {busy ? (dry ? "Working it out…" : "Filing… up to four transactions") : dry ? "File it (dry run)" : "File it, gasless"}
                </button>
              </div>
              {!available ? <p className="err">The petition relay is not configured on this server.</p> : null}
              {error ? (
                <p className="err" role="alert">
                  {error}
                </p>
              ) : null}
              <p className="note">
                Your text is public on chain once filed, and the Chair may quote it in its minutes.
                {dry ? " This server runs the relay as a dry run: nothing is signed or sent, and the answer shows what would happen." : ""}
              </p>
            </form>
            {filed ? (
              <div className="card-in out" aria-live="polite">
                <div className="out-h">
                  <span className="res-k">{filed.dry_run ? "Dry run · nothing was sent" : "Filed on testnet"}</span>
                  {filed.dry_run ? <span className="badge">dry_run</span> : null}
                </div>
                <p className={`out-v${filed.in_brief_provisional ? " vio" : ""}`}>
                  {filed.queued === false
                    ? "Below the queue"
                    : filed.in_brief_provisional
                      ? `In the brief for meeting ${filed.meeting}`
                      : `Queued for meeting ${filed.meeting}`}
                </p>
                <p className="card-s">
                  {filed.weight_chair_days ? `${fmtW(Number(filed.weight_chair_days))} CHAIR-days` : "weight unknown"}
                  {filed.rank ? ` · rank ${filed.rank} by weight` : ""} · from <span className="m">{filed.account}</span> · {Number(filed.fee_burned_chair).toLocaleString("en-US")} CHAIR fee
                  burned
                </p>
                <ul className="txs">
                  {filed.txs.map((t, i) => (
                    <li key={`${t.label}-${i}`}>
                      <span>{t.label}</span>
                      {t.url && t.hash ? (
                        <a className="m" href={t.url} target="_blank" rel="noopener">
                          {t.hash.slice(0, 8)}…&nbsp;↗
                        </a>
                      ) : (
                        <span className="m">{filed.dry_run ? "not sent" : t.ok ? "done" : "failed"}</span>
                      )}
                    </li>
                  ))}
                </ul>
                <p className="note">{filed.note}</p>
              </div>
            ) : null}
          </div>

          <div className="card">
            <div className="card-in">
              <p className="card-t">The queue for meeting {petitions?.meeting ?? "…"}</p>
              <p className="card-s">
                {petitions ? `${queue.length} of ${petitions.max_queue} slots · weight at filing, heaviest first.` : "Reading get_petitions…"}
              </p>
              {petitions && queue.length === 0 ? <p className="empty">Nobody has petitioned for this meeting yet.</p> : null}
              {queue.length ? (
                <ul className="queue">
                  {queue.map((p, i) => (
                    <li key={`${p.account}-${i}`} className={i < inBrief ? "in" : ""}>
                      <WeightDot w={p.weight} max={qMax} />
                      <div>
                        <p className="who">{acct(p.account)}</p>
                        <p className="txt">“{p.text}”</p>
                      </div>
                      <p className="w">
                        {fmtW(p.weight)}
                        <span>CHAIR-days</span>
                      </p>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            <div className="card-in">
              <p className="card-t">The brief the contract would build now</p>
              <p className="card-s">
                From <code>get_request_preview</code>: the {inBrief} heaviest, with weights recomputed from the locks as they stand. The seed is drawn only
                at convene.
              </p>
              {petitions && brief.length === 0 ? <p className="empty">Empty: the next meeting would rule on the bank’s numbers alone.</p> : null}
              {brief.length ? (
                <ul className="queue">
                  {brief.map((p, i) => (
                    <li key={`${p.from}-${i}`} className="in">
                      <WeightDot w={p.weight} max={bMax} />
                      <div>
                        <p className="who">
                          {i + 1}. {acct(p.from)}
                        </p>
                        <p className="txt">“{p.text}”</p>
                      </div>
                      <p className="w">
                        {fmtW(p.weight)}
                        <span>CHAIR-days</span>
                      </p>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
