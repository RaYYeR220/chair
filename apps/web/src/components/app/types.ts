import type { MeetingSummary, MeetingView, PetitionsView, StateView } from "@/lib/views";

/**
 * What the app page renders first, read on the server. Every field is live,
 * `null` when the read failed, or `undefined` before it ran (the streaming
 * shell); never a placeholder value.
 */
export interface AppInitial {
  state?: StateView | null;
  petitions?: PetitionsView | null;
  meetings?: MeetingSummary[] | null;
  /** The newest meeting's full record, opened in the archive. */
  latest?: MeetingView | null;
  /** What this server does when asked to write. */
  writes: { relay: boolean; convene: boolean; dry_run: boolean };
}
