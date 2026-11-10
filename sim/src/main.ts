// sim/run entry point.
//   sim/run                 baselines over N seeds + LLM chair replayed from the cache (no network)
//   sim/run --live          same, but cache misses call Venice (needs VENICE_API_KEY)
//   sim/run --no-llm        baselines only
//   sim/run --seeds 20 --date 2026-11-10
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CFG, REPO_DIR, SIM_DIR, withLockerMax } from "./config.ts";
import { SCENARIOS, DAYS, type Scenario } from "./scenarios.ts";
import { runSim, type RunResult, type Summary, VOL_FROM } from "./engine.ts";
import { nonePolicy, fixedPolicy, controllerPolicy, llmPolicy, type Policy } from "./policies.ts";
import { LlmClient } from "./llm.ts";
import { SYSTEM_PROMPT, systemPromptFor } from "./prompt.ts";
import { renderReport } from "./report.ts";
import { smoothControllerPolicy } from "./posthoc.ts";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string, d: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

// --params launch: the mainnet `new` args from docs/LAUNCH.md (curve, petition fee, launch levers)
// instead of chair.config.json's. The committed LLM cache was built on the config's args, so with
// launch params the LLM chair only runs with --live.
const PARAMS = opt("params", "config");
if (PARAMS === "launch") {
  const md = readFileSync(join(REPO_DIR, "docs", "LAUNCH.md"), "utf8");
  const block = md.slice(md.indexOf("## Mainnet")).match(/```json\n([\s\S]*?)\n```/);
  if (!block) throw new Error("no mainnet JSON block in docs/LAUNCH.md");
  const a = JSON.parse(block[1]);
  Object.assign(CFG, { p0: BigInt(a.curve.p0), k: BigInt(a.curve.k), petitionFee: BigInt(a.petition_fee), launch: a.levers ?? CFG.rawConstitution.default_levers, rawNewArgs: { curve: a.curve, ladder: a.ladder, meeting_interval_s: a.meeting_interval_s, petition_fee: a.petition_fee, levers: a.levers }, source: "docs/LAUNCH.md, mainnet `new` args (--params launch)" });
  CFG.ladder = a.ladder.map((t: any) => ({ min: BigInt(t.min_endowment), model: t.model }));
} else if (PARAMS !== "config") throw new Error(`--params config|launch, not ${PARAMS}`);

const SEEDS = Number(opt("seeds", "20"));
const LLM_SEED = 1;
const DATE = opt("date", new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10));
const TAG = opt("tag", PARAMS === "launch" ? "v2-launch-params" : "v2");
const V1_RESULTS = opt("v1", "sim-2026-11-10.json");
const OUT = join(REPO_DIR, "results");
const live = flag("live");
const withLlm = !flag("no-llm") && (PARAMS === "config" || live);
const MAX_CALLS = Number(opt("max-calls", String(CFG.venice.max_calls_per_run)));

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

/** Extra LLM runs, in priority order, each run only if the call budget can finish it. */
interface Extra { scenario: string; seed: number; key: string; name: string; lockerMax: number; why: string }
const EXTRAS: Extra[] = [
  { scenario: "whale", seed: 1, key: "llm_b50", name: "LLM chair, v1 bound (locker_share 0-50)", lockerMax: 50, why: "control: same seed, parameters and request format, only the locker_share ceiling at the v1 value" },
  { scenario: "whale", seed: 2, key: "llm", name: "LLM chair", lockerMax: CFG.locker.max, why: "extra seed" },
  { scenario: "bankrun", seed: 2, key: "llm", name: "LLM chair", lockerMax: CFG.locker.max, why: "extra seed" },
  { scenario: "whale", seed: 3, key: "llm", name: "LLM chair", lockerMax: CFG.locker.max, why: "extra seed" },
  { scenario: "bankrun", seed: 3, key: "llm", name: "LLM chair", lockerMax: CFG.locker.max, why: "extra seed" },
];

/** v1 metrics recomputed from the v1 results file, including the whale's take of all tax. */
function loadV1() {
  const p = join(OUT, V1_RESULTS);
  if (!existsSync(p)) return null;
  const V = JSON.parse(readFileSync(p, "utf8"));
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const rows: Record<string, Record<string, any>> = {};
  for (const r of V.runs) {
    const s = r.summary, S = r.series;
    const tax = S.endowment.at(-1) + sum(S.rewards) + S.lockerPool.at(-1) + sum(S.buybackNear) + S.buybackFund.at(-1);
    const whaleRewards = (s.whaleShareOfRewardsPct * s.lockerRewards) / 100;
    (rows[r.scenario] ??= {})[r.policy] = {
      ...s, taxCollected: tax, whaleRewards, whaleTakePct: (100 * whaleRewards) / tax,
      lockerShareMean: sum(S.lockerShare) / S.lockerShare.length, lockerShareMeanD3to32: sum(S.lockerShare.slice(3, 33)) / 30,
      endowShareMean: sum(S.endowShare) / S.endowShare.length, taxMean: sum(S.tax) / S.tax.length,
      lockerAtMaxMeetings: S.lockerShare.filter((x: number) => x === 50).length,
    };
  }
  return { file: `results/${V1_RESULTS}`, modelSha256: V.meta.modelSha256, rows, llm: V.llm };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const baselines = [nonePolicy, fixedPolicy, controllerPolicy, smoothControllerPolicy];
  const runs: RunResult[] = []; // full series: seed LLM_SEED, all policies
  const extraBaselineRuns: RunResult[] = []; // PID runs on the extra seeds
  const summaries: Record<string, Record<string, Summary[]>> = {};
  const extraSeeds = new Set(EXTRAS.filter((e) => e.seed !== LLM_SEED).map((e) => `${e.scenario}:${e.seed}`));

  for (const scn of SCENARIOS) {
    summaries[scn.key] = {};
    for (const mk of baselines) {
      const list: Summary[] = [];
      for (let seed = 1; seed <= SEEDS; seed++) {
        const r = await runSim(scn, mk(), seed);
        list.push(r.summary);
        if (seed === LLM_SEED) runs.push(stripMeetings(r));
        else if (r.policy === "controller" && extraSeeds.has(`${scn.key}:${seed}`)) extraBaselineRuns.push(stripMeetings(r));
      }
      summaries[scn.key][mk().key] = list;
    }
    log(`baselines done: ${scn.key}`);
  }

  let llmStats = null as null | LlmClient["stats"];
  const extraRuns: RunResult[] = [];
  const extraLog: { scenario: string; seed: number; key: string; why: string; ran: boolean; note: string }[] = [];
  if (withLlm) {
    const client = new LlmClient({ offline: !live, maxCalls: MAX_CALLS, retryErrors: flag("retry-errors"), log });
    const llmRuns = await Promise.all(SCENARIOS.map(async (scn) => {
      const r = await runSim(scn, llmPolicy(client), LLM_SEED);
      log(`llm done: ${scn.key} (api ${r.llm?.calls}, cached ${r.llm?.cached}, fallbacks ${r.summary.fallbacks})`);
      return r;
    }));
    runs.push(...llmRuns);
    const missing = llmRuns.reduce((s, r) => s + r.meetings.filter((m) => m.fallback === "unsigned").length, 0);
    if (missing && !live) log(`WARNING: ${missing} LLM meetings had no cached response (ran the fallback). Re-run with --live to fill the cache.`);

    for (const e of EXTRAS) {
      if (live && client.remaining() < DAYS) { extraLog.push({ ...e, ran: false, note: `budget: ${client.remaining()} calls left, a run needs up to ${DAYS}` }); continue; }
      const scn = SCENARIOS.find((s) => s.key === e.scenario) as Scenario;
      const pol: Policy = llmPolicy(client, { key: e.key, name: e.name, systemPrompt: systemPromptFor(e.lockerMax) });
      const r = await runSim(scn, pol, e.seed, { rules: withLockerMax(e.lockerMax), variant: e.lockerMax === CFG.locker.max ? CFG.rawConstitution.version : `v2-format, locker max ${e.lockerMax}` });
      const unsigned = r.meetings.filter((m) => m.fallback === "unsigned").length;
      if (unsigned) { extraLog.push({ ...e, ran: false, note: `${unsigned} meetings not in the cache (offline replay); dropped` }); continue; }
      extraRuns.push(r);
      extraLog.push({ ...e, ran: true, note: `api ${r.llm?.calls}, cached ${r.llm?.cached}` });
      log(`llm extra done: ${e.key} ${e.scenario} seed ${e.seed} (api ${r.llm?.calls}, cached ${r.llm?.cached}, fallbacks ${r.summary.fallbacks})`);
    }
    llmStats = client.stats;
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

  const readPrereg = (f: string) => { const p = join(OUT, f); return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null; };
  const v1 = loadV1();

  // Head-to-head on seed 1: LLM chair vs the pre-registered controller, with the noise yardstick.
  const HEAD: [string, "hi" | "lo"][] = [["finalFloor", "hi"], ["finalPrice", "hi"], ["maxDrawdownPct", "lo"], ["volatilityPct", "lo"], ["finalEndowment", "hi"], ["whaleShareOfGainsPct", "lo"], ["whaleTakePct", "lo"], ["holderPnl", "hi"], ["totalVolume", "hi"]];
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
    const W = seed1("whale", "llm");
    const ctl = extraRuns.find((r) => r.policy === "llm_b50" && r.scenario === "whale")?.summary as any;
    const v1W = v1?.rows.whale?.llm;
    const llmMain = runs.filter((r) => r.policy === "llm");
    const askedAbove = llmMain.reduce((s, r) => s + r.summary.lockerAskedAboveMax, 0);
    const unparseable = llmMain.reduce((s, r) => s + (r.summary.fallbackReasons.unparseable ?? 0), 0);
    const winMtgs = (r: RunResult | undefined, pred: (x: number) => boolean) => (r ? r.series.lockerShare.slice(3, 33).filter(pred).length : null);
    const wRun = runs.find((r) => r.scenario === "whale" && r.policy === "llm");
    const cRun = extraRuns.find((r) => r.policy === "llm_b50" && r.scenario === "whale");
    verdicts = {
      v2: {
        H1_whale_take_vs_v1: { rule: "whale scenario, LLM chair: whale's locker rewards as % of all tax collected, v2 < v1", v2: W.whaleTakePct, v1: v1W?.whaleTakePct ?? null, v2RewardsNear: W.whaleRewards, v1RewardsNear: v1W?.whaleRewards ?? null, pass: v1W ? W.whaleTakePct < v1W.whaleTakePct : null },
        H1c_whale_take_vs_control: { rule: "whale scenario, seed 1: whale take under the v2 bound (25) < under the v1 bound (50), all else equal", v2: W.whaleTakePct, control: ctl?.whaleTakePct ?? null, v2RewardsNear: W.whaleRewards, controlRewardsNear: ctl?.whaleRewards ?? null, pass: ctl ? W.whaleTakePct < ctl.whaleTakePct : null },
        H2_bound_binds: { rule: "whale lock window (days 3-32): LLM v2 locker_share at 25 on >= 10 meetings, and the control above 25 on >= 10 meetings", v2AtCap: winMtgs(wRun, (x) => x === 25), controlAbove25: winMtgs(cRun, (x) => x > 25), pass: cRun ? winMtgs(wRun, (x) => x === 25)! >= 10 && winMtgs(cRun, (x) => x > 25)! >= 10 : null },
        H3_asks_inside_bound: { rule: "five v2 runs: the LLM asks for locker_share above 25 in at most 2 meetings", meetings: askedAbove, pass: askedAbove <= 2 },
        H4_parse: { rule: "five v2 runs: at most 1 unparseable reply (v1: 5)", unparseable, pass: unparseable <= 1 },
        H6_endowment_floor: { rule: "five v2 runs: the LLM's endowment_share reaches the 30 floor in at least 3", runs: llmMain.filter((r) => Math.min(...r.series.endowShare) === CFG.endowment.min).map((r) => r.scenario), pass: llmMain.filter((r) => Math.min(...r.series.endowShare) === CFG.endowment.min).length >= 3 },
        H5_llm_vs_pid_rewards: { rule: "whale scenario, seed 1: the whale's locker rewards stay higher under the LLM than under the PID", llm: W.whaleRewards, controller: seed1("whale", "controller").whaleRewards, pass: W.whaleRewards > seed1("whale", "controller").whaleRewards },
      },
      v1_retest: {
        H1_endowment: { rule: "LLM > controller in >= 4 of 5 scenarios, beyond noise", scenariosWon: endowWins, pass: endowWins.length >= 4 },
        H2_whale_share: { rule: "whale-capture scenario: whale share of gains LLM < controller", ...h("whale", "whaleShareOfGainsPct"), pass: h("whale", "whaleShareOfGainsPct").winner === "llm" },
        H3_bankrun_drawdown: { rule: "bank-run scenario: max drawdown LLM < controller", ...h("bankrun", "maxDrawdownPct"), pass: h("bankrun", "maxDrawdownPct").winner === "llm" },
      },
    };
  }

  const result = {
    meta: {
      tag: TAG,
      date: DATE,
      days: DAYS,
      baselineSeeds: SEEDS,
      llmSeed: LLM_SEED,
      volatilityFromDay: VOL_FROM,
      modelSha256: modelHash(),
      systemPromptSha256: createHash("sha256").update(SYSTEM_PROMPT).digest("hex"),
      constitution: CFG.rawConstitution,
      newArgs: CFG.rawNewArgs,
      source: CFG.source,
      mechanics: CFG.mechanics,
      venice: { base_url: CFG.venice.base_url, model_map: CFG.venice.model_map, max_calls: MAX_CALLS },
      preregistration: { v1: readPrereg("preregistration.json"), v2: readPrereg("preregistration-v2.json") },
      extras: extraLog,
    },
    scenarios: SCENARIOS.map((s) => ({ key: s.key, name: s.name, blurb: s.blurb })),
    policies: [
      { key: "none", name: "None (levers frozen at launch)" },
      { key: "fixed", name: "Fixed rule (SPEC fallback)" },
      { key: "controller", name: "PID controller" },
      { key: "llm", name: "LLM chair" },
      { key: "controller_smooth", name: "PID controller, smoothed (post-hoc sensitivity, not pre-registered)" },
      { key: "llm_b50", name: "LLM chair under the v1 bound (control)" },
    ],
    systemPrompt: SYSTEM_PROMPT,
    llm: llmStats,
    runs,
    extraRuns,
    extraBaselineRuns,
    aggregates,
    pairedNoise,
    headline,
    verdicts,
    v1,
  };
  const base = `sim-${TAG}-${DATE}`;
  const jsonPath = join(OUT, `${base}.json`);
  writeFileSync(jsonPath, JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? v.toString() : typeof v === "number" && !Number.isInteger(v) ? Number(v.toPrecision(8)) : v)));
  const htmlPath = join(OUT, `${base}.html`);
  writeFileSync(htmlPath, renderReport(JSON.parse(readFileSync(jsonPath, "utf8"))));
  log(`wrote ${jsonPath}`);
  log(`wrote ${htmlPath}`);
  log(`model ${result.meta.modelSha256}`);
  if (llmStats) log(`llm: ${llmStats.calls} api calls, ${llmStats.cacheHits} cache hits, ${llmStats.errors} errors, ${llmStats.promptTokens} in / ${llmStats.completionTokens} out tokens, $${llmStats.usd.toFixed(4)}`);
}

/** Baseline runs keep only clamp/fallback meeting info (no briefs) to keep the JSON small. */
function stripMeetings(r: RunResult): RunResult {
  return { ...r, meetings: r.meetings.map((m) => ({ day: m.day, meeting: m.meeting, tier: m.tier, fallback: m.fallback, requested: m.requested, applied: m.applied, clamps: m.clamps })) };
}

main().catch((e) => { console.error(e); process.exit(1); });
