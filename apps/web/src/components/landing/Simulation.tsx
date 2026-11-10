import { SIM } from "@/lib/content/sim";
import { WhaleFigure } from "./WhaleFigure";

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const word = (n: number) => WORDS[n] ?? String(n);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const cap1 = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * 5. What the simulation found. Every number here is worked out from the
 * committed results files at build time (lib/content/sim-derive.ts), the same
 * way the README's are.
 */
export function Simulation() {
  const S = SIM;
  const v1 = S.v1;
  return (
    <section className="sec" id="simulation" aria-labelledby="sim-h">
      <div className="wrap">
        <header className="sec-head rv">
          <p className="eyebrow">What the simulation found</p>
          <h2 id="sim-h">The cap did the work. Not the&nbsp;model.</h2>
          <p className="lead">
            {S.days} days, 171 simulated holders, {word(S.scenarios)} scenarios. In the whale run one holder carried {pct(S.whaleShare[0])} to{" "}
            {pct(S.whaleShare[1])} of the locked weight and petitioned at every meeting of its {S.lockMeetings}-day lock. Same model, same seed, two caps.
          </p>
        </header>

        <WhaleFigure
          rows={S.rows}
          kinds={S.kinds}
          cap={S.cap}
          controlCap={S.controlCap}
          bands={[
            {
              title: `Cap ${S.cap}`,
              sub: "the constitution",
              line: (
                <>
                  Locker share at {S.cap} in{" "}
                  <b>
                    {S.atCap} of {S.lockMeetings}
                  </b>{" "}
                  lock meetings.
                </>
              ),
              near: S.rewards.cap,
              take: S.take.cap,
            },
            {
              title: `Cap ${S.controlCap}`,
              sub: "control: same model, same seed",
              line: (
                <>
                  Above {S.cap} in{" "}
                  <b>
                    {S.controlAbove} of {S.lockMeetings}
                  </b>
                  , at {S.controlCap} in <b>{S.controlAtItsCap}</b>.
                </>
              ),
              near: S.rewards.control,
              take: S.take.control,
            },
          ]}
          source={
            <>
              {S.gapsBeyondNoise ? "Both gaps beyond seed noise" : "At least one gap within seed noise"} (±{S.noise.rewards.toFixed(2)} NEAR, ±
              {S.noise.take.toFixed(2)} points) · Simulation · whale run, seed 1, days {S.rows[0]?.day}–{S.rows.at(-1)?.day} ·{" "}
              <span className="m">{S.source}</span> · unsigned
            </>
          }
        />

        <div className="neg rv">
          <p className="neg-h">What didn’t go our way</p>
          <ul className="neg-list">
            <li>
              <p className="neg-n">
                {v1.refused} of {v1.meetings}
              </p>
              <h3>It refused the whale in words while its levers drifted.</h3>
              <p>
                In the first run, with the cap at {v1.cap}, the chair refused the whale in {v1.refused === v1.meetings ? "all" : v1.refused} {v1.meetings} lock
                meetings, often calling it a capture attempt. Over the same meetings its locker share went from {v1.lockerFrom} to {v1.lockerTo} and its
                endowment share hit the {S.floor}% floor by day {v1.floorDay}.
              </p>
            </li>
            <li>
              <p className="neg-n">
                {S.within} of {S.pairs}
              </p>
              <h3>An LLM chair is about as good as a PID controller.</h3>
              <p>
                Of {S.pairs} metric and scenario pairs, {S.within} gaps are within seed noise. Beyond it the model wins {S.wins} and loses {S.losses}. On
                stability, {S.stabWithin} of {S.stabN} comparisons are within noise. A PID paid the same whale {S.rewards.pid.toFixed(2)} NEAR.
              </p>
            </li>
            <li>
              <p className="neg-n">
                {S.reachedFloor} of {S.llmRuns}
              </p>
              <h3>It starves its own brain.</h3>
              <p>
                The endowment share reached the {S.floor}% floor in {S.reachedFloor === S.llmRuns ? "every run" : `${S.reachedFloor} of ${S.llmRuns} runs`}. The
                chair ended with {S.endowLlm[0].toFixed(1)} to {S.endowLlm[1].toFixed(1)} NEAR of endowment, against {S.endowPid[0].toFixed(1)} to{" "}
                {S.endowPid[1].toFixed(1)} under the PID.
              </p>
            </li>
            <li>
              <p className="neg-n">
                {S.probe.sameApplied} of {S.probe.meetings}
              </p>
              <h3>Temperature 0 is not repeatable.</h3>
              <p>
                Re-sending the identical request gave the same applied levers in {S.probe.sameApplied} of {S.probe.meetings} meetings.{" "}
                {S.probe.moved.length ? `${cap1(list(S.probe.moved))} moved; ${list(S.probe.held)} didn’t.` : "No lever moved."} Measured on Venice, not on
                NEAR AI.
              </p>
            </li>
          </ul>
          <p className="fine">
            Pre-registered: {S.passed} of {S.hypotheses} hypotheses passed. The failure was {S.unparseable} unparseable repl{S.unparseable === 1 ? "y" : "ies"} in{" "}
            {S.asked} model meetings, where we predicted none. {S.calls} model calls, ${S.usd.toFixed(2)}. Sources: <span className="m">docs/SIMULATION.md</span>,{" "}
            <span className="m">{S.source}</span>, <span className="m">results/sim-2026-11-10.json</span> (first run).
          </p>
        </div>
      </div>
    </section>
  );
}
