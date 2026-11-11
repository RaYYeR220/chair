import type { ReactNode } from "react";
import { fmtNear, sh, signerName } from "@/lib/format";
import type { MeetingView } from "@/lib/views";
import { CONTRACT } from "@/lib/content/constitution";
import { FlowScenes } from "./FlowScenes";
import { Offline } from "./Offline";

const STEPS: { key: string; name: string; body: ReactNode }[] = [
  {
    key: "convene",
    name: "Convene",
    body: (
      <>
        Anyone calls <code>convene()</code> once the interval has passed. The contract snapshots a brief with the three heaviest petitions and a seed
        from the block’s randomness.
      </>
    ),
  },
  {
    key: "ask",
    name: "Ask",
    body: (
      <>
        The contract stores <code>sha256(request)</code>. An OutLayer courier carries the bytes unchanged to a model in a TEE on NEAR AI Cloud, through a
        relay that forwards only that request.
      </>
    ),
  },
  {
    key: "verify",
    name: "Verify",
    body: (
      <>
        The contract checks the signed text, recovers the signer with <code>ecrecover</code> and requires it on the allowlist. A forged ruling runs the
        fallback.
      </>
    ),
  },
  { key: "clamp", name: "Clamp", body: <>Every lever lands inside the constitution. Nothing is rejected. Each cut is recorded with its rule.</> },
  {
    key: "apply",
    name: "Apply",
    body: <>The contract sets the levers, buys back and burns, pays the lockers pro rata, funds the brain and logs the minutes with every answer.</>,
  },
];

/** What each step shows under its text, read from meeting 1. */
function details(m: MeetingView): Record<string, ReactNode> {
  const cut = (lever: string) => m.clamps.find((c) => c.lever === lever);
  const lock = cut("locker_share");
  const burn = cut("buyback_burn");
  return {
    convene: (
      <>
        meeting {m.number}
        <br />
        seed <b>{sh(m.seed, 8, 4)}</b>
      </>
    ),
    ask: (
      <>
        sha256(request)
        <br />
        <b>{sh(m.request_sha256, 8, 4)}</b>
        {m.outlayer_request_id != null ? (
          <>
            <br />
            OutLayer request <b>{m.outlayer_request_id}</b>
          </>
        ) : null}
      </>
    ),
    verify: (
      <>
        signer <b>{sh(m.signer, 6, 4)}</b>
        <br />
        {signerName(m.signer_info) ?? "on model_signers"}
      </>
    ),
    clamp: (
      <>
        {!m.clamps.length && m.asked ? (
          <>
            no cut needed
            <br />
            every lever asked inside its bounds
          </>
        ) : null}
        {lock ? (
          <>
            locker_share{" "}
            <b>
              {lock.asked} → <span className="v">{lock.applied}</span>
            </b>
            <br />
          </>
        ) : null}
        {burn ? (
          <>
            buyback_burn{" "}
            <b>
              {burn.asked} → <span className="v">{burn.applied}</span>
            </b>{" "}
            · {burn.rule}
          </>
        ) : null}
      </>
    ),
    apply: (
      <>
        {m.buyback ? (
          <>
            burned <b>{Math.round(m.buyback.chair).toLocaleString("en-US")} CHAIR</b>
            <br />
          </>
        ) : null}
        {m.locker_paid_near != null ? (
          <>
            lockers paid <b>{fmtNear(m.locker_paid_near)} NEAR</b>
            <br />
          </>
        ) : null}
        {m.on_ruling_tgas != null ? (
          <>
            on_ruling <b>{m.on_ruling_tgas} TGas</b>
          </>
        ) : null}
      </>
    ),
  };
}

/** 1. How a meeting works. `m1`: the site token's meeting 1, `null` if testnet could not be read, `undefined` while loading. */
export function HowItWorks({ m1 }: { m1: MeetingView | null | undefined }) {
  const d = m1 ? details(m1) : null;
  const flow = m1 ? { seed: m1.seed ?? "", requestSha256: m1.request_sha256 ?? "", weights: m1.petitions.map((p) => Number(p.weight)) } : null;
  return (
    <section className="sec" id="how" aria-labelledby="how-h">
      <div className="wrap">
        <header className="sec-head rv">
          <p className="eyebrow">How a meeting works</p>
          <h2 id="how-h">Five steps, once a day. Anyone can start&nbsp;them.</h2>
          <p className="lead">
            The model decides. The contract checks the signature, cuts the ruling to the constitution and applies it. If any check fails, a fixed fallback
            rule runs instead.
          </p>
        </header>
        <FlowScenes key={m1 ? "live" : "plain"} data={flow}>
          {STEPS.map((s, i) => (
            <li className="flow-step" key={s.key}>
              <canvas className="flow-cv" aria-hidden="true" />
              <div className="flow-txt">
                <p className="flow-n">
                  <span>{i + 1}</span>
                  {s.name}
                </p>
                <p>{s.body}</p>
                <p className="flow-d m">{d?.[s.key]}</p>
              </div>
            </li>
          ))}
        </FlowScenes>
        {m1 === null ? (
          <Offline>Couldn’t reach testnet just now, so meeting 1’s values are not shown under the steps.</Offline>
        ) : (
          <p className="fine rv">
            Values under each step are read from meeting 1 on <span className="m">{m1?.contract ?? CONTRACT}</span>
            {m1 === undefined ? " (loading)" : ""}. Dot positions are illustrative.
          </p>
        )}
      </div>
    </section>
  );
}
