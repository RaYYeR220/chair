import { clientIp } from "@/lib/server/limit";
import { MAX_REQUEST_BYTES, sha256Hex, WindowLimiter } from "@/lib/server/nearai-gate";
import { apiKey, forwardChat, gate, passthrough, relayError, relayFail, relayToken } from "@/lib/server/nearai-relay";

/** A completion can take a while; the courier waits up to 90 s for the first byte. */
export const maxDuration = 120;

/** Gate checks cost two RPC views each; the courier itself sends one request per meeting. */
const perIp = new WindowLimiter(20, 60_000);

/**
 * `POST /api/nearai/v1/chat/completions?token=<token contract>`: the courier's
 * completion call, relayed to NEAR AI Cloud. The body goes upstream only if it
 * is, byte for byte, the request of the token's open meeting (its sha256 is
 * the meeting's `request_sha256`); otherwise 403 and nothing is sent. The
 * relay adds the API key, and returns NEAR AI's status and body unchanged.
 * Rules and caps: `lib/server/nearai-gate.ts`; why: `docs/SECURITY.md`, "Relay".
 */
export async function POST(req: Request) {
  try {
    const token = relayToken(new URL(req.url));
    apiKey();
    const rl = perIp.take(clientIp(req));
    if (!rl.ok) return relayError(429, "rate_limited", "too many relay calls from this address", rl.retryAfterS);
    if (Number(req.headers.get("content-length") ?? 0) > MAX_REQUEST_BYTES) {
      return relayError(413, "request_too_large", `the request is over ${MAX_REQUEST_BYTES} bytes`);
    }
    const body = new Uint8Array(await req.arrayBuffer());
    if (body.byteLength === 0 || body.byteLength > MAX_REQUEST_BYTES) {
      return relayError(body.byteLength === 0 ? 400 : 413, "bad_request_size", `the request must be 1 to ${MAX_REQUEST_BYTES} bytes`);
    }

    const g = await gate(token, sha256Hex(body));
    if (!g.ok) return relayError(g.status, g.code, g.message);

    const f = await forwardChat(token, g.meeting, body);
    if (!f.ok) return relayError(429, f.code, f.message);
    // Metadata only: never a body or the key.
    console.info(`nearai relay: ${token} meeting ${g.meeting}: ${f.how}, upstream ${f.reply.status}`);
    return passthrough(f.reply, { "x-chair-relay": f.how });
  } catch (e) {
    return relayFail(e, "check the token's open meeting");
  }
}
