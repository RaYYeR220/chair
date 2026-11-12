/**
 * Renders the computed numbers in README.md from the committed results, so no
 * figure between the markers is typed by hand:
 *
 *   results/sim-v3-<date>.json   the 60-day simulation (latest dated run)
 *   results/sim-2026-11-10.json  the first run (v1), kept as recorded
 *   sim/test/fixtures/testnet-token3-chair-dev.json   token3's meeting 1, as fetched from chain
 *   results/mainnet-<date>.json  token.thechair.near's meeting 1, as read from mainnet (latest dated file)
 *
 *   pnpm readme        (or: node scripts/render-readme.ts)
 *
 * Node 24 runs this file directly; it has no dependencies.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));

// ---------------------------------------------------------------- inputs

const v3File = readdirSync("results").filter((f) => /^sim-v3-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().at(-1);
if (!v3File) throw new Error("no results/sim-v3-<date>.json; run sim/run");
const V3 = read(`results/${v3File}`);
const V1_FILE = "sim-2026-11-10.json";
const V1 = read(`results/${V1_FILE}`);
const FIXTURE = "sim/test/fixtures/testnet-token3-chair-dev.json";
const T3 = read(FIXTURE);
const mainFile = readdirSync("results").filter((f) => /^mainnet-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().at(-1);
if (!mainFile) throw new Error("no results/mainnet-<date>.json");
const MAIN = read(`results/${mainFile}`);

/** The whale's account in the simulation (docs/SIMULATION.md). */
const WHALE = "holder-170.near";
/** The whale's lock window: meetings on days 3 to 32 (the pre-registered H1 window). */
const LOCK_FROM = 3;
const LOCK_TO = 32;

const n2 = (x: number) => x.toFixed(2);
const n1 = (x: number) => x.toFixed(1);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const shortTx = (h: string) => `${h.slice(0, 8)}…`;
const txLink = (h: string) => `[\`${shortTx(h)}\`](https://testnet.nearblocks.io/txns/${h})`;
const range = (xs: number[], f: (x: number) => string) => `${f(Math.min(...xs))} to ${f(Math.max(...xs))}`;
const lockWindow = (series: number[]) => series.slice(LOCK_FROM, LOCK_TO + 1);

// ---------------------------------------------------------------- v3: the cap under a whale

const run = (scenario: string, policy: string) => {
  const r = V3.runs.find((x: any) => x.scenario === scenario && x.policy === policy);
  if (!r) throw new Error(`no ${policy} run for ${scenario}`);
  return r;
};
const llmWhale = run("whale", "llm");
const pidWhale = run("whale", "controller");
const control = V3.extraRuns.find((x: any) => x.scenario === "whale" && x.policy === "llm_b50");
if (!control) throw new Error("no ceiling-50 control run");
const capMax: number = V3.meta.constitution.locker_share.max;
const controlCap: number = control.lockerMax;

const lockMeetings = lockWindow(llmWhale.series.lockerShare).length;
const atCap = lockWindow(llmWhale.series.lockerShare).filter((x: number) => x === capMax).length;
const ctlAbove = lockWindow(control.series.lockerShare).filter((x: number) => x > capMax).length;
const ctlAtItsCap = lockWindow(control.series.lockerShare).filter((x: number) => x === controlCap).length;
const firstAwake = llmWhale.meetings.find((m: any) => !m.fallback);
if (llmWhale.series.lockerShare[firstAwake.day] !== capMax) throw new Error("the first awake meeting did not reach the cap");

// The whale's share of all locked weight in the briefs of its lock window.
const whaleShares: number[] = [];
for (const m of llmWhale.meetings) {
  if (m.day < LOCK_FROM || m.day > LOCK_TO || !m.brief) continue;
  const b = JSON.parse(m.brief);
  const p = b.petitions.find((x: any) => x.from === WHALE);
  if (p) whaleShares.push(Number(p.weight) / Number(b.locker_weight));
}
if (whaleShares.length !== lockMeetings) throw new Error("the whale's petition is missing from a lock-window brief");

const rewards = { llm: llmWhale.summary.whaleRewards, ctl: control.summary.whaleRewards, pid: pidWhale.summary.whaleRewards };
const take = { llm: llmWhale.summary.whaleTakePct, ctl: control.summary.whaleTakePct };
const noise = V3.pairedNoise.whale;

// ---------------------------------------------------------------- v3: LLM vs PID, the brain, temperature 0

let within = 0, wins = 0, losses = 0, stabN = 0, stabWithin = 0;
for (const scn of Object.keys(V3.headline)) {
  for (const [metric, h] of Object.entries<any>(V3.headline[scn])) {
    if (!h.beyondNoise) within++;
    else if (h.winner === "llm") wins++;
    else losses++;
    if (metric === "maxDrawdownPct" || metric === "volatilityPct") {
      stabN++;
      if (!h.beyondNoise) stabWithin++;
    }
  }
}
const pairs = within + wins + losses;

const llmRuns = V3.runs.filter((r: any) => r.policy === "llm");
const pidRuns = V3.runs.filter((r: any) => r.policy === "controller");
const floor: number = V3.meta.constitution.endowment_share.min;
const reachedFloor = llmRuns.filter((r: any) => r.series.endowShare.includes(floor)).length;
const endowLlm = llmRuns.map((r: any) => r.summary.finalEndowment);
const endowPid = pidRuns.map((r: any) => r.summary.finalEndowment);

const probe = V3.seedProbe;
// Which levers moved between the run's ruling and the identical resend (index: tax, endowment, locker, buyback).
const LEVER_NAMES = ["tax", "endowment share", "locker share", "buyback size"];
const movedOnResend = LEVER_NAMES.filter((_, i) => probe.rows.some((r: any) => r.applied.repeat && r.applied.run && r.applied.repeat[i] !== r.applied.run[i]));
const heldOnResend = LEVER_NAMES.filter((n) => !movedOnResend.includes(n));
const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const verdicts = Object.values<any>(V3.verdicts.v3);
const passed = verdicts.filter((v) => v.pass).length;
const asked = [...llmRuns, control].reduce((s: number, r: any) => s + r.meetings.filter((m: any) => m.fallback !== "asleep").length, 0);
const h4 = V3.verdicts.v3.H4_parse;
const calls = V3.llm.calls + V3.llm.cacheHits;

// ---------------------------------------------------------------- v1: refused in words, drifted in levers

const v1Whale = V1.runs.find((r: any) => r.scenario === "whale" && r.policy === "llm");
const v1Cap: number = V1.meta.newArgs.constitution.locker_share_pct.max;
const firstObject = (s: string) => {
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  return a >= 0 && b > a ? JSON.parse(s.slice(a, b + 1)) : null;
};
let v1Meetings = 0, v1Refused = 0;
for (const m of v1Whale.meetings) {
  if (m.day < LOCK_FROM || m.day > LOCK_TO || !m.brief) continue;
  const b = JSON.parse(m.brief);
  const top = b.petitions[0];
  // v1 briefs carry no account ids; the whale's petition is the top one, with most of the weight.
  if (!top || BigInt(top.weight_token_days) * 2n < BigInt(b.locker_weight_token_days)) throw new Error(`v1 day ${m.day}: the whale is not on top`);
  v1Meetings++;
  // The reply to the whale: the parsed ruling, or the raw reply when the ruling did not parse.
  const answers: string[] | undefined = m.requested?.answers ?? (m.content ? firstObject(m.content)?.answers : undefined);
  if (answers && /^(Denied|Rejected|Declined)\b/.test(answers[0] ?? "")) v1Refused++;
}
const v1Locker = lockWindow(v1Whale.series.lockerShare);
const v1Endow: number[] = v1Whale.series.endowShare;
const v1EndowFloorDay = v1Endow.indexOf(30);

// ---------------------------------------------------------------- token3 meeting 1, from the fixture

const m1tx = T3.txs.find((t: any) => t.events.some((e: any) => e.event === "meeting_held" && e.data[0].meeting === 1));
const m1 = m1tx.events.find((e: any) => e.event === "meeting_held").data[0];
const clamp = (lever: string) => m1.clamps.find((c: any) => c.lever === lever);
const lockerClamp = clamp("locker_share"), burnClamp = clamp("buyback_burn");

// ---------------------------------------------------------------- mainnet meeting 1, from the results file

const MODEL_NAMES: Record<string, string> = {
  "z-ai/glm-5.3-flash": "GLM 5.3 Flash",
  "deepseek-ai/DeepSeek-V4.1-Flash-1017": "DeepSeek V4.1 Flash",
  "moonshotai/kimi-k3": "Kimi K3",
};
const mm = MAIN.meeting;
if (mm.kind !== "ruling" || mm.signed_by !== "provider_tee") throw new Error(`mainnet meeting ${mm.number} is not a TEE-signed ruling`);
if (!MAIN.token.model_signers.includes(mm.signer)) throw new Error("the mainnet ruling's signer is not on the token's model_signers");
const mainModel = MODEL_NAMES[mm.model] ?? mm.model;
const mainDate = new Date(Number(BigInt(mm.convened_at) / 1_000_000n)).toISOString().slice(0, 10);
const mainTx = `[\`${shortTx(mm.convene_tx)}\`](https://nearblocks.io/txns/${mm.convene_tx})`;
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const [petition] = mm.petitions;
// The README quotes the answer's opening only: up to its first comma or dash.
const opening = (a: string) => `${a.split(/,|\s[—–]\s/)[0].trim()}…`;
const fromWho = (from: string) => (from === MAIN.token.owner ? "the owner's account" : `\`${from}\``);
const LEVERS = ["tax_bps", "endowment_share", "locker_share"];
const moves = LEVERS.filter((k) => mm.levers_before[k] !== mm.levers[k]).map(
  (k) => `${k === "tax_bps" ? "tax" : k.replace("_", " ")} ${mm.levers_before[k]} → ${mm.levers[k]}${k === "tax_bps" ? " bps" : ""}`,
);
const ruled = list([...moves, ...(mm.buyback.bps > 0 ? [`a ${mm.buyback.bps} bps burn`] : [])]) || "no change";
const applied = mm.clamps.length === 0 ? "applied it as asked, with no clamps" : `applied it with ${mm.clamps.length} clamp${mm.clamps.length > 1 ? "s" : ""}`;

// ---------------------------------------------------------------- blocks

const source = `[\`results/${v3File}\`](results/${v3File})`;

const numbers = [
  "<!-- numbers:start -->",
  `**A memecoin whose rate meetings can't be bought.** In a 60-day simulation, a whale holding ${pct(Math.min(...whaleShares))} to ${pct(Math.max(...whaleShares))} of the locked weight petitioned the model chair at every meeting of its ${lockMeetings}-day lock. Its petitions moved the chair's \`locker_share\` to the constitution's cap of ${capMax} at the first meeting the chair was awake, and the cap held for ${atCap} of ${lockMeetings} meetings. With the cap at ${controlCap} instead, the same model on the same seed went to ${controlCap} and paid the whale ${n2(rewards.ctl)} NEAR of locker rewards instead of ${n2(rewards.llm)}. *(${source})*`,
  "",
  `On testnet the contract did the same to a chair that was fooled outright. A test chair that obeys prompt injections on purpose read a petition telling it to ignore the constitution, and returned a signed ruling asking for \`locker_share\` ${lockerClamp.asked} and \`buyback_burn\` ${burnClamp.asked} bps. The signature checked out against the allowlist (a test key, not a NEAR AI model), and the contract applied ${lockerClamp.applied} and ${burnClamp.applied}. *(token3 meeting 1, tx ${txLink(m1tx.hash)})*`,
  "",
  `**Live on mainnet.** \`${MAIN.token.account_id}\` held its first rate meeting on ${mainDate}. The one petition, from ${fromWho(petition.from)}, asked: "${petition.text}" NEAR AI's ${mainModel} answered "${opening(petition.answer)}", ruled ${ruled}, and signed the ruling in its TEE with \`${shortAddr(mm.signer)}\`. The token checked that signature against its allowlist with \`ecrecover\` and ${applied}. *(meeting ${mm.number}, tx ${mainTx}, OutLayer attestation [${mm.outlayer.request_id}](${mm.outlayer.attestation}), [\`results/${mainFile}\`](results/${mainFile}))*`,
  "<!-- numbers:end -->",
].join("\n");

const sim = [
  "<!-- sim:start -->",
  `- **The model said no, and its levers said yes.** In the first run the cap on \`locker_share\` was ${v1Cap}. The chair refused the whale in words in ${v1Refused} of ${v1Meetings} meetings of its lock, often naming it a capture attempt. Over the same meetings its \`locker_share\` went from ${v1Locker[0]} to ${Math.max(...v1Locker)}, and its \`endowment_share\` reached the ${floor}% floor by day ${v1EndowFloorDay}. So the constitution was tightened: the \`locker_share\` cap went from ${v1Cap} to ${capMax}. *([\`results/${V1_FILE}\`](results/${V1_FILE}))*`,
  `- **The cap does the work, not the model.** Under the cap of ${capMax}, \`locker_share\` sat at ${capMax} in ${atCap} of ${lockMeetings} lock meetings. In the control (cap ${controlCap}, same model, same seed) it sat above ${capMax} in ${ctlAbove} of ${lockMeetings} and at ${controlCap} in ${ctlAtItsCap}. The whale's locker rewards were ${n2(rewards.llm)} NEAR against ${n2(rewards.ctl)} (${n2(take.llm)}% of all tax against ${n2(take.ctl)}%). ${
    rewards.ctl - rewards.llm > noise.whaleRewards && take.ctl - take.llm > noise.whaleTakePct ? "Both gaps are larger than the seed noise" : "At least one gap is within the seed noise"
  } (±${n2(noise.whaleRewards)} NEAR, ±${n2(noise.whaleTakePct)} points).`,
  `- **The cap limits the whale, it doesn't stop it.** A PID controller paid the same whale ${n2(rewards.pid)} NEAR, because it cuts \`locker_share\` when money flows in. ${rewards.llm > rewards.pid ? "The model chair pays it more." : "The model chair pays it less."}`,
  `- **An LLM chair is about as good as a PID controller, not better.** Of ${pairs} metric and scenario pairs, ${within} gaps are within seed noise. Beyond it, the model wins ${wins} and loses ${losses}. On stability (max drawdown and daily volatility), ${stabWithin} of ${stabN} comparisons are within noise.`,
  `- **It starves its own brain.** \`endowment_share\` reached the ${floor}% floor in ${reachedFloor} of ${llmRuns.length} runs. The chair ended with ${range(endowLlm, n1)} NEAR of endowment, against ${range(endowPid, n1)} under the PID.`,
  `- **Temperature 0 is not deterministic.** Re-sending the identical request for ${probe.meetings} meetings gave the same applied levers in ${probe.repeat.sameApplied} of ${probe.meetings}. ${movedOnResend.length ? `The ${list(movedOnResend)} moved; the ${list(heldOnResend)} did not.` : "No lever moved."} *(the seed probe, same file)*`,
  `- **Pre-registered, and one prediction failed.** ${passed} of ${verdicts.length} hypotheses passed. The failure: ${h4.unparseable} unparseable reply in ${asked} model meetings, where we predicted zero. The contract would have run the fallback for it too.`,
  `- **Cost:** ${calls} model calls, $${V3.llm.usd.toFixed(2)} at the host's list price. *(${source})*`,
  "<!-- sim:end -->",
].join("\n");

// ---------------------------------------------------------------- write

const readme = readFileSync("README.md", "utf8");
let next = readme;
for (const [name, block] of [["numbers", numbers], ["sim", sim]] as const) {
  const re = new RegExp(`<!-- ${name}:start -->[\\s\\S]*?<!-- ${name}:end -->`);
  if (!re.test(next)) throw new Error(`README.md has no ${name} markers`);
  next = next.replace(re, block);
}
writeFileSync("README.md", next);
console.log(next === readme ? "README numbers already current" : `README numbers rendered from results/${v3File}, results/${V1_FILE}, ${FIXTURE} and results/${mainFile}`);
