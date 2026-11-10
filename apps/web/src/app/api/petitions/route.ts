import { connection } from "next/server";
import { chair, parseBrief, tokens } from "@/lib/server/chair";
import { CACHE, fail, json } from "@/lib/server/http";
import { relayStatus } from "@/lib/server/relay";

/**
 * The petition queue for the next meeting (weights at filing), and the brief
 * the contract would build now (weights recomputed, the three heaviest).
 */
export async function GET() {
  await connection();
  try {
    const [queue, preview, relay] = await Promise.all([chair.petitions(), chair.requestPreview(), relayStatus()]);
    const brief = parseBrief(preview.request)?.brief as { petitions?: { from: string; weight: string; text: string }[] } | null;
    return json(
      {
        meeting: preview.meeting,
        queue: queue.map((p) => ({ ...p, weight_chair_days: tokens(p.weight) })),
        max_queue: 8,
        would_brief: brief?.petitions ?? [],
        relay,
      },
      { cache: CACHE.live },
    );
  } catch (e) {
    return fail(e);
  }
}
