import { CACHE, fail, json, readJson } from "@/lib/server/http";
import { clientIp, Limiter } from "@/lib/server/limit";
import { type ForgeVariant, forge, type GarbageVariant, garbage, jailbreak, PlaygroundError } from "@/lib/server/playground";

export const maxDuration = 30;

const limiter = new Limiter("preview", 2);

const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined);
const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/**
 * "Try to fool it". POST `{ mode, ...payload }`:
 * - `forge`: `{ meeting?, variant?: random_key | rehash | tamper | genuine, edit? }`
 * - `jailbreak`: `{ meeting?, ruling?: { tax_bps, endowment_share, locker_share, buyback_burn, minutes, answers }, content?, against?: meeting | preview }`
 * - `garbage`: `{ meeting?, variant?: unsigned | not_json | prose | oversize, text? }`
 *
 * Runs the token's `preview_ruling` view; nothing goes on chain.
 */
export async function POST(req: Request) {
  const ip = clientIp(req);
  const gate = limiter.check(ip);
  if (!gate.ok) return json({ ok: false, error: gate.reason, retry_after_s: gate.retry_after_s }, { status: 429 });
  limiter.record(ip);
  try {
    const body = await readJson(req);
    const meeting = int(body.meeting);
    let out: unknown;
    switch (body.mode) {
      case "forge":
        out = await forge({ meeting, variant: str(body.variant) as ForgeVariant | undefined, edit: obj(body.edit) });
        break;
      case "jailbreak":
        out = await jailbreak({
          meeting,
          ruling: obj(body.ruling),
          content: str(body.content),
          against: body.against === "preview" ? "preview" : "meeting",
        });
        break;
      case "garbage":
        out = await garbage({ meeting, variant: str(body.variant) as GarbageVariant | undefined, text: str(body.text) });
        break;
      default:
        throw new PlaygroundError("mode must be forge, jailbreak or garbage");
    }
    return json(out, { cache: CACHE.none });
  } catch (e) {
    return fail(e);
  }
}
