import { connection } from "next/server";
import { chair } from "@/lib/server/chair";
import { convene, conveneAvailable } from "@/lib/server/convene";
import { env } from "@/lib/server/env";
import { CACHE, fail, json } from "@/lib/server/http";
import { clientIp, Limiter } from "@/lib/server/limit";
import { finalBlock } from "@/lib/server/rpc";

export const maxDuration = 120;

const limiter = new Limiter("convene", env.conveneIpCooldownS);

/** Whether the next meeting can be convened now. */
export async function GET() {
  await connection();
  try {
    const [block, status] = await Promise.all([finalBlock("optimistic"), chair.status("optimistic")]);
    const left = (BigInt(status.next_meeting_at) - BigInt(block.timestamp_nanosec)) / 1_000_000_000n;
    return json(
      {
        available: conveneAvailable(),
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

/** Convene the next meeting (the demo account pays the exact OutLayer deposit) and wait for the ruling to land. */
export async function POST(req: Request) {
  const ip = clientIp(req);
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
