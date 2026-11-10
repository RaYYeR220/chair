import { connection } from "next/server";
import { env } from "@/lib/server/env";
import { CACHE, fail, json, readJson } from "@/lib/server/http";
import { clientIp, Limiter } from "@/lib/server/limit";
import { dryRunPetition } from "@/lib/server/dryrun";
import { relayPetition, relayStatus } from "@/lib/server/relay";

export const maxDuration = 60;

const limiter = new Limiter("petition relay", env.relay.ipCooldownS, env.relay.ipDailyMax);
/** The dry run sends nothing, so it only needs a short cooldown. */
const dryLimiter = new Limiter("petition relay (dry run)", 2);

export async function GET() {
  await connection();
  try {
    return json(await relayStatus(), { cache: CACHE.short });
  } catch (e) {
    return fail(e);
  }
}

/**
 * POST `{ text }` (at most 280 characters): filed from a demo petitioner account; the demo account pays gas, CHAIR and the fee.
 * With `CHAIR_RELAY_DRY_RUN=1` nothing is sent: the answer is marked `dry_run` (see lib/server/dryrun.ts).
 */
export async function POST(req: Request) {
  const ip = clientIp(req);
  if (env.dryRun) {
    const gate = dryLimiter.check(ip);
    if (!gate.ok) return json({ ok: false, dry_run: true, error: gate.reason, retry_after_s: gate.retry_after_s }, { status: 429 });
    try {
      const body = await readJson(req, 4096);
      dryLimiter.record(ip);
      return json(await dryRunPetition(body.text), { cache: CACHE.none });
    } catch (e) {
      return fail(e);
    }
  }
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
