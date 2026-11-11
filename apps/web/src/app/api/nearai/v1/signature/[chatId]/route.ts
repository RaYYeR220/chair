import { connection } from "next/server";
import { clientIp } from "@/lib/server/limit";
import { checkSignatureQuery, NEARAI_API_BASE, signatureUrl, WindowLimiter } from "@/lib/server/nearai-gate";
import { apiKey, forwardSignature, passthrough, relayError, relayFail, relayToken } from "@/lib/server/nearai-relay";

export const maxDuration = 30;

/** The courier makes at most 10 lookups per meeting, spaced out over ~17 s. */
const perIp = new WindowLimiter(30, 60_000);
const perToken = new WindowLimiter(120, 60_000);

/**
 * `GET /api/nearai/v1/signature/{chatId}?model=…&signing_algo=ecdsa&token=<token contract>`:
 * the courier's signature lookup, relayed to NEAR AI Cloud with the API key.
 * Allowlisted tokens only, rate limited; status and body come back unchanged.
 */
export async function GET(req: Request, ctx: { params: Promise<{ chatId: string }> }) {
  await connection();
  try {
    const url = new URL(req.url);
    const token = relayToken(url);
    apiKey();
    const { chatId } = await ctx.params;
    const q = checkSignatureQuery(chatId, url.searchParams.get("model"), url.searchParams.get("signing_algo"));
    if (!q.ok) return relayError(400, "bad_request", q.message);
    for (const [limiter, key] of [
      [perIp, clientIp(req)],
      [perToken, token],
    ] as const) {
      const rl = limiter.take(key);
      if (!rl.ok) return relayError(429, "rate_limited", "too many signature lookups", rl.retryAfterS);
    }
    return passthrough(await forwardSignature(signatureUrl(NEARAI_API_BASE, q)));
  } catch (e) {
    return relayFail(e, "reach NEAR AI Cloud");
  }
}
