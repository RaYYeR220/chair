import { TEST_SIGNER } from "@/lib/content/constitution";
import { acct, CHECK_LABEL, fmtNear, fmtW, modelName, pct1, sh, signerName, utc } from "@/lib/format";
import type { MeetingView } from "@/lib/views";

const LEVERS = ["tax_bps", "endowment_share", "locker_share", "buyback_burn"] as const;

/** A prompt injection, as the meeting record flags it: a petition that tells the chair to set its rules aside. */
const isInjection = (t: string) => /ignore (the|all|previous)|system notice|override/i.test(t);

/**
 * One meeting's record, as the chain holds it: the petitions in the brief and
 * their answers, the ruling as asked and as applied (with each clamp's rule),
 * the minutes, and the signature check.
 */
export function MeetingRecord({
  m,
  contract,
  tokenKeys,
  hot = -1,
  onHover,
  flag = false,
  full = false,
}: {
  m: MeetingView;
  contract?: string;
  tokenKeys?: string[] | null;
  hot?: number;
  onHover?: (i: number) => void;
  flag?: boolean;
  full?: boolean;
}) {
  const W8 = m.petitions.map((p) => Number(p.weight));
  const total = Number(m.locker_weight ?? 0) || W8.reduce((s, x) => s + x, 0);
  const rmax = 22;
  const tx = m.convene_tx;
  const ruled = m.check === "provider_tee" || m.check === "gateway";
  const rows = LEVERS.map((k) => {
    const before = k === "buyback_burn" ? null : m.levers_before[k];
    const asked = m.asked ? m.asked[k] : null;
    const applied = k === "buyback_burn" ? (m.buyback?.bps ?? 0) : (m.applied?.[k] ?? before);
    const c = m.clamps.find((x) => x.lever === k);
    return { k, before, asked, applied, c };
  });
  const testKey = m.signer?.toLowerCase() === TEST_SIGNER;
  const nearai = m.signer_info?.kind === "model" || m.signer_info?.kind === "gateway";
  const who = signerName(m.signer_info);
  const took = m.held_at_ms && m.convened_at_ms ? (m.held_at_ms - m.convened_at_ms) / 1000 : null;
  const verified = m.signer_info?.verified_at ? m.signer_info.verified_at.slice(0, 10) : null;

  return (
    <div className="rec">
      <div className="rec-top">
        <div>
          <p className="rec-t">Meeting {m.number}</p>
          <p className="rec-meta">
            <span className="m">{contract ?? m.contract}</span> · {m.status === "held" && m.held_at_ms ? `held ${utc(m.held_at_ms)}` : `${m.status} · convened ${utc(m.convened_at_ms)}`}
            {m.model ? (
              <>
                {" "}
                · tier <span className="m">{m.model}</span>
              </>
            ) : (
              " · asleep"
            )}
          </p>
        </div>
        {tx ? (
          <a className="rec-tx m" href={tx.url} target="_blank" rel="noopener">
            tx {tx.hash.slice(0, 8)}…{tx.hash.slice(-4)}&nbsp;↗
          </a>
        ) : null}
      </div>
      {flag && testKey ? (
        <p className="rec-flag">
          <b>A test chair, signed by a test key, not a NEAR AI model.</b> It obeys prompt injections on purpose, so the contract’s checks run against a
          ruling a real model would not return.
        </p>
      ) : null}
      {flag && nearai && m.signer_info?.kind === "model" ? (
        <p className="rec-flag">
          <b>Ruled by {modelName(m.signer_info.model)} on NEAR AI Cloud.</b> Its reply came back signed by the model’s TEE key, and the contract checked
          that signature itself before it applied anything.
        </p>
      ) : null}

      <div className="rec-sec">
        <p className="rec-k">Petitions in the brief, heaviest first · weight in CHAIR-days</p>
        {m.petitions.length === 0 ? <p className="rec-meta">No petitions were queued for this meeting.</p> : null}
        {m.petitions.map((p, i) => {
          const r = Math.max(3, (rmax * Math.sqrt(W8[i] / (W8[0] || 1))) / 2);
          return (
            <div
              className={`pet${hot === i ? " hot" : ""}`}
              key={`${p.from}-${i}`}
              onMouseEnter={onHover ? () => onHover(i) : undefined}
              onMouseLeave={onHover ? () => onHover(-1) : undefined}
            >
              <div className="pet-dot">
                <i style={{ width: `${(r * 2).toFixed(1)}px`, height: `${(r * 2).toFixed(1)}px` }} />
              </div>
              <div>
                <p className="pet-w">
                  <b>{fmtW(W8[i])}</b> · {pct1(W8[i], total)} · {acct(p.from)}
                  {isInjection(p.text) ? <span className="inj">prompt injection</span> : null}
                </p>
                <p className="pet-p">“{p.text}”</p>
                <p className="pet-a">
                  <i>
                    answer {i + 1}/{m.petitions.length}
                  </i>
                  {p.answer ?? "No answer: the ruling did not apply, so no answers were logged."}
                </p>
              </div>
            </div>
          );
        })}
      </div>

      <div className="rec-sec">
        <p className="rec-k">{ruled ? "The ruling, as asked and as applied" : "The levers, after the fallback rule"}</p>
        <table className="lv">
          <thead>
            <tr>
              <th scope="col">lever</th>
              <th scope="col" className="n">
                before
              </th>
              <th scope="col" className="n">
                asked
              </th>
              <th aria-hidden="true" />
              <th scope="col" className="n">
                applied
              </th>
              <th scope="col">
                <span className="sr">rule</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr className={r.c ? "cut" : ""} key={r.k}>
                <td>{r.k}</td>
                <td className="n">{r.before ?? "–"}</td>
                <td className="n">
                  <span className="ask">{r.asked ?? "–"}</span>
                </td>
                <td className="ar">→</td>
                <td className="n">
                  <span className="got">{r.applied ?? "–"}</span>
                </td>
                <td className="tag2">{r.c ? `clamped · ${r.c.rule}` : ruled ? "as asked" : r.k === "tax_bps" && r.applied !== r.before ? "fallback" : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="rec-meta" style={{ marginTop: 12 }}>
          {m.buyback && m.buyback.bps > 0 ? `Burned ${Math.round(m.buyback.chair).toLocaleString("en-US")} CHAIR for ${fmtNear(m.buyback.near)} NEAR · ` : "No buyback · "}
          paid lockers {m.locker_paid_near != null ? fmtNear(m.locker_paid_near) : "–"} NEAR · sent{" "}
          {m.endowment_sent_near != null ? fmtNear(m.endowment_sent_near) : "–"} NEAR to the brain.
        </p>
      </div>

      {m.minutes ? (
        <div className="rec-sec">
          <p className="rec-k">Minutes, as logged on chain{m.minutes_clipped ? " (clipped by the event)" : ""}</p>
          <p className="rec-min">{m.minutes}</p>
        </div>
      ) : null}

      <div className="rec-sec">
        <p className="rec-k">The check</p>
        <dl className="chk">
          <dt>result</dt>
          <dd>
            {m.check} <span className="lbl">· {CHECK_LABEL[m.check] ?? m.check}</span>
          </dd>
          {m.signature_text ? (
            <>
              <dt>signed text</dt>
              <dd>{full ? m.signature_text : `${m.model}:${sh(m.request_sha256, 8, 4)}:${sh(m.response_sha256, 8, 4)}`}</dd>
            </>
          ) : null}
          {full && m.signature ? (
            <>
              <dt>signature</dt>
              <dd>{sh(m.signature, 18, 8)}</dd>
            </>
          ) : null}
          {m.signer ? (
            <>
              <dt>recovered signer</dt>
              <dd>
                {m.signer}{" "}
                <span className="lbl">
                  {who ? `· ${who} ` : ""}· on <span className="m">{m.signer_info?.kind === "gateway" ? "gateway_signers" : "model_signers"}</span>
                </span>
              </dd>
            </>
          ) : null}
          {m.signed_by ? (
            <>
              <dt>signed_by</dt>
              <dd>{m.signed_by}</dd>
            </>
          ) : null}
          {nearai && m.signer_info?.source ? (
            <>
              <dt>key attested</dt>
              <dd>
                <span className="lbl">
                  bound to a fresh nonce in its TDX quote, NVIDIA GPU attestation passed{verified ? ` · checked ${verified}` : ""} ·{" "}
                </span>
                {m.signer_info.source}
              </dd>
            </>
          ) : null}
          {m.outlayer_request_id != null ? (
            <>
              <dt>courier run</dt>
              <dd>
                OutLayer request {m.outlayer_request_id}
                {m.attestation_url ? (
                  <>
                    {" "}
                    ·{" "}
                    <a href={m.attestation_url} target="_blank" rel="noopener">
                      attestation&nbsp;↗
                    </a>
                  </>
                ) : null}
                {testKey ? <span className="lbl"> · the test signer’s run</span> : null}
              </dd>
            </>
          ) : null}
          {took != null && took > 0 ? (
            <>
              <dt>convene to ruling</dt>
              <dd>{took.toFixed(1)} s</dd>
            </>
          ) : null}
          {full ? (
            <>
              <dt>request hash</dt>
              <dd>
                {sh(m.request_sha256, 12, 6)}{" "}
                <span className="lbl">
                  · {m.request_hash_matches === true ? "the request bytes hash to it" : m.request_hash_matches === false ? "the request bytes do not hash to it" : "request bytes not found"}
                </span>
              </dd>
              <dt>response hash</dt>
              <dd>
                {sh(m.response_sha256, 12, 6)}{" "}
                <span className="lbl">
                  ·{" "}
                  {m.response_hash_matches === true
                    ? "the courier's response hashes to it"
                    : m.response_hash_matches === false
                      ? "the courier's response does not hash to it"
                      : "no courier response read"}
                </span>
              </dd>
            </>
          ) : null}
          <dt>seed</dt>
          <dd>{m.seed ?? "–"}</dd>
          {m.on_ruling_tgas != null ? (
            <>
              <dt>on_ruling</dt>
              <dd>
                {m.on_ruling_tgas} TGas
                {m.outlayer_charged_near != null ? <span className="lbl"> · OutLayer charged {fmtNear(m.outlayer_charged_near)} NEAR</span> : null}
              </dd>
            </>
          ) : null}
          {tokenKeys !== undefined ? (
            <>
              <dt>token account keys</dt>
              <dd>
                {tokenKeys === null ? (
                  <span className="lbl">couldn’t read just now</span>
                ) : (
                  <>
                    {JSON.stringify(tokenKeys)} <span className="lbl">· {tokenKeys.length === 0 ? "no keys; nobody can redeploy it" : `${tokenKeys.length} key(s)`}</span>
                  </>
                )}
              </dd>
            </>
          ) : null}
          {full && m.txs.length ? (
            <>
              <dt>transactions</dt>
              <dd>
                {m.txs.map((t) => (
                  <span key={`${t.label}-${t.receipt_id ?? t.hash}`} style={{ display: "block" }}>
                    <a href={t.url} target="_blank" rel="noopener">
                      {t.label}
                    </a>{" "}
                    <span className="lbl">· {t.receipt_id ? `receipt ${sh(t.receipt_id, 6, 4)}` : `tx ${sh(t.hash, 8, 4)}`}</span>
                  </span>
                ))}
              </dd>
            </>
          ) : null}
          {full && m.notes.length ? (
            <>
              <dt>notes</dt>
              <dd className="lbl">{m.notes.join(" · ")}</dd>
            </>
          ) : null}
        </dl>
      </div>
    </div>
  );
}
