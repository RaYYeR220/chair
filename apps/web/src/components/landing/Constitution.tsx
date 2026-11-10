import { RAIL_LEVERS } from "@/components/canvas/rails";
import { RULES } from "@/lib/content/constitution";
import type { ReplayMeeting, StateView } from "@/lib/views";
import { Offline } from "./Offline";
import { RailsFigure } from "./RailsFigure";

/** The bound and step of a lever, as the rails' right column prints them. */
export function railNumbers(rules: StateView["rules"], k: (typeof RAIL_LEVERS)[number]): [string, string] {
  const r = rules[k];
  if (k === "tax_bps") return [`${r.min}–${r.max} bps`, `±${r.max_step} per meeting`];
  if (k === "buyback_burn") return [`${r.min}–${r.max} bps`, "of supply, and only what the fund can pay"];
  return [`${r.min}–${r.max}%`, `±${r.max_step} per meeting`];
}

/**
 * 2. The constitution: four rails with their bounds, today's levers, and the
 * testnet meetings' asks replayed onto them. `undefined` while loading,
 * `null` when testnet could not be read.
 */
export function Constitution({ state, meetings }: { state: StateView | null | undefined; meetings: ReplayMeeting[] | null | undefined }) {
  const rules = state?.rules ?? RULES;
  const loading = state === undefined;
  return (
    <section className="sec" id="constitution" aria-labelledby="con-h">
      <div className="wrap">
        <header className="sec-head rv">
          <p className="eyebrow">The constitution</p>
          <h2 id="con-h">Four levers. Hard bounds. Fixed at&nbsp;launch.</h2>
          <p className="lead">
            Compile-time constants, readable on chain with <code>get_constitution</code>. A ruling outside them is clamped, never rejected. Each lever
            moves at most one step per meeting.
          </p>
        </header>
        {state === null ? <Offline /> : null}
        <RailsFigure
          key={loading ? "loading" : "live"}
          rules={rules}
          levers={state?.levers ?? null}
          meetings={meetings ?? []}
          numbers={Object.fromEntries(RAIL_LEVERS.map((k) => [k, railNumbers(rules, k)])) as Record<(typeof RAIL_LEVERS)[number], [string, string]>}
          loading={loading}
        />
        <ul className="con-notes rv">
          <li>
            <b>The 25 came from the simulation.</b> The first run capped locker share at 50, and the chair walked it to 45 for a whale while refusing it
            in words. v2 cut the cap to 25.
          </li>
          <li>
            <b>Fallback rule.</b> Asleep, unsigned, forged or unparseable: tax moves {rules.fallback_tax_step_bps} bps toward{" "}
            {rules.fallback_tax_target_bps}, everything else holds, no buyback.
          </li>
          <li>
            <b>Buyback share is the rest.</b> 100 minus the endowment and locker shares. The burn leaves the curve’s supply counter alone, so the floor
            rises.
          </li>
          <li>
            <b>Nothing else can change.</b> The token account has no keys. Only the signer allowlists and the courier version move, after a public
            48&nbsp;h timelock.
          </li>
        </ul>
      </div>
    </section>
  );
}
