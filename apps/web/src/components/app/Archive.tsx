"use client";

import { useEffect, useState } from "react";
import { MeetingRecord } from "@/components/shared/MeetingRecord";
import { getJson } from "@/lib/client/api";
import type { MeetingRecord as Record_ } from "@/lib/chair-types";
import { CONTRACT } from "@/lib/content/constitution";
import { utc } from "@/lib/format";
import { type MeetingSummary, type MeetingView, toMeetingView } from "@/lib/views";

type Loaded = { state: "loading" } | { state: "ok"; m: MeetingView } | { state: "error"; error: string };

/** One line per clamp: `locker_share 100 → 25 · bounds`. */
function Clamps({ m }: { m: MeetingSummary }) {
  if (m.status !== "held") return <span className="cl">{m.status === "lapsed" ? "lapsed: no result before the next meeting" : "waiting for the ruling"}</span>;
  if (!m.asked) return <span className="cl">fallback rule ({m.check})</span>;
  if (!m.clamps.length) return <span className="cl">applied as asked, no clamps</span>;
  return (
    <span className="cl">
      {m.clamps.map((c, i) => (
        <span key={c.lever}>
          {i ? ", " : ""}
          {c.lever} {c.asked} → <span className="v">{c.applied}</span> · {c.rule}
        </span>
      ))}
    </span>
  );
}

function Row({ m, open, preset, flag }: { m: MeetingSummary; open: boolean; preset: MeetingView | null; flag: string | null }) {
  const [isOpen, setOpen] = useState(open);
  const [rec, setRec] = useState<Loaded | null>(preset ? { state: "ok", m: preset } : null);

  useEffect(() => {
    if (open) setOpen(true);
  }, [open]);
  useEffect(() => {
    if (preset) setRec({ state: "ok", m: preset });
  }, [preset]);
  useEffect(() => {
    if (!isOpen || rec) return;
    setRec({ state: "loading" });
    getJson<Record_>(`/api/meetings/${m.number}`, 45_000).then((r) => setRec(r.ok ? { state: "ok", m: toMeetingView(r.data) } : { state: "error", error: r.error }));
  }, [isOpen, rec, m.number]);

  return (
    <li id={`meeting-${m.number}`}>
      <details open={isOpen} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary>
          <span className="num">
            Meeting {m.number}
            <span className="tog" aria-hidden="true">
              ›
            </span>
          </span>
          <span className="st">
            {m.status} · {m.check}
          </span>
          <Clamps m={m} />
          <span className="when">
            {utc(m.convened_at_ms)} · {m.petitions} petition{m.petitions === 1 ? "" : "s"}
          </span>
        </summary>
        <div className="arch-body">
          {flag ? <p className="arch-flag badge">{flag}</p> : null}
          {rec?.state === "ok" ? <MeetingRecord m={rec.m} contract={CONTRACT} full flag /> : null}
          {rec?.state === "loading" ? <p className="loading">Rebuilding meeting {m.number} from its transactions…</p> : null}
          {rec?.state === "error" ? (
            <p className="err" role="alert">
              Couldn’t read meeting {m.number} just now: {rec.error}
            </p>
          ) : null}
        </div>
      </details>
    </li>
  );
}

/** Every meeting the contract still holds, newest first; each opens into its full record. */
export function Archive({
  meetings,
  latest,
  landed,
}: {
  meetings: MeetingSummary[] | null | undefined;
  latest: MeetingView | null;
  landed: { n: number; record: MeetingView | null; dry: boolean } | null;
}) {
  const newest = meetings?.[0]?.number ?? null;
  return (
    <section className="asec" id="meetings" aria-labelledby="arch-h">
      <div className="wrap">
        <header className="asec-head">
          <p className="eyebrow">Meetings</p>
          <h2 id="arch-h">Every ruling, asked and&nbsp;applied.</h2>
          <p className="lead">
            Each record is rebuilt from the meeting’s own transactions: the brief and its seed, the courier’s signed reply, the signature check, every lever
            as asked and as applied with the rule that cut it, the minutes and the answers.
          </p>
        </header>
        {meetings === undefined ? <p className="loading">Reading the meetings from token3.chair-dev.testnet…</p> : null}
        {meetings === null ? <p className="offline">Couldn’t reach testnet just now.</p> : null}
        {meetings && meetings.length === 0 ? <p className="empty">No meeting has been convened yet.</p> : null}
        {meetings && meetings.length ? (
          <ul className="arch">
            {meetings.map((m) => {
              const isLanded = landed?.n === m.number;
              const preset = isLanded && landed?.record ? landed.record : m.number === latest?.number ? latest : null;
              return (
                <Row
                  key={m.number}
                  m={m}
                  open={isLanded || (!landed && m.number === newest)}
                  preset={preset}
                  flag={isLanded ? (landed!.dry ? "dry run stand-in: the latest real meeting, not a new one" : "just convened") : null}
                />
              );
            })}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
