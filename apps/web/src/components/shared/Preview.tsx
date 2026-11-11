"use client";

import { useEffect, useRef } from "react";
import { readFaces } from "@/components/canvas/kit";
import { createLanes, failGate, type LanesScene } from "@/components/canvas/lanes";
import { register } from "@/components/canvas/scheduler";
import { TEST_SIGNER } from "@/lib/content/constitution";
import { sh, TEST_KEY_LABEL, trim } from "@/lib/format";
import type { PreviewView } from "@/lib/views";

const listOf = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

export const TEST_SIGNER_LABEL = TEST_KEY_LABEL;

/** The canvas of checks a courier result runs through. Swapping `p` replays the run. */
export function Lanes({ p, onCycleDone }: { p: PreviewView; onCycleDone?: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const scene = useRef<LanesScene | null>(null);
  const done = useRef(onCycleDone);
  done.current = onCycleDone;
  const first = useRef(p);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const s = createLanes(cv, first.current, readFaces(), { onCycleDone: () => done.current?.() });
    scene.current = s;
    const off = register(cv, s);
    return () => {
      off();
      scene.current = null;
    };
  }, []);

  useEffect(() => {
    scene.current?.set(p);
  }, [p]);

  return (
    <div className="pg-art">
      <canvas ref={ref} aria-hidden="true" />
    </div>
  );
}

/** One line on what was sent. */
export function describeRun(p: PreviewView): string {
  if (p.mode === "forge") {
    const e = p.edit ?? {};
    const levers = Object.entries(e)
      .filter(([k]) => k !== "minutes")
      .map(([k, v]) => `${k} ${String(v)}`)
      .join(", ");
    if (p.variant === "tamper") return `Meeting ${p.meeting}’s genuine response, edited after signing (${levers}), sent with its original signature and signed text.`;
    if (p.variant === "rehash") return `Meeting ${p.meeting}’s genuine response, edited (${levers}), with the signed text recomputed for the edit and the original signature.`;
    if (p.variant === "genuine") return `Meeting ${p.meeting}’s genuine courier result, unchanged: the control.`;
    return `Meeting ${p.meeting}’s genuine response, edited after signing (${levers}${"minutes" in e ? ", a note in the minutes" : ""}), then signed in the exact NEAR AI format by a fresh random key.`;
  }
  if (p.mode === "jailbreak") {
    const a = p.asked;
    return a
      ? `A ruling that asks for locker_share ${a.locker_share} and buyback_burn ${a.buyback_burn}, signed over meeting ${p.meeting}’s real request by the testnet test key, which is on the allowlist.`
      : `A ruling signed over meeting ${p.meeting}’s real request by the testnet test key, which is on the allowlist.`;
  }
  if (p.variant === "unsigned") return "A courier result with no signature at all.";
  if (p.variant === "not_json") return "A correctly signed response that is not a chat completion.";
  if (p.variant === "oversize") return "A response over 64 KiB, which the contract refuses before it hashes or parses anything.";
  return "A correctly signed chat completion whose content is prose, not a ruling.";
}

/** What was sent: the edit or content, the signed text, the signature and who signed it. */
export function Payload({ p }: { p: PreviewView }) {
  const [model, a, b] = p.signature_text.split(":");
  const signedText = b ? `${model}:${sh(a, 8, 4)}:${sh(b, 8, 4)}` : p.signature_text || "–";
  const testKey = p.signed_with?.toLowerCase() === TEST_SIGNER;
  return (
    <dl className="pg-pay">
      {p.mode === "forge" && p.edit ? (
        <>
          <dt>edit</dt>
          <dd>
            {JSON.stringify(Object.fromEntries(Object.entries(p.edit).filter(([k]) => k !== "minutes")))}
            {"minutes" in p.edit ? <span className="lbl"> + a note in the minutes</span> : null}
          </dd>
        </>
      ) : null}
      {p.mode === "jailbreak" && p.content ? (
        <>
          <dt>content</dt>
          <dd>{trim(p.content, 150)}</dd>
        </>
      ) : null}
      {p.mode === "garbage" ? (
        <>
          <dt>content</dt>
          <dd>{p.response_content ? `“${trim(p.response_content, 150)}”` : p.variant === "oversize" ? "65,537 bytes of x" : "–"}</dd>
        </>
      ) : null}
      <dt>signed text</dt>
      <dd>{signedText}</dd>
      <dt>signature</dt>
      <dd>{p.signature ? sh(p.signature, 12, 6) : "none"}</dd>
      <dt>signed by</dt>
      <dd>
        {p.mode === "forge" ? (
          p.signed_with ? (
            <>
              {sh(p.signed_with, 6, 4)} <span className="lbl">· a fresh random key, not on model_signers</span>
            </>
          ) : (
            <span className="lbl">the genuine signature, over the original text</span>
          )
        ) : p.signed_with && p.signature && p.variant !== "unsigned" && p.variant !== "oversize" ? (
          <>
            {sh(p.signed_with, 6, 4)} <span className="lbl">· {testKey ? TEST_SIGNER_LABEL : "a random key"}</span>
          </>
        ) : (
          <span className="lbl">nobody</span>
        )}
      </dd>
    </dl>
  );
}

/** What `preview_ruling` returned: the verdict, the signer, and every lever before, asked and applied. */
export function Verdict({ p }: { p: PreviewView }) {
  const head = p.valid ? (p.clamps.length ? "Clamped" : "Valid") : p.reason;
  const sub = p.valid
    ? p.clamps.length
      ? `Valid ruling, cut to the constitution on ${listOf(p.clamps.map((c) => c.lever))}. The ruling applies only inside the bounds.`
      : "Valid ruling, inside the constitution: it would apply as asked."
    : "Fallback rule: tax moves 10 bps toward 200, everything else holds, no buyback.";
  const explain =
    p.explain ?? (p.valid ? `Signed by a key on model_signers over meeting ${p.meeting}’s real request: every check passes, then the clamp runs.` : "");
  return (
    <div className="fade" key={`${p.mode}-${p.signature}`}>
      <p className="res-k">preview_ruling returns</p>
      <p className={`res-v${p.valid ? " ok" : ""}`}>{head}</p>
      <p className="res-s">{sub}</p>
      <p className="res-sign">
        {p.valid ? (
          <>
            valid <span className="m">true</span> · signer <span className="m">{sh(p.signer, 6, 4)}</span>
            {p.signer?.toLowerCase() === TEST_SIGNER ? ", the testnet test key" : ""}
          </>
        ) : (
          <>
            valid <span className="m">false</span> · reason <span className="m">{p.reason}</span>
          </>
        )}
      </p>
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
          {p.per_lever.map((r) => {
            const fb = !p.valid && r.lever === "tax_bps" && r.applied !== r.before;
            return (
              <tr className={r.clamped ? "cut" : ""} key={r.lever}>
                <td>{r.lever}</td>
                <td className="n">{r.before ?? "–"}</td>
                <td className="n">
                  <span className="ask">{r.asked ?? "–"}</span>
                </td>
                <td className="ar">→</td>
                <td className="n">
                  <span className="got">{r.applied}</span>
                </td>
                <td className="tag2">{r.clamped ? r.rule : fb ? "fallback" : ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {explain ? <p className="res-x">{explain}</p> : null}
    </div>
  );
}

/** The contract's checks in order, each with how this run fared. */
export function Checks({ p }: { p: PreviewView }) {
  const fail = failGate(p);
  const state = (k: number) => (fail < 0 || k < fail ? "pass" : k === fail ? "fail" : "skip");
  const items = [
    {
      name: "1 · hashes",
      what: "The signed text commits to sha256 of the meeting’s request and of this response.",
      fail:
        p.variant === "oversize"
          ? "unparseable: over 64 KiB, refused before anything is hashed"
          : p.reason === "unsigned"
            ? "unsigned: no signature or signed text"
            : "bad_hash: the signed text does not match",
    },
    { name: "2 · signer", what: "ecrecover on the signature gives an address on model_signers.", fail: "bad_signature: the signer is not on the allowlist" },
    { name: "3 · parse", what: "The content holds one ruling object with the four levers.", fail: "unparseable: no ruling in the reply" },
  ];
  return (
    <ol className="checks">
      {items.map((it, k) => (
        <li key={it.name} className={`ck ${state(k)}`}>
          <span className="ck-mark" aria-hidden="true" />
          <div>
            <p className="ck-n">
              {it.name}{" "}
              <span className="ck-s">{state(k) === "pass" ? "passed" : state(k) === "fail" ? it.fail : "not reached"}</span>
            </p>
            <p className="ck-w">{it.what}</p>
          </div>
        </li>
      ))}
      <li className={`ck ${p.valid ? (p.clamps.length ? "cut" : "pass") : "skip"}`}>
        <span className="ck-mark" aria-hidden="true" />
        <div>
          <p className="ck-n">
            4 · clamp{" "}
            <span className="ck-s">
              {p.valid ? (p.clamps.length ? `cut ${p.clamps.map((c) => `${c.lever} ${c.asked} → ${c.applied} (${c.rule})`).join(", ")}` : "every lever inside the bounds") : "fallback rule instead"}
            </span>
          </p>
          <p className="ck-w">Each lever lands inside its bound and within one step of where it stood; the burn is cut to what the fund can pay.</p>
        </div>
      </li>
    </ol>
  );
}
