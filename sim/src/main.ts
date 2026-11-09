// sim/run entry point.
//   sim/run                 baselines over N seeds + LLM chair replayed from the cache (no network)
//   sim/run --live          same, but cache misses call Venice (needs VENICE_API_KEY)
//   sim/run --no-llm        baselines only
//   sim/run --seeds 20 --date 2026-11-10
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CFG, REPO_DIR, SIM_DIR } from "./config.ts";
import { SCENARIOS, DAYS } from "./scenarios.ts";
import { runSim, type RunResult, type Summary, VOL_FROM } from "./engine.ts";
import { nonePolicy, fixedPolicy, controllerPolicy, llmPolicy } from "./policies.ts";
import { LlmClient } from "./llm.ts";
import { SYSTEM_PROMPT } from "./prompt.ts";
import { renderReport } from "./report.ts";
import { smoothControllerPolicy } from "./posthoc.ts";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string, d: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

const SEEDS = Number(opt("seeds", "20"));
const LLM_SEED = 1;
const DATE = opt("date", new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10));
const OUT = join(REPO_DIR, "results");
const live = flag("live");
const withLlm = !flag("no-llm");

const log = (s: string) => process.stderr.write(s + "\n");

/** Hash of the model source + config: the LLM cache is only valid for this exact model. */
export const MODEL_FILES = ["chair.config.json", "src/config.ts", "src/rng.ts", "src/token.ts", "src/agents.ts", "src/scenarios.ts", "src/engine.ts", "src/policies.ts", "src/prompt.ts", "src/llm.ts"];
function modelHash(): string {
  const h = createHash("sha256");
  const CRLF = String.fromCharCode(13, 10), LF = String.fromCharCode(10);
  for (const f of MODEL_FILES) h.update(f).update(readFileSync(join(SIM_DIR, f), "utf8").split(CRLF).join(LF));
  return h.digest("hex");
}

type Agg = Record<string, { mean: number; sd: number; p10: number; p90: number; n: number }>;
function aggregate(sums: Summary[]): Agg {
  const out: Agg = {};
  const keys = Object.keys(sums[0]).filter((k) => typeof (sums[0] as any)[k] === "number");
  for (const k of keys) {
    const xs = sums.map((s) => (s as any)[k] as number).sort((a, b) => a - b);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, xs.length - 1));
    const q = (p: number) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))];
    out[k] = { mean, sd, p10: q(0.1), p90: q(0.9), n: xs.length };
  }
  return out;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const baselines = [nonePolicy, fixedPolicy, controllerPolicy, smoothControllerPolicy];
  const runs: RunResult[] = []; // full series: seed LLM_SEED, all policies
  const summaries: Record<string, Record<string, Summary[]>> = {};

  for (const scn of SCENARIOS) {
    summaries[scn.key] = {};
    for (const mk of baselines) {
      const list: Summary[] = [];
      for (let seed = 1; seed <= SEEDS; seed++) {
        const r = await runSim(scn, mk(), seed);
        list.push(r.summary);
        if (seed === LLM_SEED) runs.push(stripMeetings(r));
      }
      summaries[scn.key][mk().key] = list;
    }
    log(`baselines done: ${scn.key}`);
  }

  let llmStats = null as null | LlmClient["stats"];
  if (withLlm) {
    const client = new LlmClient({ offline: !live, maxCalls: CFG.venice.max_calls_per_run, retryErrors: flag("retry-errors"), log });
    const llmRuns = await Promise.all(SCENARIOS.map(async (scn) => {
      const r = await runSim(scn, llmPolicy(client), LLM_SEED, { keepBriefs: true });
      log(`llm done: ${scn.key} (api ${r.llm?.calls}, cached ${r.llm?.cached}, fallbacks ${r.summary.fallbacks})`);
      return r;
    }));
    runs.push(...llmRuns);
    llmStats = client.stats;
    const missing = llmRuns.reduce((s, r) => s + r.meetings.filter((m) => m.fallback === "unsigned").length, 0);
    if (missing && !live) log(`WARNING: ${missing} LLM meetings had no cached response (ran the fallback). Re-run with --live to fill the cache.`);
  }

  const aggregates: Record<string, Record<string, Agg>> = {};
  for (const scn of SCENARIOS) {
    aggregates[scn.key] = {};
    for (const [p, list] of Object.entries(summaries[scn.key])) aggregates[scn.key][p] = aggregate(list);
  }

  // Noise yardstick for single-seed comparisons: across seeds, how much does the paired
  // difference between two deterministic policies (controller − fixed) move? A seed-1 gap
  // between the LLM and the controller smaller than this sd is within seed noise.
  const pairedNoise: Record<string, Record<string, number>> = {};
  for (const scn of SCENARIOS) {
    const c = summaries[scn.key].controller, f = summaries[scn.key].fixed;
    pairedNoise[scn.key] = {};
    for (const k of Object.keys(c[0]).filter((k) => typeof (c[0] as any)[k] === "number")) {
      const d = c.map((s, i) => (s as any)[k] - (f[i] as any)[k]);
      const m = d.reduce((a, b) => a + b, 0) / d.length;
      pairedNoise[scn.key][k] = Math.sqrt(d.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, d.length - 1));
    }
  }

  const preregPath = join(REPO_DIR, "results", "preregistration.json");
  const prereg = existsSync(preregPath) ? JSON.parse(readFileSync(preregPath, "utf8")) : null;

  // Head-to-head on seed 1: LLM chair vs the pre-registered controller, with the noise yardstick.
  const HEAD: [string, "hi" | "lo"][] = [["finalFloor", "hi"], ["finalPrice", "hi"], ["maxDrawdownPct", "lo"], ["volatilityPct", "lo"], ["finalEndowment", "hi"], ["whaleShareOfGainsPct", "lo"], ["holderPnl", "hi"], ["totalVolume", "hi"]];
  const headline: Record<string, Record<string, any>> = {};
  const seed1 = (scn: string, p: string) => runs.find((r) => r.scenario === scn && r.policy === p)?.summary as any;
  let verdicts: any = null;
  if (runs.some((r) => r.policy === "llm")) {
    for (const scn of SCENARIOS) {
      headline[scn.key] = {};
      for (const [k, dir] of HEAD) {
        const L = seed1(scn.key, "llm")[k], C = seed1(scn.key, "controller")[k];
        const noise = pairedNoise[scn.key][k];
        const diff = L - C;
        const llmBetter = dir === "hi" ? diff > 0 : diff < 0;
        headline[scn.key][k] = {
          dir, llm: L, controller: C, controller_smooth: seed1(scn.key, "controller_smooth")[k], fixed: seed1(scn.key, "fixed")[k], none: seed1(scn.key, "none")[k],
          diff, noise, winner: diff === 0 ? "tie" : llmBetter ? "llm" : "controller", beyondNoise: Math.abs(diff) > noise,
        };
      }
    }
    const h = (s: string, k: string) => headline[s][k];
    const endowWins = SCENARIOS.filter((s) => h(s.key, "finalEndowment").winner === "llm" && h(s.key, "finalEndowment").beyondNoise).map((s) => s.key);
    verdicts = {
      H1_endowment: { rule: "LLM > controller in >= 4 of 5 scenarios, beyond noise", scenariosWon: endowWins, pass: endowWins.length >= 4 },
      H2_whale_share: { rule: "whale-capture scenario: whale share of gains LLM < controller", ...h("whale", "whaleShareOfGainsPct"), pass: h("whale", "whaleShareOfGainsPct").winner === "llm" },
      H3_bankrun_drawdown: { rule: "bank-run scenario: max drawdown LLM < controller", ...h("bankrun", "maxDrawdownPct"), pass: h("bankrun", "maxDrawdownPct").winner === "llm" },
    };
  }

  const result = {
    meta: {
      date: DATE,
      days: DAYS,
      baselineSeeds: SEEDS,
      llmSeed: LLM_SEED,
      volatilityFromDay: VOL_FROM,
      modelSha256: modelHash(),
      systemPromptSha256: createHash("sha256").update(SYSTEM_PROMPT).digest("hex"),
      newArgs: CFG.rawNewArgs,
      assumptions: CFG.assumptions,
      venice: { base_url: CFG.venice.base_url, model_map: CFG.venice.model_map },
      preregistration: prereg,
    },
    scenarios: SCENARIOS.map((s) => ({ key: s.key, name: s.name, blurb: s.blurb })),
    policies: [
      { key: "none", name: "None (levers frozen at launch)" },
      { key: "fixed", name: "Fixed rule (SPEC fallback)" },
      { key: "controller", name: "PID controller" },
      { key: "llm", name: "LLM chair" },
      { key: "controller_smooth", name: "PID controller, smoothed (post-hoc sensitivity, not pre-registered)" },
    ],
    systemPrompt: SYSTEM_PROMPT,
    llm: llmStats,
    runs,
    aggregates,
    pairedNoise,
    headline,
    verdicts,
  };
  const jsonPath = join(OUT, `sim-${DATE}.json`);
  writeFileSync(jsonPath, JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? v.toString() : typeof v === "number" && !Number.isInteger(v) ? Number(v.toPrecision(8)) : v)));
  const htmlPath = join(OUT, `sim-${DATE}.html`);
  writeFileSync(htmlPath, renderReport(JSON.parse(readFileSync(jsonPath, "utf8"))));
  log(`wrote ${jsonPath}`);
  log(`wrote ${htmlPath}`);
  if (llmStats) log(`llm: ${llmStats.calls} api calls, ${llmStats.cacheHits} cache hits, ${llmStats.errors} errors, ${llmStats.promptTokens} in / ${llmStats.completionTokens} out tokens, $${llmStats.usd.toFixed(4)}`);
}

/** Baseline runs keep only clamp/fallback meeting info (no briefs) to keep the JSON small. */
function stripMeetings(r: RunResult): RunResult {
  return { ...r, meetings: r.meetings.map((m) => ({ day: m.day, meeting: m.meeting, tier: m.tier, fallback: m.fallback, requested: m.requested, applied: m.applied, clamps: m.clamps })) };
}

main().catch((e) => { console.error(e); process.exit(1); });
