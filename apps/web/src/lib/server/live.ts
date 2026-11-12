import "server-only";
import { cache } from "react";
import { near } from "@/lib/units";
import {
  type MainnetView,
  type MeetingSummary,
  type MeetingView,
  type PetitionsView,
  type StateBody,
  type StateView,
  toMeetingView,
  toPetitionsView,
  toStateView,
  toSummary,
} from "@/lib/views";
import { cached, chair, chairAt, getState, parseBrief, tokens } from "./chair";
import { conveneAvailable } from "./convene";
import { env, mainnet, site, targetFor } from "./env";
import { getMeetingRecord, listMeetings } from "./history";
import { relayAvailable, relayStatus } from "./relay";

/**
 * Server-side reads for the pages, with fallbacks: a section renders either
 * live data or `null`, never a made-up value. Each read gives up after a few
 * seconds so a slow node never holds a page. Deduplicated per request.
 */

const within = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });

export const loadState = cache(async (): Promise<StateView | null> => {
  try {
    return toStateView((await within(getState(), 9_000)) as unknown as StateBody);
  } catch {
    return null;
  }
});

/** Meeting `n` of the site's token, or of `contract` (the landing also reads token3's test chair). */
export const loadMeeting = cache(async (n: number, contract?: string): Promise<MeetingView | null> => {
  try {
    const r = await within(getMeetingRecord(n, contract ? targetFor(contract) : site), 12_000);
    return r ? toMeetingView(r) : null;
  } catch {
    return null;
  }
});

/**
 * The mainnet token's meeting `n`, read-only, with its schedule. `null` when
 * mainnet could not be read at all.
 */
export const loadMainnet = cache(async (n: number): Promise<MainnetView | null> => {
  const m = chairAt(mainnet);
  const schedule = async () => {
    const [status, constitution] = await within(
      Promise.all([m.status(), cached(`constitution:${mainnet.contract}`, 60_000, m.constitution).catch(() => null)]),
      9_000,
    );
    return {
      meeting_count: status.meeting_count,
      open_meeting: status.open_meeting,
      next_meeting_at_ms: Number(BigInt(status.next_meeting_at) / 1_000_000n),
      convene_near: constitution ? Number(near(constitution.outlayer.deposit)) : null,
    };
  };
  const [meeting, sched] = await Promise.all([loadMeeting(n, mainnet.contract), schedule().catch(() => null)]);
  if (!meeting && !sched) return null;
  return { contract: mainnet.contract, explorer: mainnet.explorer, meeting, schedule: sched };
});

export const loadMeetings = cache(async (): Promise<MeetingSummary[] | null> => {
  try {
    const l = await within(listMeetings(), 9_000);
    return l.meetings.map((m) => toSummary(m));
  } catch {
    return null;
  }
});

/** The petition queue, the brief the contract would build now, and the relay's status (as GET /api/petitions). */
export const loadPetitions = cache(async (): Promise<PetitionsView | null> => {
  try {
    const [queue, preview, relay] = await within(Promise.all([chair.petitions(), chair.requestPreview(), relayStatus()]), 9_000);
    const brief = parseBrief(preview.request)?.brief as { petitions?: { from: string; weight: string; text: string }[] } | null;
    return toPetitionsView({
      meeting: preview.meeting,
      queue: queue.map((p) => ({ ...p, weight_chair_days: tokens(p.weight) })),
      max_queue: 8,
      would_brief: brief?.petitions ?? [],
      relay,
    });
  } catch {
    return null;
  }
});

/** What this server will do when asked to write: whether the relay and convene are configured, and whether they only dry-run. */
export function writeModes() {
  return { relay: relayAvailable() || env.dryRun, convene: conveneAvailable() || env.dryRun, dry_run: env.dryRun };
}
