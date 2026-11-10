"use client";

import { RAIL_LEVERS, type RailLever } from "@/components/canvas/rails";
import { RailsFigure } from "@/components/landing/RailsFigure";
import { RULES } from "@/lib/content/constitution";
import { clock, fmtNear, modelName, sh } from "@/lib/format";
import type { StateView } from "@/lib/views";

const UNIT: Record<RailLever, string> = { tax_bps: " bps", endowment_share: "%", locker_share: "%", buyback_burn: " bps" };

/** Today's value big, the bound and the step underneath. */
function numbers(state: StateView | null): Record<RailLever, [string, string]> {
  const rules = state?.rules ?? RULES;
  return Object.fromEntries(
    RAIL_LEVERS.map((k) => {
      const r = rules[k];
      const bound = `${r.min}–${r.max}${UNIT[k].trim() === "%" ? "%" : ""}`;
      if (k === "buyback_burn") return [k, [`≤ ${r.max} bps`, "set each meeting, only what the fund can pay"]];
      const v = state?.levers[k];
      return [k, [v != null ? `${v}${UNIT[k]}` : "–", `bounds ${bound} · ±${r.max_step} per meeting`]];
    }),
  ) as Record<RailLever, [string, string]>;
}

/** Endowment as a share of the way to the next model, on the ladder's log scale. */
function ladderProgress(e: StateView["endowment"]): number {
  if (!e.next) return 1;
  const cur = e.ladder.filter((t) => t.reached).at(-1)?.min_near ?? 0.01;
  const lo = Math.log10(Math.max(0.01, cur)), hi = Math.log10(e.next.min_near);
  return Math.max(0, Math.min(1, (Math.log10(Math.max(0.01, e.near)) - lo) / (hi - lo || 1)));
}

/** Live state: the four levers on their rails, then the bank's numbers. */
export function LiveState({ state, remaining }: { state: StateView | null; remaining: number | null }) {
  const e = state?.endowment;
  const f = state?.funds;
  const open = state?.meetings.open ?? null;
  return (
    <section className="asec" id="state" aria-labelledby="state-h">
      <div className="wrap">
        <header className="asec-head">
          <p className="eyebrow">Live state</p>
          <h2 id="state-h">Four levers, inside their&nbsp;bounds.</h2>
          <p className="lead">
            Read from <code>get_status</code>, <code>get_funds</code> and <code>get_constitution</code> on every refresh. The shaded window is how far each
            lever can move at the next meeting.
          </p>
        </header>
        <RailsFigure
          key={state ? `${state.levers.tax_bps}-${state.levers.endowment_share}-${state.levers.locker_share}` : "none"}
          rules={state?.rules ?? RULES}
          levers={state?.levers ?? null}
          meetings={[]}
          numbers={numbers(state)}
          caption={false}
          showOldCap={false}
        />

        <div className="tiles">
          <div className="tile">
            <p className="tile-k">Next meeting</p>
            {state ? (
              <>
                <p className={`tile-v${remaining === 0 && open == null ? " vio" : ""}`}>
                  {open != null ? `#${open} open` : remaining == null ? "–" : remaining > 0 ? clock(remaining) : "Open"}
                </p>
                <p className="tile-s">
                  {open != null
                    ? `Meeting ${open} is waiting for its ruling.`
                    : remaining && remaining > 0
                      ? `until meeting ${state.meetings.count + 1} can be convened (opens_in_s ${Math.round(remaining)}).`
                      : `Meeting ${state.meetings.count + 1} can be convened now, by anyone.`}{" "}
                  Interval {state.meetings.interval_s} s.
                </p>
              </>
            ) : (
              <p className="tile-s loading">reading…</p>
            )}
          </div>
          <div className="tile">
            <p className="tile-k">Endowment · IQ tier</p>
            {e ? (
              <>
                <p className="tile-v">
                  {fmtNear(e.near)}
                  <small>NEAR</small>
                </p>
                <p className="tile-s">
                  {e.asleep ? "Asleep: the fallback rule runs." : <>Awake on <span className="m">{modelName(e.model)}</span>.</>}{" "}
                  {e.next ? `${fmtNear(e.next.missing_near)} NEAR more wakes ${modelName(e.next.model)}.` : "The top of the ladder."}
                </p>
                <div className="meter" role="img" aria-label={`Progress to the next model on a log scale: ${Math.round(ladderProgress(e) * 100)}%`}>
                  <i style={{ width: `${(ladderProgress(e) * 100).toFixed(1)}%` }} />
                </div>
              </>
            ) : (
              <p className="tile-s loading">reading…</p>
            )}
          </div>
          <div className="tile">
            <p className="tile-k">Token account keys</p>
            {state ? (
              <>
                <p className="tile-v mono">{state.token_keys ? JSON.stringify(state.token_keys) : "–"}</p>
                <p className="tile-s">
                  {state.token_keys === null
                    ? "Couldn’t read the key list just now."
                    : state.token_keys.length === 0
                      ? "No keys on the token account: nobody can redeploy it or change the constitution."
                      : `${state.token_keys.length} access key(s) on the token account.`}{" "}
                  <span className="m">view_access_key_list</span>
                </p>
              </>
            ) : (
              <p className="tile-s loading">reading…</p>
            )}
          </div>
          <div className="tile">
            <p className="tile-k">Funds · NEAR</p>
            {f ? (
              <dl className="kv">
                <dt>curve reserve</dt>
                <dd>{fmtNear(f.reserve)}</dd>
                <dt>buyback fund</dt>
                <dd>{fmtNear(f.buyback_fund)}</dd>
                <dt>locker pool</dt>
                <dd>{fmtNear(f.locker_pool)}</dd>
                <dt>owed to lockers</dt>
                <dd>{fmtNear(f.locker_owed)}</dd>
                <dt>endowment pending</dt>
                <dd>{fmtNear(f.endowment_pending)}</dd>
                <dt>sent to the brain</dt>
                <dd>{fmtNear(f.endowment_sent)}</dd>
              </dl>
            ) : (
              <p className="tile-s loading">reading…</p>
            )}
          </div>
        </div>
        {state ? (
          <div className="tiles">
            <div className="tile">
              <p className="tile-k">Meetings</p>
              <p className="tile-v">{state.meetings.count}</p>
              <p className="tile-s">
                {state.stats.rulings} ruling{state.stats.rulings === 1 ? "" : "s"} applied · {state.stats.fallbacks} fallback{state.stats.fallbacks === 1 ? "" : "s"} ·{" "}
                {state.stats.lapsed} lapsed
              </p>
            </div>
            <div className="tile">
              <p className="tile-k">Trading</p>
              <dl className="kv">
                <dt>price</dt>
                <dd>{Number(state.curve.price_near).toExponential(3)}</dd>
                <dt>floor</dt>
                <dd>{Number(state.curve.floor_price_near).toExponential(3)}</dd>
                <dt>supply · CHAIR</dt>
                <dd>{Math.round(Number(state.curve.supply_chair)).toLocaleString("en-US")}</dd>
                <dt>burned · CHAIR</dt>
                <dd>{Math.round(Number(state.curve.burned_chair)).toLocaleString("en-US")}</dd>
              </dl>
            </div>
            <div className="tile">
              <p className="tile-k">Holders and petitions</p>
              <p className="tile-v">{state.holders}</p>
              <p className="tile-s">
                holders · {state.stats.buys} buys, {state.stats.sells} sells · {state.stats.petitions} petitions filed · fee {Number(state.petitions.fee_chair).toLocaleString("en-US")} CHAIR, burned
              </p>
            </div>
            <div className="tile">
              <p className="tile-k">Governance</p>
              <dl className="kv">
                <dt>model signers</dt>
                <dd>{state.governance.model_signers.map((s) => sh(s, 6, 4)).join(", ") || "none"}</dd>
                <dt>gateway signers</dt>
                <dd>{state.governance.gateway_signers.map((s) => sh(s, 6, 4)).join(", ") || "none"}</dd>
                <dt>timelock</dt>
                <dd>{Math.round(state.governance.timelock_s / 3600)} h</dd>
                <dt>pending change</dt>
                <dd>{state.governance.pending ? "yes" : "none"}</dd>
              </dl>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
