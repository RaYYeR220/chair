/**
 * The NEAR AI relay's rules, as pure functions: which tokens it serves, which
 * request it forwards, how often. No I/O and no `server-only` import, so the
 * unit tests (`test/nearai-gate.test.ts`) run them under plain Node; the
 * route handlers wire them to RPC and `fetch` in `nearai-relay.ts`.
 *
 * Why a relay exists and what it can and can't do: `docs/SECURITY.md`, "Relay".
 */
import { createHash } from "node:crypto";

export const NEARAI_API_BASE = "https://cloud-api.near.ai";
/** The token builds a request of about 4 KB; the courier refuses anything over 64 KiB. */
export const MAX_REQUEST_BYTES = 64 * 1024;

export type Network = "testnet" | "mainnet";

export const DEFAULT_RELAY_TOKENS: Record<Network, string> = {
  testnet: "token5.chair-dev.testnet",
  mainnet: "token.thechair.near",
};

/** A token's network, from its account suffix. */
export function networkOf(account: string): Network | null {
  if (account.endsWith(".testnet")) return "testnet";
  if (account.endsWith(".near")) return "mainnet";
  return null;
}

const ACCOUNT_RE = /^(?=.{2,64}$)([a-z\d]+[-_])*[a-z\d]+(\.([a-z\d]+[-_])*[a-z\d]+)*$/;

/**
 * `CHAIR_RELAY_TOKENS`: comma-separated token accounts, each `.testnet` or
 * `.near`. Empty or unset: the default token for the site's network.
 */
export function parseRelayTokens(raw: string | undefined, network: Network): string[] {
  const list = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length === 0) return [DEFAULT_RELAY_TOKENS[network]];
  for (const t of list) {
    if (!ACCOUNT_RE.test(t)) throw new Error(`CHAIR_RELAY_TOKENS: ${JSON.stringify(t)} is not a NEAR account id`);
    if (!networkOf(t)) throw new Error(`CHAIR_RELAY_TOKENS: ${t} is neither .testnet nor .near`);
  }
  return [...new Set(list)];
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------- the gate

/** The two views the gate reads, as the token returns them (`get_status`, `get_meeting`). */
export interface StatusLike {
  open_meeting: number | null;
}
export interface MeetingLike {
  number: number;
  status: string;
  request_sha256: string | null;
}

export interface OpenMeeting {
  meeting: number;
  requestSha256: string;
}

/**
 * The token's open meeting: `get_status().open_meeting` names it, and its
 * record is still `requested` with a request hash. `convene` sets both;
 * `on_ruling` (or the next `convene`, as a lapse) closes it. Anything else is
 * "no open meeting".
 */
export function openMeetingFrom(status: StatusLike | null, meeting: MeetingLike | null): OpenMeeting | null {
  const n = status?.open_meeting;
  if (typeof n !== "number" || !meeting || meeting.number !== n) return null;
  if (meeting.status !== "requested") return null;
  const h = meeting.request_sha256;
  if (typeof h !== "string" || !/^[0-9a-f]{64}$/.test(h)) return null;
  return { meeting: n, requestSha256: h };
}

export type GateResult =
  | { ok: true; meeting: number }
  | { ok: false; status: 403; code: "no_open_meeting" | "not_the_meeting_request"; message: string };

/** The body may go upstream only if its sha256 is the open meeting's `request_sha256`. */
export function checkGate(bodySha256: string, open: OpenMeeting | null): GateResult {
  if (!open) {
    return { ok: false, status: 403, code: "no_open_meeting", message: "the token has no open meeting, so there is nothing to forward" };
  }
  if (bodySha256 !== open.requestSha256) {
    return {
      ok: false,
      status: 403,
      code: "not_the_meeting_request",
      message: `the body is not meeting ${open.meeting}'s request (sha256 mismatch); only the exact request bytes are forwarded`,
    };
  }
  return { ok: true, meeting: open.meeting };
}

// ---------------------------------------------------------------- spend and rate caps

/**
 * At most `max` upstream completions per (token, meeting), per server
 * instance: instances share nothing, so N instances could each spend `max`.
 */
export class ForwardBudget {
  private used = new Map<string, number>();
  constructor(readonly max: number) {}

  private static key(token: string, meeting: number) {
    return `${token}#${meeting}`;
  }

  /** Spends one forward if any is left. */
  take(token: string, meeting: number): boolean {
    const k = ForwardBudget.key(token, meeting);
    const n = this.used.get(k) ?? 0;
    if (n >= this.max) return false;
    this.used.set(k, n + 1);
    if (this.used.size > 256) this.used.delete(this.used.keys().next().value as string);
    return true;
  }

  spent(token: string, meeting: number): number {
    return this.used.get(ForwardBudget.key(token, meeting)) ?? 0;
  }
}

export interface UpstreamReply {
  status: number;
  body: Uint8Array;
  contentType: string | null;
}

export type Forwarded =
  | { ok: true; reply: UpstreamReply; how: "forwarded" | "joined" | "replayed" }
  | { ok: false; code: "forward_cap"; message: string };

/**
 * One meeting's completion, fetched at most `budget.max` times per instance.
 * A 200 is kept and replayed to any later caller with the same (gated)
 * request, and a caller that arrives while a fetch is running waits for it.
 * So anyone who copies the request from the `meeting_convened` event and
 * sends it first neither spends the budget nor locks the courier out: the
 * courier gets the same signed completion.
 */
export class MeetingForwarder {
  private done = new Map<string, UpstreamReply>();
  private inflight = new Map<string, Promise<UpstreamReply>>();
  constructor(readonly budget: ForwardBudget) {}

  async forward(token: string, meeting: number, send: () => Promise<UpstreamReply>): Promise<Forwarded> {
    const k = `${token}#${meeting}`;
    const kept = this.done.get(k);
    if (kept) return { ok: true, reply: kept, how: "replayed" };
    const running = this.inflight.get(k);
    if (running) return { ok: true, reply: await running, how: "joined" };
    if (!this.budget.take(token, meeting)) {
      return {
        ok: false,
        code: "forward_cap",
        message: `meeting ${meeting} already used its ${this.budget.max} upstream calls on this relay instance`,
      };
    }
    const p = send();
    this.inflight.set(k, p);
    try {
      const reply = await p;
      if (reply.status === 200) {
        this.done.set(k, reply);
        if (this.done.size > 16) this.done.delete(this.done.keys().next().value as string);
      }
      return { ok: true, reply, how: "forwarded" };
    } finally {
      this.inflight.delete(k);
    }
  }
}

/** A sliding-window counter: at most `max` events per `windowMs` per key. In memory, per instance. */
export class WindowLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    readonly max: number,
    readonly windowMs: number,
  ) {}

  take(key: string, now = Date.now()): { ok: true } | { ok: false; retryAfterS: number } {
    const recent = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return { ok: false, retryAfterS: Math.max(1, Math.ceil((recent[0] + this.windowMs - now) / 1000)) };
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) if (!v.some((t) => t > now - this.windowMs)) this.hits.delete(k);
    }
    return { ok: true };
  }
}

// ---------------------------------------------------------------- signature lookups

export type SignatureQuery = { ok: true; chatId: string; model: string } | { ok: false; message: string };

/**
 * `GET /v1/signature/{chatId}?model=…&signing_algo=ecdsa`: the courier's
 * lookup, and nothing else. NEAR AI chat ids are short tokens like
 * `chatcmpl-…` or a hex uuid; models are `org/name` ids.
 */
export function checkSignatureQuery(chatId: string, model: string | null, signingAlgo: string | null): SignatureQuery {
  if (!/^[A-Za-z0-9._:~-]{1,255}$/.test(chatId)) return { ok: false, message: "bad chat id" };
  if (!model || !/^[A-Za-z0-9._:/-]{1,128}$/.test(model)) return { ok: false, message: "bad or missing model" };
  if (signingAlgo !== "ecdsa") return { ok: false, message: "signing_algo must be ecdsa" };
  return { ok: true, chatId, model };
}

export function signatureUrl(base: string, q: { chatId: string; model: string }): string {
  return `${base}/v1/signature/${encodeURIComponent(q.chatId)}?model=${encodeURIComponent(q.model)}&signing_algo=ecdsa`;
}

// ---------------------------------------------------------------- upstream bodies

/**
 * The upstream body as the courier gets it: byte for byte, unless it carries
 * the relay's own API key (an error that echoes the Authorization header).
 * Then every copy of the key is masked, so it can never reach the courier's
 * output, which lands on chain. A real completion or receipt never contains
 * the key, so for them this is the identity.
 */
export function maskKey(body: Uint8Array, key: string): Uint8Array {
  if (!key) return body;
  const needle = Buffer.from(key, "utf8");
  const buf = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (buf.indexOf(needle) < 0) return body;
  const mask = Buffer.from("[redacted]", "utf8");
  const parts: Buffer[] = [];
  let from = 0;
  for (let i = buf.indexOf(needle); i >= 0; i = buf.indexOf(needle, from)) {
    parts.push(buf.subarray(from, i), mask);
    from = i + needle.length;
  }
  parts.push(buf.subarray(from));
  return new Uint8Array(Buffer.concat(parts));
}
