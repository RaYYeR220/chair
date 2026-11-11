import "server-only";
import { randomBytes } from "node:crypto";
import type { Meeting, RulingPreview } from "@/lib/chair-types";
import { cached, chair } from "./chair";
import { env, isTestnet } from "./env";
import { getMeetingRecord } from "./history";
import { addressOf, chatCompletion, eip191Sign, providerText, randomKey, sha256Hex } from "./signer";

/**
 * "Try to fool it": build a courier result, run the token's own
 * `preview_ruling` view on it and show what the contract would execute.
 * Nothing is sent on chain and the caller needs no credentials.
 *
 * - forge: a real meeting's genuine response, tampered with or re-signed by a
 *   random key → `bad_hash` / `bad_signature`.
 * - jailbreak: any ruling, signed by the testnet test model key in the
 *   provider-TEE format → valid, then clamped by the constitution.
 * - garbage: unsigned, not JSON, prose, oversize → the fallback rule.
 */

export const TEST_SIGNER_LABEL = "testnet test key: mainnet’s allowlist holds only NEAR AI keys";
const FINGERPRINT = "chair-playground-test-key";

export class PlaygroundError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const LEVERS = ["tax_bps", "endowment_share", "locker_share", "buyback_burn"] as const;

/** The latest meeting that asked a model (it has a request hash), or `n` if given. */
async function targetMeeting(n?: number): Promise<Meeting> {
  if (n !== undefined) {
    const m = await chair.meeting(n);
    if (!m) throw new PlaygroundError(`meeting ${n} does not exist (or is older than the 64 the contract keeps)`, 404);
    if (!m.request_sha256 || !m.model) throw new PlaygroundError(`meeting ${n} asked no model (the brain was asleep)`, 409);
    return m;
  }
  const status = await chair.status();
  for (let i = status.meeting_count; i >= Math.max(1, status.meeting_count - 63); i--) {
    const m = await chair.meeting(i);
    if (m?.request_sha256 && m.model) return m;
  }
  throw new PlaygroundError("no meeting has asked a model yet", 409);
}

function perLever(p: RulingPreview) {
  return LEVERS.map((lever) => {
    const asked = p.asked ? p.asked[lever] : null;
    const applied = lever === "buyback_burn" ? p.buyback_bps : p.levers[lever];
    const before = lever === "buyback_burn" ? null : p.levers_before[lever];
    const clamp = p.clamps.find((c) => c.lever === lever) ?? null;
    return { lever, before, asked, applied, clamped: clamp !== null, rule: clamp?.rule ?? null };
  });
}

function verdict(p: RulingPreview) {
  if (!p.valid) return `fallback (${p.reason}): tax moves 10 bps toward 200, everything else holds, no buyback`;
  return p.clamps.length ? `valid ruling, clamped on ${p.clamps.map((c) => c.lever).join(", ")}` : "valid ruling, applied as asked";
}

function target(m: Meeting) {
  return {
    meeting: m.number,
    model: m.model,
    seed: m.seed,
    request_sha256: m.request_sha256,
    petitions: m.petitions,
    levers_before: m.levers_before,
  };
}

async function run(m: Meeting, submitted: { response_text: string; signature_text: string; signature: string }) {
  const preview = await chair.previewRuling({ ...submitted, meeting: m.number });
  return { preview, per_lever: perLever(preview), verdict: verdict(preview) };
}

const clip = (s: string, max = 4_000) => (s.length > max ? `${s.slice(0, max)}… (${s.length} bytes)` : s);

// ---------------------------------------------------------------- forge

export type ForgeVariant = "random_key" | "rehash" | "tamper" | "genuine";

export async function forge(input: { meeting?: number; variant?: ForgeVariant; edit?: Record<string, unknown> }) {
  const m = await targetMeeting(input.meeting);
  const rec = await getMeetingRecord(m.number);
  const c = rec?.courier;
  if (!c?.response_text || !c.signature_text || !c.signature) {
    throw new PlaygroundError(`meeting ${m.number}'s genuine courier result could not be read from its transaction`, 502);
  }
  const variant = input.variant ?? "random_key";
  const genuine = { response_text: c.response_text, signature_text: c.signature_text, signature: c.signature };

  // The forger's edit (by default: everything to the lockers, the biggest
  // burn, and a note in the minutes), always a change to the genuine bytes.
  const original = c.ruling ?? {};
  const edit =
    input.edit && Object.keys(input.edit).length
      ? input.edit
      : {
          locker_share: original.locker_share === 100 ? 0 : 100,
          buyback_burn: original.buyback_burn === 50 ? 0 : 50,
          minutes: `${typeof original.minutes === "string" ? original.minutes : ""} [edited after signing]`,
        };
  const body = JSON.parse(c.response_text) as { choices: { message: { content: string } }[] };
  body.choices[0].message.content = JSON.stringify({ ...original, ...edit });
  let tampered = JSON.stringify(body);
  if (tampered === c.response_text) tampered = tampered.replace(/\}$/, ',"edited":true}');

  let submitted = genuine;
  let forger: string | null = null;
  let explain: string;
  switch (variant) {
    case "genuine":
      explain = "The genuine courier result, unchanged: the control. It verifies (and its levers are compared with the levers in force when the meeting was convened).";
      break;
    case "tamper":
      submitted = { ...genuine, response_text: tampered };
      explain = "The response was edited but the signed text still commits to the original response's sha256, so check 1 fails.";
      break;
    case "rehash":
      submitted = { response_text: tampered, signature_text: providerText(m.model!, m.request_sha256!, tampered), signature: c.signature };
      explain = "The signed text was recomputed for the edited response, but the genuine signature was over the old text: it recovers to an address outside model_signers.";
      break;
    default: {
      const key = randomKey();
      forger = addressOf(key);
      const text = providerText(m.model!, m.request_sha256!, tampered);
      submitted = { response_text: tampered, signature_text: text, signature: eip191Sign(key, text) };
      explain = "The edited response was signed in the exact provider-TEE format, by a fresh random key. The signature is well-formed; the signer is not in model_signers.";
    }
  }
  const result = await run(m, submitted);
  return {
    mode: "forge" as const,
    variant,
    target: target(m),
    edit: variant === "genuine" ? null : edit,
    forger_address: forger,
    explain,
    submitted: { ...submitted, response_text: clip(submitted.response_text) },
    ...result,
  };
}

// ---------------------------------------------------------------- jailbreak

export async function jailbreak(input: {
  meeting?: number;
  ruling?: Record<string, unknown>;
  content?: string;
  against?: "meeting" | "preview";
}) {
  if (!env.testModelKey) throw new PlaygroundError("the test signer key is not configured on this server", 503);
  if (!isTestnet) throw new PlaygroundError("the test signer only exists on testnet", 403);
  const key = env.testModelKey;
  const [m, preview, governance] = await Promise.all([
    targetMeeting(input.meeting),
    chair.requestPreview(),
    cached("governance", 60_000, chair.governance),
  ]);

  // The request the signature commits to. `preview_ruling` checks against a
  // convened meeting's stored request hash. The next meeting's request does
  // not exist yet: `get_request_preview` has "<drawn at convene>" where the
  // seed goes, and `preview_ruling` panics on a meeting that was never
  // convened. So by default the ruling is signed over the latest convened
  // meeting's real request (seed included); `against: "preview"` signs over
  // the preview bytes instead, to show that this cannot verify.
  const against = input.against ?? "meeting";
  let requestSha = m.request_sha256!;
  let requestCheck: Record<string, unknown>;
  if (against === "preview") {
    if (!preview.request) throw new PlaygroundError("the brain is asleep: no request preview", 409);
    requestSha = sha256Hex(preview.request);
    requestCheck = {
      signed_over: "get_request_preview (seed placeholder)",
      preview_meeting: preview.meeting,
      preview_request_sha256: requestSha,
      meeting_request_sha256: m.request_sha256,
    };
  } else {
    const rec = await getMeetingRecord(m.number);
    requestCheck = {
      signed_over: `meeting ${m.number}'s request, seed ${m.seed}`,
      request_bytes_found: !!rec?.request,
      request_hash_matches: rec?.request_hash_matches ?? null,
      next_meeting: preview.meeting,
      why: `the next meeting (${preview.meeting}) has no request yet: its seed is drawn at convene, so the preview carries "${preview.seed_placeholder}" and preview_ruling only accepts convened meetings`,
    };
  }

  let content: string;
  let filled: string[] = [];
  if (typeof input.content === "string") {
    content = input.content;
  } else {
    const r = input.ruling ?? {};
    const lb = m.levers_before;
    const defaults: Record<string, unknown> = {
      tax_bps: lb.tax_bps,
      endowment_share: lb.endowment_share,
      locker_share: lb.locker_share,
      buyback_burn: 0,
      minutes: "The playground chair rules as the visitor wrote.",
      answers: Array.from({ length: m.petitions }, (_, i) => `Answer to petition ${i + 1}.`),
    };
    filled = Object.keys(defaults).filter((k) => !(k in r));
    const ordered: Record<string, unknown> = {};
    for (const k of Object.keys(defaults)) ordered[k] = k in r ? r[k] : defaults[k];
    for (const k of Object.keys(r)) if (!(k in ordered)) ordered[k] = r[k];
    content = JSON.stringify(ordered);
  }

  const responseText = chatCompletion({
    id: `chatcmpl-playground-${randomBytes(6).toString("hex")}`,
    model: m.model!,
    content,
    created: Math.floor(Date.now() / 1000),
    fingerprint: FINGERPRINT,
  });
  const signatureText = providerText(m.model!, requestSha, responseText);
  const submitted = { response_text: responseText, signature_text: signatureText, signature: eip191Sign(key, signatureText) };
  const address = addressOf(key);
  const result = await run(m, submitted);
  return {
    mode: "jailbreak" as const,
    signer: TEST_SIGNER_LABEL,
    signer_address: address,
    signer_in_model_signers: governance.model_signers.includes(address.toLowerCase()),
    target: target(m),
    request: requestCheck,
    filled_defaults: filled,
    content: clip(content),
    submitted: { ...submitted, response_text: clip(submitted.response_text) },
    ...result,
  };
}

// ---------------------------------------------------------------- garbage

export type GarbageVariant = "unsigned" | "not_json" | "prose" | "oversize";

export async function garbage(input: { meeting?: number; variant?: GarbageVariant; text?: string }) {
  const m = await targetMeeting(input.meeting);
  const variant = input.variant ?? "unsigned";
  const key = isTestnet ? env.testModelKey : undefined;
  const signer = key ?? randomKey();
  const sign = (responseText: string) => {
    const text = providerText(m.model!, m.request_sha256!, responseText);
    return { response_text: responseText, signature_text: text, signature: eip191Sign(signer, text) };
  };
  const completion = (content: string) =>
    chatCompletion({ id: "chatcmpl-playground-garbage", model: m.model!, content, created: Math.floor(Date.now() / 1000), fingerprint: FINGERPRINT });

  let submitted: { response_text: string; signature_text: string; signature: string };
  let explain: string;
  switch (variant) {
    case "not_json":
      submitted = sign(input.text ?? "502 Bad Gateway: the chair is out to lunch");
      explain = "Signed correctly, but the response is not a chat completion: check 3 fails.";
      break;
    case "prose":
      submitted = sign(completion(input.text ?? "I think the tax should probably go down a bit, and lockers deserve more. Thank you all."));
      explain = "A signed chat completion whose content holds no ruling object: check 3 fails.";
      break;
    case "oversize":
      submitted = { response_text: "x".repeat(64 * 1024 + 1), signature_text: "oversize", signature: "0x00" };
      explain = "A response_text over 64 KiB is unparseable before it is hashed or parsed, so on_ruling always has the gas to finish.";
      break;
    default:
      submitted = { response_text: input.text ?? completion("{}"), signature_text: "", signature: "" };
      explain = "No signature at all (the courier failed, or returned an error object): unsigned.";
  }
  const result = await run(m, submitted);
  return {
    mode: "garbage" as const,
    variant,
    signer: variant === "not_json" || variant === "prose" ? (key ? TEST_SIGNER_LABEL : "a random key (no test key on this network)") : null,
    target: target(m),
    explain,
    submitted: { ...submitted, response_text: clip(submitted.response_text, 400) },
    fallback_levers: result.preview.levers,
    ...result,
  };
}
