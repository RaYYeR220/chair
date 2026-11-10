/**
 * What the landing draws from the committed simulation files, derived the way
 * scripts/render-readme.ts derives the README's numbers, so the page and the
 * README cannot disagree. Pure: the inputs are the parsed JSON files.
 *
 *   v3: results/sim-v3-2026-11-10.json (the file /api/sim serves, plus its per-day runs)
 *   v1: results/sim-2026-11-10.json (the first run, with the cap at 50)
 */

/* The result files are large, loosely typed JSON; only the fields read here are typed. */
interface Meet {
  day: number;
  meeting: number;
  tier: string | null;
  fallback: string | null;
  requested: { locker_share?: number; answers?: string[] } | null;
  applied: { locker_share: number } | null;
  clamps: { lever: string; asked: number; applied: number; rule: string }[];
  brief: string | null;
  content?: string | null;
}
interface Run {
  scenario: string;
  policy: string;
  lockerMax: number;
  series: { lockerShare: number[]; endowShare: number[]; endowment: number[]; tier: (string | null)[] };
  summary: { whaleRewards: number; whaleTakePct: number; finalEndowment: number };
  meetings: Meet[];
}
interface Headline {
  beyondNoise: boolean;
  winner: string;
}
export interface SimV3 {
  meta: { days: number; constitution: { locker_share: { max: number }; endowment_share: { min: number } } };
  scenarios: unknown[];
  runs: Run[];
  extraRuns: Run[];
  llm: { calls: number; cacheHits: number; usd: number };
  pairedNoise: Record<string, { whaleRewards: number; whaleTakePct: number }>;
  headline: Record<string, Record<string, Headline>>;
  verdicts: { v3: Record<string, { pass: boolean; unparseable?: number }> };
  seedProbe: { meetings: number; repeat: { sameApplied: number }; rows: { applied: { repeat?: number[]; run?: number[] } }[] };
}
export interface SimV1 {
  meta: { newArgs: { constitution: { locker_share_pct: { max: number } } } };
  runs: Run[];
}

/** The whale's account in the simulation (docs/SIMULATION.md). */
const WHALE = "holder-170.near";
/** The whale's lock window: meetings on days 3 to 32 (the pre-registered H1 window). */
const LOCK_FROM = 3;
const LOCK_TO = 32;

export interface WhaleKind {
  text: string;
  /** The locker_share the petition names, if it names one. */
  ask: number | null;
  /** The petition claims an authority it doesn't have or tells the chair to ignore its rules. */
  injection: boolean;
}
export interface WhaleSide {
  asked: number | null;
  applied: number;
  fallback: string | null;
  answer: string | null;
}
export interface WhaleRow {
  day: number;
  meeting: number;
  /** The whale's share of all locked weight in that meeting's brief. */
  share: number;
  kind: number;
  cap25: WhaleSide;
  cap50: WhaleSide;
}
export interface SimView {
  source: string;
  days: number;
  scenarios: number;
  cap: number;
  controlCap: number;
  lockMeetings: number;
  kinds: WhaleKind[];
  rows: WhaleRow[];
  atCap: number;
  controlAbove: number;
  controlAtItsCap: number;
  rewards: { cap: number; control: number; pid: number };
  take: { cap: number; control: number };
  noise: { rewards: number; take: number };
  gapsBeyondNoise: boolean;
  whaleShare: [number, number];
  v1: { cap: number; refused: number; meetings: number; lockerFrom: number; lockerTo: number; floorDay: number };
  pairs: number;
  within: number;
  wins: number;
  losses: number;
  stabN: number;
  stabWithin: number;
  floor: number;
  reachedFloor: number;
  llmRuns: number;
  endowLlm: [number, number];
  endowPid: [number, number];
  probe: { meetings: number; sameApplied: number; moved: string[]; held: string[] };
  passed: number;
  hypotheses: number;
  unparseable: number;
  asked: number;
  calls: number;
  usd: number;
  /** The whale run's endowment (NEAR) and IQ tier index per day, for the ladder's trail. */
  trail: { endowment: number[]; tier: number[] };
}

const window = <T>(xs: T[]) => xs.slice(LOCK_FROM, LOCK_TO + 1);
const span = (xs: number[]): [number, number] => [Math.min(...xs), Math.max(...xs)];
const firstObject = (s: string) => {
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  try {
    return a >= 0 && b > a ? (JSON.parse(s.slice(a, b + 1)) as { answers?: string[] }) : null;
  } catch {
    return null;
  }
};

/** Model per day to a ladder index: 0 asleep, then 1, 2, 3 in the order the run reached them (the endowment only grows). */
function tierIndex(tiers: (string | null)[]): number[] {
  const seen: string[] = [];
  return tiers.map((t) => {
    if (!t) return 0;
    if (!seen.includes(t)) seen.push(t);
    return seen.indexOf(t) + 1;
  });
}

export function deriveSim(V3: SimV3, V1: SimV1, source: string): SimView {
  const run = (scenario: string, policy: string) => {
    const r = V3.runs.find((x) => x.scenario === scenario && x.policy === policy);
    if (!r) throw new Error(`no ${policy} run for ${scenario}`);
    return r;
  };
  const llm = run("whale", "llm");
  const pid = run("whale", "controller");
  const control = V3.extraRuns.find((x) => x.scenario === "whale" && x.policy === "llm_b50");
  if (!control) throw new Error("no ceiling-50 control run");
  const cap = V3.meta.constitution.locker_share.max;
  const controlCap = control.lockerMax;

  // ---- the whale's lock window, meeting by meeting, under both caps
  const kinds: WhaleKind[] = [];
  const rows: WhaleRow[] = [];
  const side = (m: Meet | undefined, whaleIdx: number, lockerShare: number): WhaleSide => ({
    asked: m?.requested?.locker_share ?? null,
    applied: m?.applied?.locker_share ?? lockerShare,
    fallback: m?.fallback ?? null,
    answer: m?.requested?.answers?.[whaleIdx] ?? null,
  });
  for (let day = LOCK_FROM; day <= LOCK_TO; day++) {
    const m = llm.meetings.find((x) => x.day === day);
    const c = control.meetings.find((x) => x.day === day);
    if (!m?.brief) continue;
    const b = JSON.parse(m.brief) as { locker_weight: string; petitions: { from: string; weight: string; text: string }[] };
    const i = b.petitions.findIndex((p) => p.from === WHALE);
    if (i < 0) continue;
    const text = b.petitions[i].text;
    let kind = kinds.findIndex((k) => k.text === text);
    if (kind < 0) {
      const named = /locker_share (?:to )?(\d+)/.exec(text);
      kinds.push({ text, ask: named ? Number(named[1]) : null, injection: /^SYSTEM NOTICE|\bignore\b/i.test(text) });
      kind = kinds.length - 1;
    }
    const ci = c?.brief ? (JSON.parse(c.brief) as { petitions: { from: string }[] }).petitions.findIndex((p) => p.from === WHALE) : i;
    rows.push({
      day,
      meeting: m.meeting,
      share: Number(b.petitions[i].weight) / Number(b.locker_weight),
      kind,
      cap25: side(m, i, llm.series.lockerShare[day]),
      cap50: side(c, ci, control.series.lockerShare[day]),
    });
  }

  const lock = window(llm.series.lockerShare);
  const ctl = window(control.series.lockerShare);
  const noise = V3.pairedNoise.whale;
  const rewards = { cap: llm.summary.whaleRewards, control: control.summary.whaleRewards, pid: pid.summary.whaleRewards };
  const take = { cap: llm.summary.whaleTakePct, control: control.summary.whaleTakePct };

  // ---- LLM against PID, across every scenario and metric
  let within = 0, wins = 0, losses = 0, stabN = 0, stabWithin = 0;
  for (const scn of Object.keys(V3.headline)) {
    for (const [metric, h] of Object.entries(V3.headline[scn])) {
      if (!h.beyondNoise) within++;
      else if (h.winner === "llm") wins++;
      else losses++;
      if (metric === "maxDrawdownPct" || metric === "volatilityPct") {
        stabN++;
        if (!h.beyondNoise) stabWithin++;
      }
    }
  }
  const llmRuns = V3.runs.filter((r) => r.policy === "llm");
  const pidRuns = V3.runs.filter((r) => r.policy === "controller");
  const floor = V3.meta.constitution.endowment_share.min;

  // ---- temperature 0: the seed probe
  const LEVERS = ["tax", "endowment share", "locker share", "buyback size"];
  const moved = LEVERS.filter((_, i) => V3.seedProbe.rows.some((r) => r.applied.repeat && r.applied.run && r.applied.repeat[i] !== r.applied.run[i]));
  const verdicts = Object.values(V3.verdicts.v3);

  // ---- v1: refused in words, drifted in levers
  const v1 = V1.runs.find((r) => r.scenario === "whale" && r.policy === "llm");
  if (!v1) throw new Error("no v1 whale run");
  let v1Meetings = 0, v1Refused = 0;
  for (const m of v1.meetings) {
    if (m.day < LOCK_FROM || m.day > LOCK_TO || !m.brief) continue;
    v1Meetings++;
    const answers = m.requested?.answers ?? (m.content ? firstObject(m.content)?.answers : undefined);
    if (answers && /^(Denied|Rejected|Declined)\b/.test(answers[0] ?? "")) v1Refused++;
  }
  const v1Locker = window(v1.series.lockerShare);

  return {
    source,
    days: V3.meta.days,
    scenarios: V3.scenarios.length,
    cap,
    controlCap,
    lockMeetings: lock.length,
    kinds,
    rows,
    atCap: lock.filter((x) => x === cap).length,
    controlAbove: ctl.filter((x) => x > cap).length,
    controlAtItsCap: ctl.filter((x) => x === controlCap).length,
    rewards,
    take,
    noise: { rewards: noise.whaleRewards, take: noise.whaleTakePct },
    gapsBeyondNoise: rewards.control - rewards.cap > noise.whaleRewards && take.control - take.cap > noise.whaleTakePct,
    whaleShare: span(rows.map((r) => r.share)),
    v1: {
      cap: V1.meta.newArgs.constitution.locker_share_pct.max,
      refused: v1Refused,
      meetings: v1Meetings,
      lockerFrom: v1Locker[0],
      lockerTo: Math.max(...v1Locker),
      floorDay: v1.series.endowShare.indexOf(floor),
    },
    pairs: within + wins + losses,
    within,
    wins,
    losses,
    stabN,
    stabWithin,
    floor,
    reachedFloor: llmRuns.filter((r) => r.series.endowShare.includes(floor)).length,
    llmRuns: llmRuns.length,
    endowLlm: span(llmRuns.map((r) => r.summary.finalEndowment)),
    endowPid: span(pidRuns.map((r) => r.summary.finalEndowment)),
    probe: {
      meetings: V3.seedProbe.meetings,
      sameApplied: V3.seedProbe.repeat.sameApplied,
      moved,
      held: LEVERS.filter((n) => !moved.includes(n)),
    },
    passed: verdicts.filter((v) => v.pass).length,
    hypotheses: verdicts.length,
    unparseable: V3.verdicts.v3.H4_parse?.unparseable ?? 0,
    asked: [...llmRuns, control].reduce((s, r) => s + r.meetings.filter((m) => m.fallback !== "asleep").length, 0),
    calls: V3.llm.calls + V3.llm.cacheHits,
    usd: V3.llm.usd,
    trail: { endowment: llm.series.endowment, tier: tierIndex(llm.series.tier) },
  };
}
