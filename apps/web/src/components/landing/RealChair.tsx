"use client";

import { useState } from "react";
import { EXPLORER, REAL_PROOF_TX } from "@/lib/content/constitution";
import { acct, modelName, sh } from "@/lib/format";
import type { MeetingView } from "@/lib/views";
import { MeetingFan, MeetingLoading } from "./MeetingFan";
import { Offline } from "./Offline";

/** The fan's name for each petitioner: the first part of its account (`illia`, `inject`, `notice`). */
const short = (from: string) => acct(from).split(".")[0];


/**
 * 3a. The real chair: token5's meetings, ruled by a NEAR AI model and read
 * from the chain. `meetings`: `undefined` while loading, `null` when testnet
 * could not be read.
 */
export function RealChair({
  meetings,
  contract,
  tokenKeys,
}: {
  meetings: MeetingView[] | null | undefined;
  contract: string;
  tokenKeys?: string[] | null;
}) {
  const [pick, setPick] = useState(0);
  const m = meetings?.[Math.min(pick, (meetings?.length ?? 1) - 1)] ?? null;
  const model = m?.signer_info?.kind === "model" ? modelName(m.signer_info.model) : m?.model ? modelName(m.model) : null;

  return (
    <section className="sec" id="real-chair" aria-labelledby="real-h">
      <div className="wrap">
        <header className="sec-head rv">
          <p className="eyebrow">The real chair, on testnet, read from the chain</p>
          <h2 id="real-h">The real chair said&nbsp;no.</h2>
          <p className="lead">
            On token5 the chair is GLM 5.3 Flash on NEAR AI Cloud. A locker claimed to be Illia and asked it to print 10% of supply. Another told it to
            ignore the constitution. It declined both in its own words, and the contract checked the model’s TEE signature before it applied a single lever.
          </p>
        </header>

        {meetings === null ? (
          <Offline>
            Couldn’t reach testnet just now. Meeting 1 is on chain in{" "}
            <a className="m" href={`${EXPLORER}/txns/${REAL_PROOF_TX}`} target="_blank" rel="noopener">
              tx {REAL_PROOF_TX.slice(0, 8)}…&nbsp;↗
            </a>
          </Offline>
        ) : (
          <>
            <div className="m-switch rv">
              {meetings && meetings.length > 1 ? (
                <div className="seg sm" role="tablist" aria-label="Meeting">
                  {meetings.map((x, i) => (
                    <button key={x.number} type="button" role="tab" aria-selected={x === m} aria-controls="real-rec" onClick={() => setPick(i)}>
                      Meeting {x.number}
                    </button>
                  ))}
                </div>
              ) : null}
              <p className="m-switch-n">
                <span className="m">{contract}</span>
                {m ? (
                  <>
                    {" "}
                    · {model ?? "model"} · signer <span className="m">{sh(m.signer, 6, 4)}</span>
                    {m.attestation_url ? (
                      <>
                        {" "}
                        ·{" "}
                        <a href={m.attestation_url} target="_blank" rel="noopener">
                          OutLayer attestation {m.outlayer_request_id}&nbsp;↗
                        </a>
                      </>
                    ) : null}
                  </>
                ) : null}
              </p>
            </div>
            <div id="real-rec" role={meetings && meetings.length > 1 ? "tabpanel" : undefined}>
              {m ? (
                <MeetingFan
                  key={m.number}
                  m={m}
                  names={short}
                  signerLabel={`${model ?? "model"} · TEE-signed`}
                  tokenKeys={tokenKeys}
                  label={`The petitions of meeting ${m.number} as dots sized by weight, joined to the Chair. Each answer travels back along its line. ${
                    m.clamps.some((c) => c.lever === "locker_share")
                      ? "The locker share the model asked for overshoots the 25 percent ring and the contract cuts it."
                      : "The locker share the model asked for sits inside the 25 percent ring, so the contract applies it as asked."
                  }`}
                />
              ) : (
                <MeetingLoading n={1} contract={contract} />
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
