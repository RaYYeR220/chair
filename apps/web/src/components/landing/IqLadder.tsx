import { about, LADDER, RULES, volumeFor } from "@/lib/content/constitution";
import { SIM } from "@/lib/content/sim";
import { modelName } from "@/lib/format";
import type { StateView } from "@/lib/views";
import { IqFigure } from "./IqFigure";
import { Offline } from "./Offline";

/** 6. The IQ ladder. `state`: live testnet, `null` when it could not be read, `undefined` while loading. */
export function IqLadder({ state }: { state: StateView | null | undefined }) {
  const E = state?.endowment ?? null;
  const ladder = E?.ladder.map((t) => ({ model: t.model, min_near: t.min_near })) ?? LADDER;
  const rules = state?.rules ?? RULES;
  const trail = SIM.trail;
  const firstGlm = trail.tier.indexOf(1);
  const firstDeep = trail.tier.indexOf(2);
  const last = trail.endowment.at(-1) ?? 0;
  const simReached = (i: number) => trail.tier.indexOf(i + 1);
  const current = E?.model ?? null;

  return (
    <section className="sec" id="ladder" aria-labelledby="iq-h">
      <div className="wrap">
        <header className="sec-head rv">
          <p className="eyebrow">The IQ ladder</p>
          <h2 id="iq-h">More stake, a smarter&nbsp;chair.</h2>
          <p className="lead">
            The bank pays for its own brain. Part of every tax is staked in NEAR AI’s inference farm, and the stake picks the model from a table fixed at
            launch.
          </p>
        </header>
        {state === null ? <Offline>Couldn’t reach testnet just now, so today’s endowment is not drawn.</Offline> : null}

        <IqFigure key={E ? "live" : "plain"} ladder={ladder} near={E?.near ?? null} trail={trail} />
        <p className="iq-cap rv">
          Rings on a log scale.{" "}
          {E ? (
            <>
              <b>Violet</b>: testnet today, {E.near.toFixed(4)} NEAR reported by the brain (stand-in farm).{" "}
            </>
          ) : state === undefined ? (
            "Reading testnet’s endowment… "
          ) : null}
          Dots: the simulated whale run’s endowment, one per day, left to right: asleep on days 0–{firstGlm - 1}, {modelName(ladder[0].model)} from day{" "}
          {firstGlm}
          {firstDeep > 0 ? `, ${modelName(ladder[1].model)} from day ${firstDeep}` : ""}, {last.toFixed(1)} NEAR on day {trail.endowment.length - 1}.
          {simReached(2) < 0 ? ` ${modelName(ladder[2].model).split(" ")[0]} was never reached.` : ""}
        </p>

        <ol className="rungs rv">
          <li>
            <p className="t">below {ladder[0].min_near} NEAR</p>
            <p className={`mdl${E?.asleep ? " on" : ""}`}>Asleep</p>
            <p className="id">fallback rule only</p>
            <p className="x">
              Tax moves {rules.fallback_tax_step_bps} bps toward {rules.fallback_tax_target_bps} each meeting. Nothing else moves until the brain wakes.
            </p>
          </li>
          {ladder.map((t, i) => {
            const here = current === t.model;
            const next = E?.next?.model === t.model;
            const day = simReached(i);
            return (
              <li key={t.model}>
                <p className="t">{t.min_near} NEAR staked</p>
                <p className={`mdl${here ? " on" : ""}`}>{modelName(t.model)}</p>
                <p className="id">{t.model}</p>
                <p className="x">
                  Wakes after {about(volumeFor(t.min_near))} NEAR of trading at the launch levers.{" "}
                  {here && E
                    ? `Testnet is here now, at ${E.near.toFixed(4)} NEAR.`
                    : next && E?.next
                      ? `Testnet needs ${E.next.missing_near.toFixed(2)} NEAR more. `
                      : ""}
                  {!here ? (day >= 0 ? `The simulated whale run got here on day ${day}.` : "Never reached in the simulation.") : ""}
                </p>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
