"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getJson } from "@/lib/client/api";
import { CONTRACT } from "@/lib/content/constitution";
import type { MeetingRecord } from "@/lib/chair-types";
import {
  type MeetingListItem,
  type MeetingSummary,
  type MeetingView,
  type PetitionsBody,
  type PetitionsView,
  type StateBody,
  type StateView,
  toMeetingView,
  toPetitionsView,
  toStateView,
  toSummary,
} from "@/lib/views";
import { Archive } from "./Archive";
import { ConveneDesk } from "./ConveneDesk";
import { LiveState } from "./LiveState";
import { PetitionDesk } from "./PetitionDesk";
import { Playground } from "./Playground";
import type { AppInitial } from "./types";

const STATE_EVERY_MS = 15_000;
const QUEUE_EVERY_MS = 20_000;
const MEETINGS_EVERY_MS = 45_000;

/**
 * The app: everything the contract holds now, polled while the tab is open,
 * plus the three things a visitor can do (petition, convene, try to fool it).
 */
export function ChairApp({ initial }: { initial: AppInitial }) {
  const [state, setState] = useState<StateView | null>(initial.state ?? null);
  const [stateErr, setStateErr] = useState(false);
  const [petitions, setPetitions] = useState<PetitionsView | null>(initial.petitions ?? null);
  const [meetings, setMeetings] = useState<MeetingSummary[] | null | undefined>(initial.meetings);
  const [landed, setLanded] = useState<{ n: number; record: MeetingView | null; dry: boolean } | null>(null);
  const [writes, setWrites] = useState(initial.writes);
  const [now, setNow] = useState<number | null>(null);
  const stateAt = useRef(0);

  // ---- polling (paused while the tab is hidden)
  const refreshState = useCallback(async () => {
    const r = await getJson<StateBody>("/api/state", 15_000);
    if (r.ok) {
      setState(toStateView(r.data));
      stateAt.current = Date.now();
      setStateErr(false);
    } else setStateErr(true);
  }, []);
  const refreshPetitions = useCallback(async () => {
    const r = await getJson<PetitionsBody>("/api/petitions", 15_000);
    if (r.ok) setPetitions(toPetitionsView(r.data));
  }, []);
  const refreshMeetings = useCallback(async () => {
    const r = await getJson<{ meetings: MeetingListItem[] }>("/api/meetings", 15_000);
    if (r.ok) setMeetings(r.data.meetings.map(toSummary));
    else setMeetings((m) => m ?? null);
  }, []);

  useEffect(() => {
    stateAt.current = Date.now();
    setNow(Date.now());
    if (!initial.state) refreshState();
    if (!initial.petitions) refreshPetitions();
    if (!initial.meetings) refreshMeetings();
    getJson<{ available: boolean; dry_run?: boolean }>("/api/convene").then((r) => {
      if (r.ok) setWrites((w) => ({ ...w, convene: r.data.available, dry_run: !!r.data.dry_run }));
    });
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    const every = (fn: () => void, ms: number) =>
      window.setInterval(() => {
        if (document.visibilityState === "visible") fn();
      }, ms);
    const timers = [every(refreshState, STATE_EVERY_MS), every(refreshPetitions, QUEUE_EVERY_MS), every(refreshMeetings, MEETINGS_EVERY_MS)];
    return () => {
      window.clearInterval(tick);
      timers.forEach((t) => window.clearInterval(t));
    };
  }, [initial.state, initial.petitions, initial.meetings, refreshState, refreshPetitions, refreshMeetings]);

  const contract = state?.contract ?? CONTRACT;
  // seconds until the next meeting can be convened, counted down locally between polls
  const remaining = state && now ? Math.max(0, state.meetings.opens_in_s - (now - stateAt.current) / 1000) : null;
  const ago = state && now && stateAt.current ? Math.max(0, Math.round((now - stateAt.current) / 1000)) : null;

  const onLanded = useCallback(
    (n: number, record: MeetingRecord | null, dry: boolean) => {
      setLanded({ n, record: record ? toMeetingView(record) : null, dry });
      refreshState();
      refreshPetitions();
      refreshMeetings();
      window.setTimeout(() => document.getElementById(`meeting-${n}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 250);
    },
    [refreshState, refreshPetitions, refreshMeetings],
  );

  return (
    <>
      <header className="wrap app-head">
        <p className="eyebrow">The app · testnet</p>
        <h1 className="app-h1">The Chair, live.</h1>
        <p className="lead">
          The bank as the contract holds it now. Petition it without a wallet, convene a meeting when the interval has passed, open every meeting’s record,
          and try to fool its checks yourself.
        </p>
        <p className="app-status" role="status">
          <span>
            <span className="live-dot" aria-hidden="true" />
            <span className="m">{contract}</span>
          </span>
          {state ? <span>block {state.block.height.toLocaleString("en-US")}</span> : null}
          {ago != null ? <span>read {ago < 2 ? "just now" : `${ago} s ago`}</span> : null}
          {stateErr ? <span>couldn’t reach testnet on the last read; retrying</span> : null}
          {!state && !stateErr ? <span>reading testnet…</span> : null}
          {writes.dry_run ? <span className="badge">dry run: petitions and convenes are not sent</span> : null}
        </p>
        <ul className="app-jump" aria-label="Sections">
          <li>
            <a href="#state">Live state</a>
          </li>
          <li>
            <a href="#petition">Petition</a>
          </li>
          <li>
            <a href="#convene">Convene</a>
          </li>
          <li>
            <a href="#meetings">Meetings</a>
          </li>
          <li>
            <a href="#playground">Try to fool it</a>
          </li>
        </ul>
      </header>

      <LiveState state={state} remaining={remaining} />
      <PetitionDesk petitions={petitions} state={state} writes={writes} onFiled={refreshPetitions} />
      <ConveneDesk state={state} remaining={remaining} writes={writes} onLanded={onLanded} last={landed?.record && !landed.dry ? landed.record : (initial.latest ?? null)} />
      <Archive meetings={meetings} latest={initial.latest ?? null} landed={landed} contract={contract} />
      <Playground meetings={meetings} contract={contract} />
    </>
  );
}
