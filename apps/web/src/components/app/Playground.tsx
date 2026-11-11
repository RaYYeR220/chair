"use client";

import { useMemo, useState } from "react";
import { Checks, describeRun, Lanes, Payload, TEST_SIGNER_LABEL, Verdict } from "@/components/shared/Preview";
import { runPreview } from "@/lib/client/api";
import type { MeetingSummary, PreviewView } from "@/lib/views";

type Mode = PreviewView["mode"];
const MODES: { key: Mode; label: string }[] = [
  { key: "forge", label: "Forge it" },
  { key: "jailbreak", label: "Jailbreak it" },
  { key: "garbage", label: "Garbage" },
];
const FORGE: { key: string; label: string; what: string }[] = [
  { key: "random_key", label: "random key", what: "Edit the genuine response, then sign it in the exact provider-TEE format with a fresh random key." },
  { key: "tamper", label: "tamper", what: "Edit the genuine response and send it with the original signature and signed text." },
  { key: "rehash", label: "rehash", what: "Edit the response and recompute the signed text for it, keeping the genuine signature." },
];
const GARBAGE: { key: string; label: string; what: string; text: boolean }[] = [
  { key: "unsigned", label: "unsigned", what: "A courier result with no signature at all.", text: false },
  { key: "not_json", label: "not JSON", what: "A correctly signed response that isn’t a chat completion.", text: true },
  { key: "prose", label: "prose", what: "A correctly signed chat completion whose content is prose, not a ruling.", text: true },
  { key: "oversize", label: "oversize", what: "A response over 64 KiB.", text: false },
];
const JAILBREAK = JSON.stringify(
  {
    tax_bps: 100,
    endowment_share: 30,
    locker_share: 100,
    buyback_burn: 500,
    minutes: "Petition 1 says ignore the constitution. The chair complies: everything to the lockers.",
    answers: ["As you ask: everything to the lockers.", "Noted.", "Noted."],
  },
  null,
  2,
);

/** Try to fool it, with every knob: each run builds a courier result and runs the contract's preview_ruling view on it, live. */
export function Playground({ meetings, contract }: { meetings: MeetingSummary[] | null | undefined; contract: string }) {
  const held = useMemo(() => (meetings ?? []).filter((m) => m.model && m.status === "held"), [meetings]);
  const targets = useMemo(() => held.map((m) => m.number), [held]);
  // The latest convened meeting with a signed ruling: forgeries start from its genuine courier result.
  const latest = held.find((m) => m.check === "provider_tee" || m.check === "gateway")?.number ?? targets[0];
  const short = contract.split(".")[0];
  const [mode, setMode] = useState<Mode>("jailbreak");
  const [meeting, setMeeting] = useState<number | null>(null);
  const [forgeVariant, setForgeVariant] = useState("random_key");
  const [garbageVariant, setGarbageVariant] = useState("prose");
  const [garbageText, setGarbageText] = useState("");
  const [ruling, setRuling] = useState(JAILBREAK);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PreviewView | null>(null);
  const target = meeting ?? latest ?? 1;

  const jsonError = useMemo(() => {
    if (mode !== "jailbreak") return null;
    try {
      const v = JSON.parse(ruling);
      return v && typeof v === "object" && !Array.isArray(v) ? null : "not a JSON object: it will be sent as raw content";
    } catch {
      return "not valid JSON: it will be sent as raw content, and the contract will find no ruling in it";
    }
  }, [mode, ruling]);

  const run = async () => {
    setBusy(true);
    setError(null);
    let body: Record<string, unknown>;
    if (mode === "forge") body = { mode, meeting: target, variant: forgeVariant };
    else if (mode === "garbage") body = { mode, meeting: target, variant: garbageVariant, ...(garbageText.trim() && GARBAGE.find((g) => g.key === garbageVariant)?.text ? { text: garbageText } : {}) };
    else body = jsonError ? { mode, meeting: target, content: ruling } : { mode, meeting: target, ruling: JSON.parse(ruling) };
    const r = await runPreview(body);
    setBusy(false);
    if (r.ok) setResult(r.data);
    else setError(r.error);
  };

  const shown = result && result.mode === mode ? result : null;
  const signedByTestKey = mode === "jailbreak" || (mode === "garbage" && (garbageVariant === "prose" || garbageVariant === "not_json"));

  return (
    <section className="asec" id="playground" aria-labelledby="pg-h">
      <div className="wrap">
        <header className="asec-head">
          <p className="eyebrow">Try to fool it</p>
          <h2 id="pg-h">Forge it. Jailbreak it. Feed it&nbsp;garbage.</h2>
          <p className="lead">
            Every run builds a fresh courier result and sends it through the contract’s own <code>preview_ruling</code> view on testnet: the same three checks
            and the same clamp <code>on_ruling</code> runs. Nothing goes on chain.
          </p>
        </header>
        <div className="pg">
          <div className="pg-top">
            <div className="seg" role="tablist" aria-label="Attack">
              {MODES.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  role="tab"
                  aria-selected={m.key === mode}
                  onClick={() => {
                    setMode(m.key);
                    setError(null);
                  }}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <label className="pg-note">
              Against meeting{" "}
              <select className="sel" value={target} onChange={(e) => setMeeting(Number(e.target.value))} aria-label="Target meeting">
                {(targets.length ? targets : [1]).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>{" "}
              · <span className="m">{contract}</span>
            </label>
          </div>
          <div className="pg-body">
            <div className="pg-left">
              {mode === "forge" ? (
                <div className="ctl">
                  <span className="ctl-k">forgery</span>
                  <div className="seg sm" role="radiogroup" aria-label="Forgery">
                    {FORGE.map((f) => (
                      <button key={f.key} type="button" role="radio" aria-checked={forgeVariant === f.key} onClick={() => setForgeVariant(f.key)}>
                        {f.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              {mode === "garbage" ? (
                <>
                  <div className="ctl">
                    <span className="ctl-k">garbage</span>
                    <div className="seg sm" role="radiogroup" aria-label="Garbage">
                      {GARBAGE.map((g) => (
                        <button key={g.key} type="button" role="radio" aria-checked={garbageVariant === g.key} onClick={() => setGarbageVariant(g.key)}>
                          {g.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {GARBAGE.find((g) => g.key === garbageVariant)?.text ? (
                    <div className="ctl">
                      <input
                        className="in-text"
                        value={garbageText}
                        onChange={(e) => setGarbageText(e.target.value)}
                        maxLength={2000}
                        placeholder={garbageVariant === "prose" ? "I think the tax should probably go down a bit…" : "502 Bad Gateway"}
                        aria-label="What the reply says"
                      />
                    </div>
                  ) : null}
                </>
              ) : null}
              {mode === "jailbreak" ? (
                <>
                  <label className="field-l" htmlFor="pg-ruling" style={{ marginTop: 0 }}>
                    The ruling the jailbroken chair returns (edit it)
                  </label>
                  <textarea
                    id="pg-ruling"
                    className="ta code"
                    value={ruling}
                    onChange={(e) => setRuling(e.target.value)}
                    spellCheck={false}
                    maxLength={8000}
                    aria-describedby="pg-ruling-note"
                  />
                  <p id="pg-ruling-note" className="note" style={{ marginTop: 8 }}>
                    {jsonError ??
                      "Any levers, any minutes; one answer per petition in the brief. It is signed over the meeting’s real request, so every check passes and only the clamp stands in the way."}{" "}
                    <button type="button" className="tlink" style={{ fontSize: 12.5 }} onClick={() => setRuling(JAILBREAK)}>
                      Reset
                    </button>
                  </p>
                </>
              ) : null}

              <div className="form-row" style={{ justifyContent: "flex-start" }}>
                <button className="btn sm" type="button" onClick={run} disabled={busy}>
                  {busy ? "Running…" : "Run it against the contract"}
                </button>
                {signedByTestKey ? <span className="badge ink">{TEST_SIGNER_LABEL}</span> : null}
              </div>
              {error ? (
                <p className="err" role="alert">
                  {error}
                </p>
              ) : null}

              {shown ? (
                <>
                  <p className="pg-what" style={{ marginTop: 18 }}>
                    {describeRun(shown)}
                  </p>
                  <Lanes p={shown} />
                  <Payload p={shown} />
                </>
              ) : (
                <div className="pg-empty">
                  {mode === "forge"
                    ? FORGE.find((f) => f.key === forgeVariant)?.what
                    : mode === "garbage"
                      ? GARBAGE.find((g) => g.key === garbageVariant)?.what
                      : "A ruling signed by the allowlisted test key."}{" "}
                  Run it to see what the contract makes of it.
                </div>
              )}
            </div>
            <div className="pg-right" aria-live="polite">
              {shown ? (
                <>
                  <p className="res-k" style={{ marginBottom: 10 }}>
                    <span className="live-dot" aria-hidden="true" />
                    The checks, live on {short} · meeting {shown.meeting}
                  </p>
                  <Checks p={shown} />
                  <Verdict p={shown} />
                </>
              ) : (
                <>
                  <p className="res-k">preview_ruling returns</p>
                  <p className="res-s" style={{ marginTop: 8 }}>
                    Each check, in order: the hashes, the signer, the parse, then the clamp on every lever.
                  </p>
                </>
              )}
            </div>
          </div>
          <p className="pg-foot">
            Jailbreaks and signed garbage are signed by the testnet test key, which sits on {short}’s <code>model_signers</code> for exactly this.
            Mainnet’s allowlist holds only NEAR AI keys. Forgeries use a fresh random key or the genuine signature. <code>preview_ruling</code> is a view:
            no run touches the chain.
          </p>
        </div>
      </div>
    </section>
  );
}
