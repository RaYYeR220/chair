import sim from "@results/sim-v3-2026-11-10.json";

/**
 * The committed 60-day simulation (results/sim-v3-2026-11-10.json, see
 * docs/SIMULATION.md), without the per-day runs: metadata, scenarios,
 * policies, aggregates, headline numbers, pre-registered verdicts and the
 * seed probe. Static: prerendered at build time.
 */
const OMITTED = ["runs", "extraRuns", "extraBaselineRuns"] as const;

export async function GET() {
  const full = sim as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(full)) if (!(OMITTED as readonly string[]).includes(k)) summary[k] = v;
  return Response.json(
    {
      source: "results/sim-v3-2026-11-10.json",
      omitted: OMITTED.map((k) => ({ key: k, entries: Array.isArray(full[k]) ? (full[k] as unknown[]).length : null })),
      ...summary,
    },
    { headers: { "cache-control": "public, max-age=3600, s-maxage=86400" } },
  );
}
