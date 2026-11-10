/**
 * Checks a replayed simulation against the committed one, and the three
 * pre-registrations against their recorded hashes.
 *
 *   sim/run --date replay                              # offline: the LLM chair comes from sim/cache/llm
 *   node scripts/check-replay.ts results/sim-v3-replay.json
 *
 * The replay must equal results/sim-v3-2026-11-10.json in every series, every
 * meeting (seed, brief, request hash, raw reply, asked and applied levers,
 * clamps), every aggregate, the verdicts and the seed probe. Only the run date
 * and the counters that say whether a reply came from the network or the
 * cache may differ. Exit code 1 on any other difference.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const COMMITTED = "results/sim-v3-2026-11-10.json";
const replayFile = process.argv[2];
if (!replayFile) {
  console.error("usage: node scripts/check-replay.ts <replayed sim-v3 json>");
  process.exit(2);
}
const a = JSON.parse(readFileSync(COMMITTED, "utf8"));
const b = JSON.parse(readFileSync(replayFile, "utf8"));

// Network-versus-cache counters: a live run counts calls, a replay counts cache hits.
const run = (r: any) => {
  const { llm: _llm, ...rest } = r;
  return { ...rest, meetings: r.meetings.map(({ cached: _c, ...m }: any) => m) };
};
const norm = (j: any) => ({
  ...j,
  meta: { ...j.meta, date: null, extras: j.meta.extras.map(({ note: _n, ...e }: any) => e) },
  llm: j.llm && { ...j.llm, calls: j.llm.calls + j.llm.cacheHits, cacheHits: null },
  runs: j.runs.map(run),
  extraRuns: j.extraRuns.map(run),
});
const A = norm(a), B = norm(b);

let failed = false;
const line = (ok: boolean, what: string) => {
  if (!ok) failed = true;
  console.log(`${ok ? "SAME" : "DIFF"}  ${what}`);
};
const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);

for (const k of Object.keys(A)) {
  if (k === "runs" || k === "extraRuns") continue;
  line(same(A[k], B[k]), k);
}
for (const k of ["runs", "extraRuns"]) {
  A[k].forEach((r: any, i: number) => {
    const meetings = r.meetings.filter((m: any) => m.brief).length;
    line(same(r, B[k][i]), `${k}: ${r.scenario} / ${r.policy} (${r.series.supply.length} days${meetings ? `, ${meetings} model meetings` : ""})`);
  });
  if (A[k].length !== B[k].length) line(false, `${k}: ${A[k].length} committed, ${B[k].length} replayed`);
}

// Pre-registrations: sha256 of each marked section of docs/SIMULATION.md, markers included.
const md = readFileSync("docs/SIMULATION.md", "utf8");
for (const f of ["preregistration.json", "preregistration-v2.json", "preregistration-v3.json"]) {
  const p = JSON.parse(readFileSync(`results/${f}`, "utf8"));
  const [begin, end] = p.section.split("..").map((s: string) => `<!-- ${s} -->`);
  const i = md.indexOf(begin), j = md.indexOf(end);
  const h = i >= 0 && j > i ? createHash("sha256").update(md.slice(i, j + end.length)).digest("hex") : "";
  line(h === p.sha256, `pre-registration ${p.section.split(":")[0]}: sha256 ${p.sha256.slice(0, 12)}… (results/${f})`);
}

console.log(failed ? "\nThe replay differs from the committed results." : `\nThe replay reproduces ${COMMITTED} exactly, apart from the run date and the network/cache counters.`);
process.exit(failed ? 1 : 0);
