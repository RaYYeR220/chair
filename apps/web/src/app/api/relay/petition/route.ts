import { connection } from "next/server";
import { env } from "@/lib/server/env";
import { CACHE, fail, json, readJson } from "@/lib/server/http";
import { clientIp, Limiter } from "@/lib/server/limit";
import { relayPetition, relayStatus } from "@/lib/server/relay";

export const maxDuration = 60;

const limiter = new Limiter("petition relay", env.relay.ipCooldownS, env.relay.ipDailyMax);

export async function GET() {
  await connection();
  try {
    return json(await relayStatus(), { cache: CACHE.short });
  } catch (e) {
    return fail(e);
  }
}

/** POST `{ text }` (at most 280 characters): filed from a demo petitioner account; the demo account pays gas, CHAIR and the fee. */
export async function POST(req: Request) {
  const ip = clientIp(req);
  const gate = limiter.check(ip);
  if (!gate.ok) return json({ ok: false, error: gate.reason, retry_after_s: gate.retry_after_s }, { status: 429 });
  try {
    const body = await readJson(req, 4096);
    limiter.record(ip);
    return json(await relayPetition(body.text), { cache: CACHE.none });
  } catch (e) {
    return fail(e);
  }
}
