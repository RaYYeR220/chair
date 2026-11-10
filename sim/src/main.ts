// sim/run entry point.
//   sim/run                 baselines over N seeds + LLM chair replayed from the cache (no network)
//   sim/run --live          same, but cache misses call Venice (needs VENICE_API_KEY)
//   sim/run --no-llm        baselines only
//   sim/run --seeds 20 --date 2026-11-10
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CFG, REPO_DIR, RULES, SIM_DIR, withLockerMax } from "./config.ts";
import { SCENARIOS, DAYS, type Scenario } from "./scenarios.ts";
import { runSim, type RunResult, type Summary, VOL_FROM } from "./engine.ts";
import { nonePolicy, fixedPolicy, controllerPolicy, llmPolicy, parseRuling, type Policy } from "./policies.ts";
import { LlmClient, type LlmResult } from "./llm.ts";
import { SYSTEM_PROMPT, buildRequest, systemPromptFor } from "./prompt.ts";
import { clampRuling, type Ruling } from "./token.ts";
import { renderReport } from "./report.ts";
import { smoothControllerPolicy } from "./posthoc.ts";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string, d: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

const SEEDS = Number(opt("seeds", "20"));
const LLM_SEED = 1;
const DATE = opt("date", new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10));
const TAG = opt("tag", CFG.tokenVersion);
const PREV_RESULTS = opt("prev", "sim-v2-2026-11-10.json");
const OUT = join(REPO_DIR, "results");
const live = flag("live");
const withLlm = !flag("no-llm");
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
  { scenario: "whale", seed: 1, key: "llm_b50", name: "LLM chair, locker_share ceiling 50 (control)", lockerMax: 50, why: "control: same seed, args and request format, only the locker_share ceiling at the v1 value" },
  { scenario: "whale", seed: 2, key: "llm", name: "LLM chair", lockerMax: CFG.locker.max, why: "extra seed" },
  { scenario: "bankrun", seed: 2, key: "llm", name: "LLM chair", lockerMax: CFG.locker.max, why: "extra seed" },
];

/**
 * Seed probe (pre-registered with v3): on the seed-1 whale run, the meetings of days 4, 8, ..., 32.
 * Each is asked twice more: the identical request again, and the same brief with another seed.
 * Comparing both answers with the run's tells what the seed alone changes, net of the host's own
 * nondeterminism at temperature 0.
 */
const PROBE = { scenario: "whale", days: [4, 8, 12, 16, 20, 24, 28, 32], variant: "repeat-1" };
const probeSeed = (scenario: string, seed: number, meeting: number) => createHash("sha256").update(`${scenario}|${seed}|${meeting}|probe`).digest("hex").slice(0, 2 * CFG.seedBytes);

async function seedProbe(client: LlmClient, run: RunResult) {
  const rows: any[] = [];
  for (const day of PROBE.days) {
    const i = run.meetings.findIndex((x) => x.day === day);
    const m = run.meetings[i];
    if (!m?.brief || !m.tier || !m.seed) continue;
    const request = buildRequest(m.tier, m.brief);
    const alt = probeSeed(run.scenario, run.seed, m.meeting);
    const altBrief = m.brief.replace(`"seed":"${m.seed}"`, `"seed":"${alt}"`);
    if (altBrief === m.brief) throw new Error("probe: seed not found in the brief");
    const altRequest = buildRequest(m.tier, altBrief);
    if (live ? client.remaining() < 2 : !(client.isCached(request, PROBE.variant) && client.isCached(altRequest))) break;
    const petitions = JSON.parse(m.brief).petitions.length;
    const prev = i > 0 ? run.meetings[i - 1].applied : { ...CFG.launch, buyback_burn: 0 };
    const before = { tax_bps: prev.tax_bps, endowment_share: prev.endowment_share, locker_share: prev.locker_share };
    const read = (r: LlmResult): Ruling | null => (r.error || r.content == null || r.responseBytes > CFG.maxResponseBytes ? null : parseRuling(r.content, petitions));
    const asked = (r: Ruling | null) => (r ? [r.tax_bps, r.endowment_share, r.locker_share, r.buyback_burn] : null);
    const applied = (r: Ruling | null) => { if (!r) return null; const c = clampRuling(r, before, RULES); return [c.levers.tax_bps, c.levers.endowment_share, c.levers.locker_share, c.buyback_burn]; };
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const base = m.requested;
    const rep = read(await client.complete(request, PROBE.variant));
    const sd = read(await client.complete(altRequest));
    rows.push({
      day, meeting: m.meeting, model: m.tier, seed: m.seed, altSeed: alt,
      asked: { run: asked(base), repeat: asked(rep), altSeed: asked(sd) },
      applied: { run: applied(base), repeat: applied(rep), altSeed: applied(sd) },
      repeatSameAsked: same(asked(base), asked(rep)), repeatSameApplied: same(applied(base), applied(rep)),
      altSameAsked: same(asked(base), asked(sd)), altSameApplied: same(applied(base), applied(sd)),
      minutes: { run: base?.minutes ?? null, repeat: rep?.minutes ?? null, altSeed: sd?.minutes ?? null },
    });
  }
  const n = rows.length;
  const count = (k: string) => rows.filter((r) => r[k]).length;
  return {
    protocol: `${PROBE.scenario} run, seed ${LLM_SEED}, days ${PROBE.days.join(", ")}: the identical request resent once, and the same brief with seed sha256("<scenario>|<seed>|<meeting>|probe")[:16]`,
    meetings: n,
    repeat: { sameAsked: count("repeatSameAsked"), sameApplied: count("repeatSameApplied") },
    altSeed: { sameAsked: count("altSameAsked"), sameApplied: count("altSameApplied") },
    rows,
  };
}

/** The previous run's seed-1 summaries (v2), with the endowment-floor counts, and its control. */
function loadPrev() {
  const p = join(OUT, PREV_RESULTS);
  if (!existsSync(p)) return null;
  const V = JSON.parse(readFileSync(p, "utf8"));
  const rows: Record<string, Record<string, any>> = {};
  const add = (r: any) => {
    const e = r.series.endowShare as number[];
    (rows[r.scenario] ??= {})[r.policy] = { ...r.summary, endowAtFloorMeetings: e.filter((x) => x === CFG.endowment.min).length, endowShareFinal: e.at(-1), lockerAtCapLockWindow: r.series.lockerShare.slice(3, 33).filter((x: number) => x === CFG.locker.max).length };
  };
  for (const r of V.runs) if (r.seed === LLM_SEED) add(r);
  for (const r of V.extraRuns ?? []) if (r.seed === LLM_SEED) add(r);
  return { file: `results/${PREV_RESULTS}`, tag: V.meta.tag, modelSha256: V.meta.modelSha256, newArgs: V.meta.newArgs, rows, llm: V.llm };
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
  let probe: Awaited<ReturnType<typeof seedProbe>> | null = null;
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
      const r = await runSim(scn, pol, e.seed, { rules: withLockerMax(e.lockerMax), variant: e.lockerMax === CFG.locker.max ? CFG.tokenVersion : `${CFG.tokenVersion}, locker max ${e.lockerMax}` });
      const unsigned = r.meetings.filter((m) => m.fallback === "unsigned").length;
      if (unsigned) { extraLog.push({ ...e, ran: false, note: `${unsigned} meetings not in the cache (offline replay); dropped` }); continue; }
      extraRuns.push(r);
      extraLog.push({ ...e, ran: true, note: `api ${r.llm?.calls}, cached ${r.llm?.cached}` });
      log(`llm extra done: ${e.key} ${e.scenario} seed ${e.seed} (api ${r.llm?.calls}, cached ${r.llm?.cached}, fallbacks ${r.summary.fallbacks})`);
    }
    const probeRun = llmRuns.find((r) => r.scenario === PROBE.scenario);
    if (probeRun) {
      probe = await seedProbe(client, probeRun);
      log(`seed probe: ${probe.meetings} meetings; identical resend same levers ${probe.repeat.sameApplied}, other seed same levers ${probe.altSeed.sameApplied}`);
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
  const prev = loadPrev();

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
    const W = seed1("whale", "llm");
    const ctlRun = extraRuns.find((r) => r.policy === "llm_b50" && r.scenario === "whale" && r.seed === LLM_SEED);
    const ctl = ctlRun?.summary;
    const wRun = runs.find((r) => r.scenario === "whale" && r.policy === "llm")!;
    const llmMain = runs.filter((r) => r.policy === "llm");
    const allLlm = [...llmMain, ...(ctlRun ? [ctlRun] : [])];
    const unparseable = allLlm.reduce((s, r) => s + (r.summary.fallbackReasons.unparseable ?? 0), 0);
    const lockWin = (r: RunResult | undefined, pred: (x: number) => boolean) => (r ? r.series.lockerShare.slice(3, 33).filter(pred).length : null);
    const floor = CFG.endowment.min;
    const reached = llmMain.filter((r) => r.series.endowShare.includes(floor)).map((r) => r.scenario);
    const ended = llmMain.filter((r) => r.series.endowShare.at(-1) === floor).map((r) => r.scenario);
    const noiseW = pairedNoise.whale;
    verdicts = {
      v3: {
        H1_cap_binds: { rule: "whale lock window (days 3-32): the v3 LLM's locker_share at 25 in >= 10 of 30 meetings, and the control's above 25 in >= 10", v3AtCap: lockWin(wRun, (x) => x === 25), controlAbove25: lockWin(ctlRun, (x) => x > 25), pass: ctlRun ? lockWin(wRun, (x) => x === 25)! >= 10 && lockWin(ctlRun, (x) => x > 25)! >= 10 : null },
        H2_below_control: { rule: "whale scenario, seed 1: the whale's locker rewards under the 25 ceiling are below the cap-50 control, in NEAR and as % of all tax", v3RewardsNear: W.whaleRewards, controlRewardsNear: ctl?.whaleRewards ?? null, v3TakePct: W.whaleTakePct, controlTakePct: ctl?.whaleTakePct ?? null, noiseRewards: noiseW.whaleRewards, noiseTake: noiseW.whaleTakePct, pass: ctl ? W.whaleRewards < ctl.whaleRewards && W.whaleTakePct < ctl.whaleTakePct : null },
        H3_endowment_floor: { rule: "five v3 runs: the LLM's endowment_share reaches the 30 floor in >= 4 and ends at it (day 59) in >= 4", reached, ended, pass: reached.length >= 4 && ended.length >= 4 },
        H4_parse: { rule: "five v3 runs and the control: zero unparseable replies", unparseable, runs: allLlm.length, pass: unparseable === 0 },
        H5_llm_vs_pid_rewards: { rule: "whale scenario, seed 1: the whale's locker rewards are higher under the LLM than under the PID", llm: W.whaleRewards, controller: seed1("whale", "controller").whaleRewards, pass: W.whaleRewards > seed1("whale", "controller").whaleRewards },
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
      tokenVersion: CFG.tokenVersion,
      constitution: CFG.rawConstitution,
      newArgs: CFG.rawNewArgs,
      source: CFG.source,
      mechanics: CFG.mechanics,
      venice: { base_url: CFG.venice.base_url, model_map: CFG.venice.model_map, max_calls: MAX_CALLS },
      preregistration: { v1: readPrereg("preregistration.json"), v2: readPrereg("preregistration-v2.json"), v3: readPrereg("preregistration-v3.json") },
      extras: extraLog,
    },
    scenarios: SCENARIOS.map((s) => ({ key: s.key, name: s.name, blurb: s.blurb })),
    policies: [
      { key: "none", name: "None (levers frozen at launch)" },
      { key: "fixed", name: "Fixed rule (SPEC fallback)" },
      { key: "controller", name: "PID controller" },
      { key: "llm", name: "LLM chair" },
      { key: "controller_smooth", name: "PID controller, smoothed (post-hoc sensitivity, not pre-registered)" },
      { key: "llm_b50", name: "LLM chair, locker_share ceiling 50 (control)" },
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
    seedProbe: probe,
    prev,
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
