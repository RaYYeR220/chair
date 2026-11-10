// Self-contained static HTML report: small multiples per scenario, hairline style, inline SVG,
// a crosshair tooltip, and tables (the table view is the accessible fallback for every chart).

type Any = any;
const POLICY_ORDER = ["none", "fixed", "controller", "llm", "llm_b50"];
const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

const W = 260, H = 132, PL = 44, PR = 8, PT = 8, PB = 18;

function nice(lo: number, hi: number): [number, number, number[]] {
  if (hi - lo < 1e-12) { hi = lo + (Math.abs(lo) || 1) * 0.1; lo = lo - (Math.abs(lo) || 1) * 0.1; }
  const span = hi - lo;
  const step0 = span / 3;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0)!;
  const a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let t = a; t <= b + step / 2; t += step) ticks.push(Number(t.toPrecision(10)));
  return [a, b, ticks];
}

function fmtNum(x: number): string {
  const ax = Math.abs(x);
  if (ax === 0) return "0";
  if (ax >= 1e9) return (x / 1e9).toFixed(ax >= 1e10 ? 0 : 1) + "B";
  if (ax >= 1e6) return (x / 1e6).toFixed(ax >= 1e7 ? 0 : 1) + "M";
  if (ax >= 1e3) return (x / 1e3).toFixed(ax >= 1e4 ? 0 : 1) + "k";
  if (ax >= 1) return x.toFixed(ax >= 100 ? 0 : 1);
  if (ax >= 1e-3) return x.toFixed(3);
  const e = Math.floor(Math.log10(ax));
  return `${(x / 10 ** e).toFixed(1)}e${e}`;
}

let chartId = 0;
function chart(title: string, unit: string, series: Record<string, number[]>, scale = 1, domain?: [number, number]): string {
  const id = `c${chartId++}`;
  const keys = POLICY_ORDER.filter((k) => series[k]);
  const all = keys.flatMap((k) => series[k].map((v) => v * scale));
  const [y0, y1, ticks] = domain ? [domain[0], domain[1], [domain[0], (domain[0] + domain[1]) / 2, domain[1]]] : nice(Math.min(...all), Math.max(...all));
  const n = series[keys[0]].length;
  const x = (i: number) => PL + (i / (n - 1)) * (W - PL - PR);
  const y = (v: number) => PT + (1 - (v - y0) / (y1 - y0 || 1)) * (H - PT - PB);
  const grid = ticks.map((t) => `<line class="g" x1="${PL}" x2="${W - PR}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/><text class="tk" x="${PL - 4}" y="${(y(t) + 3).toFixed(1)}" text-anchor="end">${fmtNum(t)}</text>`).join("");
  const xt = [0, 30, n - 1].map((d) => `<text class="tk" x="${x(d).toFixed(1)}" y="${H - 4}" text-anchor="${d === 0 ? "start" : d === n - 1 ? "end" : "middle"}">d${d}</text>`).join("");
  const paths = keys.map((k) => {
    const d = series[k].map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v * scale).toFixed(1)}`).join("");
    return `<path class="ln p-${k}" d="${d}"/>`;
  }).join("");
  const data = Object.fromEntries(keys.map((k) => [k, series[k].map((v) => Number((v * scale).toPrecision(5)))]));
  return `<figure class="ch" data-id="${id}">
<figcaption>${esc(title)} <span class="u">${esc(unit)}</span></figcaption>
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)} by policy over 60 days" data-x0="${PL}" data-x1="${W - PR}" data-n="${n}">
${grid}<line class="ax" x1="${PL}" x2="${W - PR}" y1="${H - PB}" y2="${H - PB}"/>${xt}${paths}<line class="xh" x1="0" x2="0" y1="${PT}" y2="${H - PB}"/>
<rect class="hit" x="${PL}" y="${PT}" width="${W - PL - PR}" height="${H - PT - PB}"/></svg>
<script type="application/json" class="d">${JSON.stringify(data)}</script></figure>`;
}

const f1 = (x: number) => (x == null || Number.isNaN(x) ? "–" : x.toFixed(1));
const f0 = (x: number) => (x == null || Number.isNaN(x) ? "–" : x.toFixed(0));

const METRICS: [string, string, (x: number) => string, "lo" | "hi" | ""][] = [
  ["finalFloor", "Floor d59 (µNEAR)", (x) => (x * 1e6).toFixed(3), "hi"],
  ["finalPrice", "Price d59 (µNEAR)", (x) => (x * 1e6).toFixed(3), "hi"],
  ["finalSupply", "Supply d59 (M)", (x) => (x / 1e6).toFixed(1), ""],
  ["maxDrawdownPct", "Max drawdown %", f1, "lo"],
  ["volatilityPct", "Daily vol % (d10+)", (x) => x.toFixed(2), "lo"],
  ["finalEndowment", "Endowment (NEAR)", f1, "hi"],
  ["totalVolume", "Volume (NEAR)", f0, "hi"],
  ["buybackSpent", "Buyback spent", f1, ""],
  ["whaleShareOfGainsPct", "Whale % of gains", f1, "lo"],
  ["whalePnl", "Whale PnL (NEAR)", f0, ""],
  ["whaleRewards", "Whale locker rewards (NEAR)", (x) => x.toFixed(2), "lo"],
  ["whaleTakePct", "Whale take, % of all tax", (x) => x.toFixed(2), "lo"],
  ["lockerShareMean", "Locker share, mean %", f1, ""],
  ["clampMeetings", "Clamp fired (mtgs)", f0, ""],
  ["fallbacks", "Fallback ran", f0, ""],
];

const LABEL: Record<string, string> = { controller_smooth: "controller, smoothed (post-hoc)", llm_b50: "LLM, v1 bound 0-50 (control)" };
function table(scn: string, runs: Any[], agg: Any): string {
  const rows = [...POLICY_ORDER.filter((p) => p !== "llm_b50"), "controller_smooth", "llm_b50"].map((p) => runs.find((r: Any) => r.scenario === scn && r.policy === p && r.seed === 1)).filter(Boolean);
  const head = `<tr><th>Policy</th>${METRICS.map(([, l]) => `<th>${esc(l)}</th>`).join("")}</tr>`;
  const body = rows.map((r: Any) => {
    const a = agg[r.policy];
    const label = LABEL[r.policy] ?? r.policy;
    return `<tr class="r-${r.policy}"><td><span class="sw p-${r.policy}"></span>${esc(label)}</td>${METRICS.map(([k, , fmt]) => {
      const v = r.summary[k];
      const band = a && a[k] ? `<span class="band">${fmt(a[k].mean)} ± ${fmt(a[k].sd)}</span>` : "";
      return `<td>${fmt(v)}${band}</td>`;
    }).join("")}</tr>`;
  }).join("");
  return `<div class="tw"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>
<p class="note">Seed 1 (the seed the LLM ran on). Small grey figures: mean ± sd over ${Object.values(agg)[0] ? (Object.values(agg)[0] as Any).finalFloor.n : 0} seeds for the deterministic policies.</p>`;
}

/** The contract's extract_object: whole content, else first '{' to last '}'. */
function extract(content: string): Any {
  const obj = (t: string) => { try { const v = JSON.parse(t); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; } };
  const w = obj(content.trim());
  if (w) return w;
  const a = content.indexOf("{"), b = content.lastIndexOf("}");
  return a >= 0 && b > a ? obj(content.slice(a, b + 1)) : null;
}

function minutes(r: Any, pick: number[]): string {
  return pick.map((d) => r.meetings.find((m: Any) => m.day === d)).filter(Boolean).map((m: Any) => {
    const content = m.content ?? "";
    const parsed: Any = extract(content);
    const brief = m.brief ? JSON.parse(m.brief) : null;
    const pet = brief?.petitions?.map((p: Any, i: number) => `<li><q>${esc(p.text)}</q><br><span class="ans">→ ${esc(parsed?.answers?.[i] ?? "")}</span></li>`).join("") ?? "";
    const req = m.requested ? `asked tax ${m.requested.tax_bps}, endow ${m.requested.endowment_share}, locker ${m.requested.locker_share}, buyback ${m.requested.buyback_burn}` : "";
    const app = `applied tax ${m.applied.tax_bps}, endow ${m.applied.endowment_share}, locker ${m.applied.locker_share}, buyback ${m.applied.buyback_burn}`;
    const cl = m.clamps?.length ? ` · clamped: ${m.clamps.map((c: Any) => `${c.lever} ${c.asked}→${c.applied} (${c.rule})`).join(", ")}` : "";
    const why = m.fallback === "unparseable" ? `<div class="mr">The reply failed check 3 (${parsed ? `answers: ${Array.isArray(parsed.answers) ? parsed.answers.length : "none"} for ${brief?.petitions?.length ?? 0} petitions` : "no JSON object"}). The fallback ran; the reply is shown for the record.</div>` : "";
    return `<div class="mn"><div class="mh">Day ${m.day} · meeting ${m.meeting} · ${esc(m.tier ?? "asleep")}${m.fallback ? ` · fallback (${esc(m.fallback)})` : ""}</div>
<div class="mr">${esc(req)}${req ? " · " : ""}${esc(app)}${esc(cl)}</div>${why}
${parsed?.minutes ? `<p class="mm">${esc(parsed.minutes)}</p>` : ""}${pet ? `<ol class="pt">${pet}</ol>` : ""}</div>`;
  }).join("");
}

const HEAD_LABELS: Record<string, [string, (x: number) => string]> = {
  finalFloor: ["Floor d59 (µNEAR)", (x) => (x * 1e6).toFixed(3)],
  finalPrice: ["Price d59 (µNEAR)", (x) => (x * 1e6).toFixed(3)],
  maxDrawdownPct: ["Max drawdown %", (x) => x.toFixed(1)],
  volatilityPct: ["Daily vol %", (x) => x.toFixed(2)],
  finalEndowment: ["Endowment (NEAR)", (x) => x.toFixed(1)],
  whaleShareOfGainsPct: ["Whale % of gains", (x) => x.toFixed(1)],
  whaleTakePct: ["Whale take % of tax", (x) => x.toFixed(2)],
  holderPnl: ["Holder PnL (NEAR)", (x) => x.toFixed(0)],
  totalVolume: ["Volume (NEAR)", (x) => x.toFixed(0)],
};

function headline(R: Any): string {
  const H = R.headline;
  if (!H || !Object.keys(H).length) return "";
  const metrics = Object.keys(HEAD_LABELS);
  const head = `<tr><th>Scenario</th>${metrics.map((k) => `<th>${esc(HEAD_LABELS[k][0])}</th>`).join("")}</tr>`;
  const body = (R.scenarios as Any[]).map((s: Any) => `<tr><td>${esc(s.name)}</td>${metrics.map((k) => {
    const c = H[s.key][k];
    const f = HEAD_LABELS[k][1];
    const verdict = c.winner === "tie" ? "tie" : `${c.winner === "llm" ? "LLM" : "PID"}${c.beyondNoise ? "" : " ~"}`;
    return `<td><b>${verdict}</b><span class="band">LLM ${f(c.llm)} · PID ${f(c.controller)}</span><span class="band">smoothed PID ${f(c.controller_smooth)}</span></td>`;
  }).join("")}</tr>`).join("");
  const V = R.verdicts;
  const pf = (p: Any) => (p === null || p === undefined ? "N/A" : p ? "PASS" : "FAIL");
  const f = (x: number) => (x == null ? "–" : x.toFixed(2));
  const v2 = V?.v2, v1r = V?.v1_retest;
  const verd = V ? `<ol class="pv">
<li><b>${pf(v2.H1_whale_take_vs_v1.pass)}</b> H1 whale take, v2 vs v1 (LLM, whale scenario): ${f(v2.H1_whale_take_vs_v1.v2)}% of all tax vs ${f(v2.H1_whale_take_vs_v1.v1)}% (${f(v2.H1_whale_take_vs_v1.v2RewardsNear)} vs ${f(v2.H1_whale_take_vs_v1.v1RewardsNear)} NEAR).</li>
<li><b>${pf(v2.H1c_whale_take_vs_control.pass)}</b> H1c whale take, bound 25 vs bound 50, all else equal: ${f(v2.H1c_whale_take_vs_control.v2)}% vs ${f(v2.H1c_whale_take_vs_control.control)}% (${f(v2.H1c_whale_take_vs_control.v2RewardsNear)} vs ${f(v2.H1c_whale_take_vs_control.controlRewardsNear)} NEAR).</li>
<li><b>${pf(v2.H2_bound_binds.pass)}</b> H2 the bound binds: v2 at 25 on ${v2.H2_bound_binds.v2AtCap} of 30 lock-window meetings; control above 25 on ${v2.H2_bound_binds.controlAbove25 ?? "–"}.</li>
<li><b>${pf(v2.H3_asks_inside_bound.pass)}</b> H3 asks inside the bound: ${v2.H3_asks_inside_bound.meetings} meetings asked locker_share above 25.</li>
<li><b>${pf(v2.H4_parse.pass)}</b> H4 parse: ${v2.H4_parse.unparseable} unparseable replies.</li>
<li><b>${pf(v2.H5_llm_vs_pid_rewards.pass)}</b> H5 whale rewards LLM vs PID: ${f(v2.H5_llm_vs_pid_rewards.llm)} vs ${f(v2.H5_llm_vs_pid_rewards.controller)} NEAR.</li>
<li><b>${pf(v2.H6_endowment_floor.pass)}</b> H6 endowment share reaches the 30 floor: ${v2.H6_endowment_floor.runs.length} of 5 runs (${v2.H6_endowment_floor.runs.join(", ") || "none"}).</li>
</ol>
<h3>v1 hypotheses, retested under v2</h3><ol class="pv">
<li><b>${pf(v1r.H1_endowment.pass)}</b> H1 endowment: LLM above the PID beyond noise in ${v1r.H1_endowment.scenariosWon.length} of 5 (${v1r.H1_endowment.scenariosWon.join(", ") || "none"}); needed 4.</li>
<li><b>${pf(v1r.H2_whale_share.pass)}</b> H2 whale share of gains: LLM ${f(v1r.H2_whale_share.llm)}% vs PID ${f(v1r.H2_whale_share.controller)}% (noise ±${f(v1r.H2_whale_share.noise)})${v1r.H2_whale_share.beyondNoise ? "" : ", within noise"}.</li>
<li><b>${pf(v1r.H3_bankrun_drawdown.pass)}</b> H3 bank-run drawdown: LLM ${f(v1r.H3_bankrun_drawdown.llm)}% vs PID ${f(v1r.H3_bankrun_drawdown.controller)}% (noise ±${f(v1r.H3_bankrun_drawdown.noise)})${v1r.H3_bankrun_drawdown.beyondNoise ? "" : ", within noise"}.</li>
</ol>` : "";
  return `<h2>LLM chair vs PID controller, seed 1</h2>
<p class="note">Each cell names the better of the LLM chair and the pre-registered PID controller on that metric. "~" means the gap is smaller than the seed-noise yardstick (sd across 20 seeds of the paired controller − fixed-rule difference), so one seed can't call it. The smoothed PID was added after the v1 pre-registration as a sensitivity check and is shown for reference only.</p>
<div class="tw"><table>${head}${body}</table></div>
<h3>Pre-registered v2 hypotheses</h3>${verd}`;
}

const VS: [string, string, (x: number) => string][] = [
  ["whaleTakePct", "Whale take % of tax", (x) => x.toFixed(2)],
  ["whaleRewards", "Whale rewards (NEAR)", (x) => x.toFixed(2)],
  ["lockerShareMean", "Locker share mean %", (x) => x.toFixed(1)],
  ["endowShareMean", "Endowment share mean %", (x) => x.toFixed(1)],
  ["maxDrawdownPct", "Max DD %", (x) => x.toFixed(1)],
  ["finalEndowment", "Endowment (NEAR)", (x) => x.toFixed(1)],
  ["taxCollected", "Tax collected (NEAR)", (x) => x.toFixed(1)],
];
function versus(R: Any): string {
  if (!R.v1) return "";
  const rows: string[] = [];
  for (const s of R.scenarios as Any[]) {
    for (const p of ["llm", "controller", "fixed"]) {
      const a = R.v1.rows[s.key]?.[p];
      const b = (R.runs as Any[]).find((r) => r.scenario === s.key && r.policy === p && r.seed === 1)?.summary;
      if (!a || !b) continue;
      rows.push(`<tr><td>${p === "llm" ? esc(s.name) : ""}</td><td>${esc(p)}</td>${VS.map(([k, , fm]) => `<td>${a[k] == null ? "–" : fm(a[k])} → <b>${fm(b[k])}</b></td>`).join("")}</tr>`);
    }
    const c = ((R.extraRuns as Any[]) ?? []).find((r) => r.scenario === s.key && r.policy === "llm_b50");
    if (c) rows.push(`<tr><td></td><td>LLM, bound 50 (control)</td>${VS.map(([k, , fm]) => `<td><b>${fm(c.summary[k])}</b></td>`).join("")}</tr>`);
  }
  const extra = ((R.extraRuns as Any[]) ?? []).filter((r) => r.policy === "llm" && r.seed !== 1);
  const extraRows = extra.map((r) => {
    const pid = ((R.extraBaselineRuns as Any[]) ?? []).find((x) => x.scenario === r.scenario && x.seed === r.seed);
    return `<tr><td>${esc(r.scenario)}</td><td>${r.seed}</td>${VS.map(([k, , fm]) => `<td>${fm(r.summary[k])}<span class="band">PID ${pid ? fm(pid.summary[k]) : "–"}</span></td>`).join("")}</tr>`;
  }).join("");
  return `<h2>v1 → v2</h2>
<p class="note">v1 (${esc(R.v1.file)}): locker_share 0-50, the sim's own prompt and brief, launch levers 300/60/10, p0 1e-7, k 2e-14, petition fee 10,000 CHAIR. v2: locker_share 0-25, the contract's exact prompt and brief, the testnet launch args (200/60/20, p0 1e-6, k 1e-12, fee 1,000 CHAIR) and the contract's reward, storage and parse mechanics. So v1 → v2 changes more than the bound; the control row (bound 50, everything else v2) isolates the bound. Seed 1, cells read v1 → <b>v2</b>. Whale take = the whale's locker rewards as % of all tax collected over 60 days.</p>
<div class="tw"><table><tr><th>Scenario</th><th>Policy</th>${VS.map(([, l]) => `<th>${esc(l)}</th>`).join("")}</tr>${rows.join("")}</table></div>
${extraRows ? `<h3>Extra LLM seeds</h3><div class="tw"><table><tr><th>Scenario</th><th>Seed</th>${VS.map(([, l]) => `<th>${esc(l)}</th>`).join("")}</tr>${extraRows}</table></div>` : ""}`;
}

export function renderReport(R: Any): string {
  chartId = 0;
  const scen = R.scenarios as Any[];
  const runs = [...(R.runs as Any[]), ...((R.extraRuns as Any[]) ?? []).filter((r) => r.seed === 1)];
  const hasLlm = runs.some((r) => r.policy === "llm");
  const pols = (R.policies as Any[]).filter((p) => POLICY_ORDER.includes(p.key) && (p.key !== "llm" || hasLlm));
  const sections = scen.map((s: Any) => {
    const by = (k: string) => Object.fromEntries(runs.filter((r) => r.scenario === s.key).map((r) => [r.policy, r.series[k]]));
    const cum = (k: string) => Object.fromEntries(runs.filter((r) => r.scenario === s.key).map((r) => { let a = 0; return [r.policy, r.series[k].map((v: number) => (a += v))]; }));
    const llmRun = runs.find((r) => r.scenario === s.key && r.policy === "llm");
    const tiers = llmRun ? Object.entries(llmRun.summary.tiers).map(([k, v]) => `${esc(k)} ×${v}`).join(", ") : "";
    return `<section id="${s.key}"><h2>${esc(s.name)}</h2><p class="blurb">${esc(s.blurb)}</p>
<div class="grid">
${chart("Curve price", "µNEAR / CHAIR", by("price"), 1e6)}
${chart("Floor (reserve ÷ supply)", "µNEAR / CHAIR", by("floor"), 1e6)}
${chart("Supply", "M CHAIR", by("supply"), 1e-6)}
${chart("Endowment (intelligence budget)", "NEAR", by("endowment"))}
${chart("Tax", "bps", by("tax"), 1, [100, 300])}
${chart("Buyback spent, cumulative", "NEAR", cum("buybackNear"))}
${chart("Endowment share", "% of tax", by("endowShare"), 1, [0, 100])}
${chart("Locker share", "% of tax", by("lockerShare"), 1, [0, 100])}
</div>
${table(s.key, runs, R.aggregates[s.key])}
${llmRun ? `<p class="note">LLM chair tiers used: ${tiers}. Fallbacks: ${esc(JSON.stringify(llmRun.summary.fallbackReasons))}.</p>` : ""}
</section>`;
  }).join("\n");

  const llmRuns = runs.filter((r) => r.policy === "llm" || r.policy === "llm_b50");
  const pickDays: Record<string, number[]> = { steady: [3, 16], pump: [17], apathy: [23], whale: [5, 7, 33], bankrun: [30, 31] };
  const minutesHtml = llmRuns.map((r) => `<h3>${esc(scen.find((s: Any) => s.key === r.scenario).name)}${r.policy === "llm_b50" ? " (control, bound 50)" : ""}</h3>${minutes(r, pickDays[r.scenario] ?? [])}`).join("");
  const L = R.llm;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CHAIR simulation v2</title>
<style>
:root{color-scheme:light;--bg:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--grid:#e1e0d9;--axis:#c3c2b7;--line:rgba(11,11,11,.10);
--s-none:#2a78d6;--s-fixed:#eb6834;--s-controller:#1baf7a;--s-llm:#6250d6;--s-llm_b50:#b0a7ec}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--bg:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--axis:#383835;--line:rgba(255,255,255,.10);
--s-none:#3987e5;--s-fixed:#d95926;--s-controller:#199e70;--s-llm:#9085e9;--s-llm_b50:#5b4fb0}}
:root[data-theme="dark"]{color-scheme:dark;--bg:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--axis:#383835;--line:rgba(255,255,255,.10);
--s-none:#3987e5;--s-fixed:#d95926;--s-controller:#199e70;--s-llm:#9085e9;--s-llm_b50:#5b4fb0}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1180px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:22px;font-weight:600;margin:0 0 4px}h2{font-size:17px;font-weight:600;margin:40px 0 4px;padding-top:16px;border-top:1px solid var(--line)}h3{font-size:14px;font-weight:600;margin:24px 0 8px}
.sub,.blurb,.note{color:var(--ink2)}.note{font-size:12px}
.legend{display:flex;gap:18px;flex-wrap:wrap;margin:16px 0;position:sticky;top:0;background:var(--bg);padding:8px 0;z-index:2;border-bottom:1px solid var(--line)}
.legend span{display:inline-flex;align-items:center;gap:6px;color:var(--ink2);font-size:13px}
.sw{display:inline-block;width:14px;height:2px;vertical-align:middle;margin-right:6px}
.sw.p-none,.ln.p-none{--c:var(--s-none)}.sw.p-fixed,.ln.p-fixed{--c:var(--s-fixed)}.sw.p-controller,.ln.p-controller{--c:var(--s-controller)}.sw.p-llm,.ln.p-llm{--c:var(--s-llm)}.sw.p-llm_b50,.ln.p-llm_b50{--c:var(--s-llm_b50)}.ln.p-llm_b50{stroke-dasharray:4 3}
.sw{background:var(--c)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;margin-top:12px}
.ch{margin:0;background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:8px 8px 4px;position:relative}
figcaption{font-size:12px;color:var(--ink);margin-bottom:2px}.u{color:var(--muted)}
svg{width:100%;height:auto;display:block;overflow:visible}
.g{stroke:var(--grid);stroke-width:1}.ax{stroke:var(--axis);stroke-width:1}.tk{fill:var(--muted);font-size:9px;font-variant-numeric:tabular-nums}
.ln{fill:none;stroke:var(--c);stroke-width:1.5;stroke-linejoin:round;stroke-linecap:round}.ln.p-llm{stroke-width:2}
.xh{stroke:var(--ink2);stroke-width:1;opacity:0}.hit{fill:transparent}
.tip{position:absolute;pointer-events:none;background:var(--surface);border:1px solid var(--line);border-radius:4px;padding:4px 6px;font-size:11px;color:var(--ink);white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.08);display:none;z-index:3;font-variant-numeric:tabular-nums}
.tw{overflow-x:auto;margin-top:12px}table{border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums;min-width:100%}
th,td{padding:4px 8px;border-bottom:1px solid var(--line);text-align:right;vertical-align:top}th:first-child,td:first-child{text-align:left;white-space:nowrap}tr.r-controller_smooth td{color:var(--ink2);font-style:italic}th{font-weight:500;color:var(--ink2)}
.band{display:block;color:var(--muted);font-size:10px}
.mn{background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:10px 12px;margin:8px 0}.mh{font-weight:600;font-size:13px}.mr{color:var(--ink2);font-size:12px}.mm{margin:6px 0}
.pt{margin:6px 0 0;padding-left:18px;font-size:12px}.pt q{color:var(--ink2)}.ans{color:var(--ink)}
.pv{padding-left:18px}.pv li{margin:4px 0}
pre{white-space:pre-wrap;background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:12px;font-size:12px}
</style></head><body><main>
<h1>CHAIR: 60 days, five communities, four chairs (v2 constitution)</h1>
<p class="sub">Generated ${esc(R.meta.date)}. Exact integer token model (SPEC §2–§5), agent-based holders with common random numbers, ${R.meta.baselineSeeds} seeds for the deterministic policies, seed ${R.meta.llmSeed} for the LLM chair. Model hash <code>${esc(R.meta.modelSha256.slice(0, 16))}</code>. Every policy's ruling passes through the same constitution clamp.</p>
${hasLlm && L ? `<p class="sub">LLM chair: ${(L.calls + L.cacheHits).toLocaleString()} model rulings (${L.cacheHits} replayed from the response cache in this build), ${L.promptTokens.toLocaleString()} input + ${L.completionTokens.toLocaleString()} output tokens, ≈ $${L.usd.toFixed(2)} at Venice list price for the original calls.</p>` : ""}
${headline(R)}
${versus(R)}
<div class="legend" aria-label="Legend">${pols.map((p: Any) => `<span><i class="sw p-${p.key}"></i>${esc(p.name)}</span>`).join("")}</div>
${sections}
${hasLlm ? `<h2>Minutes, selected meetings</h2><p class="note">The model's own minutes and its answers to the petitions in the brief, as returned. "asked" is the raw ruling; "applied" is after the constitution.</p>${minutesHtml}` : ""}
<h2>System prompt</h2><pre>${esc(R.systemPrompt)}</pre>
<h2>Parameters</h2><pre>${esc(JSON.stringify(R.meta.newArgs, null, 1))}</pre>
<h2>Constitution</h2><pre>${esc(JSON.stringify(R.meta.constitution, null, 1))}</pre>
<h2>Contract mechanics mirrored</h2><pre>${esc(JSON.stringify(R.meta.mechanics, null, 1))}</pre>
</main>
<script>
document.querySelectorAll(".ch").forEach(function(fig){
  var svg=fig.querySelector("svg"),data=JSON.parse(fig.querySelector(".d").textContent),xh=svg.querySelector(".xh");
  var tip=document.createElement("div");tip.className="tip";fig.appendChild(tip);
  var x0=+svg.dataset.x0,x1=+svg.dataset.x1,n=+svg.dataset.n,vb=svg.viewBox.baseVal;
  function fmt(v){var a=Math.abs(v);return a>=1000?v.toFixed(0):a>=10?v.toFixed(1):a>=1?v.toFixed(2):v.toPrecision(3)}
  svg.addEventListener("mousemove",function(e){var r=svg.getBoundingClientRect(),sx=(e.clientX-r.left)/r.width*vb.width;
    var i=Math.round((sx-x0)/(x1-x0)*(n-1));if(i<0||i>=n){return}var px=x0+i/(n-1)*(x1-x0);
    xh.setAttribute("x1",px);xh.setAttribute("x2",px);xh.style.opacity=.5;
    tip.innerHTML="<b>day "+i+"</b><br>"+Object.keys(data).map(function(k){return '<i class="sw p-'+k+'"></i>'+k+" "+fmt(data[k][i])}).join("<br>");
    tip.style.display="block";var left=(px/vb.width)*r.width+12;if(left>r.width-110)left-=130;tip.style.left=left+"px";tip.style.top="28px"});
  svg.addEventListener("mouseleave",function(){xh.style.opacity=0;tip.style.display="none"});
});
</script></body></html>`;
}
