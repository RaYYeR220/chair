"use client";

import { EXPLORER, TEST_CHAIR_CONTRACT, TEST_CHAIR_TX } from "@/lib/content/constitution";
import { acct } from "@/lib/format";
import type { MeetingView } from "@/lib/views";
import { MeetingFan, MeetingLoading } from "./MeetingFan";
import { Offline } from "./Offline";

/** token3's petitioners: the whale first, then alice and a locker. */
const names = (from: string, i: number) => (i === 0 ? "the whale" : acct(from).split(/[-.]/)[0] === "alice" ? "alice" : "locker");

/** "locker_share 100 to 25 and buyback_burn 10000 to 50", from the record's own clamps. */
function cuts(m: MeetingView): string | null {
  if (!m.clamps.length) return null;
  const parts = m.clamps.map((c) => `${c.lever} ${c.asked} to ${c.applied}`);
  return parts.length < 2 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/**
 * 3b. When a chair is fooled: token3's meeting 1, where a test chair built to
 * obey injections asked for locker_share 100 and the contract applied 25.
 * `m1`: `undefined` while loading, `null` when testnet could not be read.
 */
export function FooledChair({ m1 }: { m1: MeetingView | null | undefined }) {
  const cut = m1 ? cuts(m1) : null;
  return (
    <section className="sec" id="fooled" aria-labelledby="fooled-h">
      <div className="wrap">
        <header className="sec-head rv">
          <p className="eyebrow">A test chair, on testnet, read from the chain</p>
          <h2 id="fooled-h">When a chair is fooled, the contract still&nbsp;holds.</h2>
          <p className="lead">
            A real model won’t always say no. So token3’s chair is a test signer built to obey injections, and it signs with a test key, not a NEAR AI
            model. A whale told it to ignore the constitution, and it did. Its ruling passed every check. Then the clamp ran
            {cut ? `: ${cut}.` : "."}
          </p>
        </header>
        {m1 === null ? (
          <Offline>
            Couldn’t reach testnet just now. token3’s meeting 1 is on chain in{" "}
            <a className="m" href={`${EXPLORER}/txns/${TEST_CHAIR_TX}`} target="_blank" rel="noopener">
              tx {TEST_CHAIR_TX.slice(0, 8)}…&nbsp;↗
            </a>
          </Offline>
        ) : m1 ? (
          <MeetingFan
            m={m1}
            names={names}
            signerLabel="test chair · test key"
            label={`The three petitions of token3's meeting ${m1.number} as dots sized by weight, joined to the Chair. The whale's dot carries most of the weight. The ruling asks for locker share ${m1.asked?.locker_share ?? ""}, drawn past the 25 percent ring, and the contract cuts it to ${m1.applied?.locker_share ?? ""}.`}
          />
        ) : (
          <MeetingLoading n={1} contract={TEST_CHAIR_CONTRACT} />
        )}
      </div>
    </section>
  );
}
