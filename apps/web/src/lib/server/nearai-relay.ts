import "server-only";
import type { Meeting, StatusView } from "@/lib/chair-types";
import { env, rpcFor } from "./env";
import {
  checkGate,
  type GateResult,
  ForwardBudget,
  maskKey,
  MeetingForwarder,
  NEARAI_API_BASE,
  networkOf,
  type OpenMeeting,
  openMeetingFrom,
  type UpstreamReply,
} from "./nearai-gate";
import { view } from "./rpc";

/**
 * The NEAR AI relay for the courier. OutLayer workers can't open a connection
 * to `cloud-api.near.ai`, so the courier build pinned by the token talks to
 * these routes instead, and they talk to NEAR AI with the server's key.
 *
 * The relay is not trusted: the token checks NEAR AI's TEE signature over
 * `sha256(request)` and `sha256(response)` itself, so a relay can't alter or
 * forge a ruling. These rules only keep the key from paying for anything but
 * the open meeting's exact request. Nothing here logs a body or the key.
 */

export class NearaiRelayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterS?: number,
  ) {
    super(message);
  }
}

/** `?token=` must name an allowlisted token contract. */
export function relayToken(url: URL): string {
  const token = url.searchParams.get("token") ?? "";
  if (!env.nearai.tokens.includes(token)) {
    throw new NearaiRelayError(403, "token_not_allowed", "this relay serves only its allowlisted token contracts (?token=)");
  }
  return token;
}

export function apiKey(): string {
  const key = env.nearai.apiKey;
  if (!key) throw new NearaiRelayError(503, "relay_not_configured", "the relay has no NEAR AI API key");
  return key;
}

/** The token's open meeting, read from its own network at optimistic finality. */
async function openMeeting(token: string): Promise<OpenMeeting | null> {
  const network = networkOf(token);
  if (!network) return null;
  const opts = { contract: token, finality: "optimistic" as const, rpcUrl: rpcFor(network), timeoutMs: 8_000 };
  const status = await view<StatusView>("get_status", {}, opts);
  if (status.open_meeting === null) return null;
  const meeting = await view<Meeting | null>("get_meeting", { meeting: status.open_meeting }, opts);
  return openMeetingFrom(status, meeting);
}

/**
 * The gate. Local test mode (`CHAIR_NEARAI_TEST_REQUEST_SHA256`, never on
 * Vercel or in production) swaps the chain read for a pinned hash, as
 * "meeting 0"; the comparison is the same. A miss is read once more after a
 * moment, in case the RPC node is a block behind the `convene`.
 */
export async function gate(token: string, bodySha256: string): Promise<GateResult> {
  const pinned = env.nearai.testRequestSha256;
  if (pinned) return checkGate(bodySha256, { meeting: 0, requestSha256: pinned });
  let result = checkGate(bodySha256, await openMeeting(token));
  if (!result.ok) {
    await new Promise((r) => setTimeout(r, 1_500));
    result = checkGate(bodySha256, await openMeeting(token));
  }
  return result;
}

const forwarder = new MeetingForwarder(new ForwardBudget(env.nearai.maxForwards));

/** The completion for an already gated request: its bytes, unchanged, with the key added. */
export function forwardChat(token: string, meeting: number, body: Uint8Array) {
  const key = apiKey();
  return forwarder.forward(token, meeting, () =>
    upstream(`${NEARAI_API_BASE}/v1/chat/completions`, key, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: body.slice(),
      timeoutMs: 110_000,
    }),
  );
}

export function forwardSignature(url: string): Promise<UpstreamReply> {
  return upstream(url, apiKey(), { method: "GET", headers: { accept: "application/json" }, timeoutMs: 20_000 });
}

async function upstream(
  url: string,
  key: string,
  init: { method: "GET" | "POST"; headers: Record<string, string>; body?: Uint8Array<ArrayBuffer>; timeoutMs: number },
): Promise<UpstreamReply> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method,
      headers: { ...init.headers, authorization: `Bearer ${key}` },
      body: init.body,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(init.timeoutMs),
    });
  } catch (e) {
    const name = (e as Error)?.name === "TimeoutError" ? "timed out" : "unreachable";
    throw new NearaiRelayError(502, "upstream_transport", `NEAR AI Cloud ${name}`);
  }
  const body = maskKey(new Uint8Array(await res.arrayBuffer()), key);
  return { status: res.status, body, contentType: res.headers.get("content-type") };
}

/** The upstream answer as the courier gets it: status and body bytes unchanged, never cached. */
export function passthrough(reply: UpstreamReply, extra: Record<string, string> = {}) {
  return new Response(reply.body.slice(), {
    status: reply.status,
    headers: { "content-type": reply.contentType ?? "application/json", "cache-control": "no-store", ...extra },
  });
}

export function relayError(status: number, code: string, message: string, retryAfterS?: number) {
  const headers: Record<string, string> = { "cache-control": "no-store" };
  if (retryAfterS) headers["retry-after"] = String(retryAfterS);
  return Response.json({ error: { code, message } }, { status, headers });
}

/** Known failures keep their status; anything else (an RPC error) is a bare 502 that echoes nothing. */
export function relayFail(e: unknown, what: string) {
  if (e instanceof NearaiRelayError) return relayError(e.status, e.code, e.message, e.retryAfterS);
  return relayError(502, "relay_error", `the relay could not ${what}`);
}
