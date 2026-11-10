import { connection } from "next/server";
import { chair } from "@/lib/server/chair";
import { convene, conveneAvailable } from "@/lib/server/convene";
import { dryRunConvene } from "@/lib/server/dryrun";
import { env } from "@/lib/server/env";
import { CACHE, fail, json } from "@/lib/server/http";
import { clientIp, Limiter } from "@/lib/server/limit";
import { finalBlock } from "@/lib/server/rpc";

export const maxDuration = 120;

const limiter = new Limiter("convene", env.conveneIpCooldownS);
/** The dry run sends nothing, so it only needs a short cooldown. */
const dryLimiter = new Limiter("convene (dry run)", 2);

/** Whether the next meeting can be convened now. */
export async function GET() {
  await connection();
  try {
    const [block, status] = await Promise.all([finalBlock("optimistic"), chair.status("optimistic")]);
    const left = (BigInt(status.next_meeting_at) - BigInt(block.timestamp_nanosec)) / 1_000_000_000n;
    return json(
      {
        available: conveneAvailable() || env.dryRun,
        dry_run: env.dryRun,
        next_meeting: status.meeting_count + 1,
        open_meeting: status.open_meeting,
        opens_in_s: left > 0n ? Number(left) : 0,
      },
      { cache: CACHE.live },
    );
  } catch (e) {
    return fail(e);
  }
}

/**
 * Convene the next meeting (the demo account pays the exact OutLayer deposit) and wait for the ruling to land.
 * With `CHAIR_RELAY_DRY_RUN=1` nothing is sent: the answer is marked `dry_run` (see lib/server/dryrun.ts).
 */
export async function POST(req: Request) {
  const ip = clientIp(req);
  if (env.dryRun) {
    const gate = dryLimiter.check(ip);
    if (!gate.ok) return json({ ok: false, dry_run: true, error: gate.reason, retry_after_s: gate.retry_after_s }, { status: 429 });
    dryLimiter.record(ip);
    try {
      return json(await dryRunConvene(), { cache: CACHE.none });
    } catch (e) {
      return fail(e);
    }
  }
  const gate = limiter.check(ip);
  if (!gate.ok) return json({ ok: false, error: gate.reason, retry_after_s: gate.retry_after_s }, { status: 429 });
  try {
    const out = await convene({ waitMs: 90_000 });
    limiter.record(ip);
    return json({ ok: true, ...out }, { cache: CACHE.none });
  } catch (e) {
    return fail(e);
  }
}
