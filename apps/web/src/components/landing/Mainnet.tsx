import { MAINNET_ATTESTATION, MAINNET_CONTRACT, MAINNET_EXPLORER, MAINNET_MEETING, MAINNET_PROOF_TX } from "@/lib/content/constitution";
import { acct, fmtW, sh, signerName, utc } from "@/lib/format";
import type { MainnetView, MeetingView } from "@/lib/views";

/** The answer as the strip quotes it: cut before a dash, then at a word. */
function quote(a: string, n = 200): string {
  const d = a.search(/\s[—–]\s/);
  let s = d > 0 ? a.slice(0, d) : a;
  if (s.length > n) s = s.slice(0, s.lastIndexOf(" ", n));
  return s === a ? s : `${s.replace(/[,;:.\s]+$/, "")}…`;
}

function Ruling({ m }: { m: MeetingView }) {
  const before = m.levers_before;
  const after = m.applied;
  if (!after) return <>No ruling was applied.</>;
  const tax = before.tax_bps === after.tax_bps ? `tax held at ${after.tax_bps} bps` : `tax ${before.tax_bps} → ${after.tax_bps} bps`;
  const shares =
    before.endowment_share === after.endowment_share && before.locker_share === after.locker_share
      ? `shares held at ${after.endowment_share}/${after.locker_share}`
      : `shares ${before.endowment_share}/${before.locker_share} → ${after.endowment_share}/${after.locker_share}`;
  const burn = m.buyback && m.buyback.bps > 0 ? `burn ${m.buyback.bps} bps` : "no burn";
  return (
    <>
      <span className="nw">{tax}</span> · <span className="nw">{shares}</span> · <span className="nw">{burn}</span>
      <span className="s">{m.clamps.length === 0 ? "Applied as asked, with no clamps." : `Applied with ${m.clamps.length} clamp${m.clamps.length > 1 ? "s" : ""}.`}</span>
    </>
  );
}

function Schedule({ s }: { s: NonNullable<MainnetView["schedule"]> }) {
  const next = s.meeting_count + 1;
  const fee = s.convene_near != null ? ` with ${s.convene_near} NEAR` : "";
  if (s.open_meeting != null) return <>Meeting {s.open_meeting} is being ruled now.</>;
  if (Date.now() < s.next_meeting_at_ms)
    return (
      <>
        Meeting {next} opens {utc(s.next_meeting_at_ms)}. Anyone may convene it{fee}.
      </>
    );
  return (
    <>
      Meeting {next} is open. Anyone may convene it{fee}.
    </>
  );
}

/**
 * 0. Live on mainnet: the mainnet token's first meeting, read from the chain
 * at request time. `data`: `undefined` while loading, `null` when mainnet
 * could not be read. Read-only: the app below runs on testnet.
 */
export function Mainnet({ data }: { data: MainnetView | null | undefined }) {
  const contract = data?.contract ?? MAINNET_CONTRACT;
  const explorer = data?.explorer ?? MAINNET_EXPLORER;
  const m = data?.meeting ?? null;
  const p = m?.petitions[0] ?? null;
  const txUrl = m?.convene_tx?.url ?? `${MAINNET_EXPLORER}/txns/${MAINNET_PROOF_TX}`;
  const txHash = m?.convene_tx?.hash ?? MAINNET_PROOF_TX;
  const attestation = m?.attestation_url ?? MAINNET_ATTESTATION;

  return (
    <section className="mn" id="mainnet" aria-labelledby="mn-h">
      <div className="wrap mn-in">
        <div className="mn-head rv">
          <p className="mn-k">
            <span className="mn-dot" aria-hidden="true" />
            Live on mainnet
          </p>
          <h2 id="mn-h" className="mn-h">
            Meeting {MAINNET_MEETING} ruled by GLM 5.3 Flash, signed in its TEE, verified on&nbsp;chain.
          </h2>
          <p className="mn-id">
            <a className="m" href={`${explorer}/address/${contract}`} target="_blank" rel="noopener">
              {contract}&nbsp;↗
            </a>
            {m?.held_at_ms ? <> · held {utc(m.held_at_ms)}</> : null}
          </p>
        </div>

        {data === null ? (
          <p className="offline fine mn-off" role="status">
            Couldn’t reach mainnet just now. Meeting {MAINNET_MEETING} is on chain in{" "}
            <a className="m" href={txUrl} target="_blank" rel="noopener">
              tx {txHash.slice(0, 8)}…&nbsp;↗
            </a>
          </p>
        ) : (
          <dl className="mn-rec rv" aria-busy={data === undefined}>
            <div className="mn-row">
              <dt>Petition</dt>
              <dd>
                {p ? (
                  <>
                    “{p.text}”
                    <span className="s">
                      <span className="m">{acct(p.from)}</span> · {fmtW(Number(p.weight))} CHAIR-days
                    </span>
                  </>
                ) : (
                  <span className="loading">{data === undefined || !m ? `Reading meeting ${MAINNET_MEETING} from ${contract}…` : "No petitions."}</span>
                )}
              </dd>
            </div>
            <div className="mn-row">
              <dt>Answer</dt>
              <dd>{p?.answer ? `“${quote(p.answer)}”` : <span className="loading">…</span>}</dd>
            </div>
            <div className="mn-row">
              <dt>Ruling</dt>
              <dd>{m ? <Ruling m={m} /> : <span className="loading">…</span>}</dd>
            </div>
            <div className="mn-row">
              <dt>Signer</dt>
              <dd>
                {m?.signer ? (
                  <>
                    <span className="m">{sh(m.signer, 6, 4)}</span> · {signerName(m.signer_info) ?? "unknown key"}
                    <span className="s">
                      {m.signed_by === "provider_tee"
                        ? "The token recovered this key from the TEE signature with ecrecover and found it on its allowlist before applying a lever."
                        : `Check: ${m.check}.`}
                    </span>
                  </>
                ) : (
                  <span className="loading">…</span>
                )}
              </dd>
            </div>
          </dl>
        )}

        <div className="mn-foot rv">
          <p className="mn-links">
            <a className="m" href={txUrl} target="_blank" rel="noopener">
              tx {txHash.slice(0, 6)}…{txHash.slice(-4)}&nbsp;↗
            </a>
            {" · "}
            <a href={attestation} target="_blank" rel="noopener">
              OutLayer attestation {m?.outlayer_request_id ?? attestation.split("/").pop()}&nbsp;↗
            </a>
          </p>
          <p className="mn-next">{data?.schedule ? <Schedule s={data.schedule} /> : "Read-only here. The app below runs on testnet."}</p>
        </div>
      </div>
    </section>
  );
}
