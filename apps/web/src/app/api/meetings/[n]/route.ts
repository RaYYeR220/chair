import { getMeetingRecord, isCachedFinal } from "@/lib/server/history";
import { CACHE, fail, json } from "@/lib/server/http";

export const maxDuration = 30;

/**
 * One meeting, rebuilt from its transactions: brief and seed, request hash,
 * courier result, signature check, asked vs applied levers and clamps,
 * minutes, answers, buyback, rewards, tx hashes.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ n: string }> }) {
  const { n: raw } = await ctx.params;
  if (!/^\d{1,9}$/.test(raw) || Number(raw) < 1) {
    return json({ ok: false, error: "meeting must be a positive integer" }, { status: 400 });
  }
  const n = Number(raw);
  try {
    const record = await getMeetingRecord(n);
    if (!record) return json({ ok: false, error: `meeting ${n} does not exist` }, { status: 404, cache: CACHE.short });
    return json(record, { cache: isCachedFinal(n) ? CACHE.forever : CACHE.none });
  } catch (e) {
    return fail(e);
  }
}
