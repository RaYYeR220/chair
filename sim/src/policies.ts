// The four chairs. Every ruling goes through the same constitution (Chair.hold → clampRuling).
import { createHash } from "node:crypto";
import { CFG } from "./config.ts";
import { type Chair, type Ruling, type FallbackReason, ladderModel, toNear } from "./token.ts";
import { SYSTEM_PROMPT, buildBrief, buildRequest } from "./prompt.ts";
import type { LlmClient } from "./llm.ts";

export interface Decision {
  ruling: Ruling | null; // null → the fallback rule runs
  reason: FallbackReason | "fixed_rule" | null;
  model?: string | null;
  brief?: string;
  llm?: { requestSha256: string; cacheKey: string; cached: boolean; promptTokens: number; completionTokens: number; usd: number; content: string; error?: string };
}

export interface Policy {
  key: string;
  name: string;
  decide(chair: Chair, day: number): Promise<Decision>;
}

/** (a) No central bank: levers frozen at launch, no buybacks. */
export function nonePolicy(): Policy {
  return {
    key: "none", name: "None (frozen)",
    async decide() {
      return { ruling: { ...CFG.launch, buyback_burn: 0 }, reason: null };
    },
  };
}

/** (b) Fixed rule: the SPEC fallback every meeting. */
export function fixedPolicy(): Policy {
  return { key: "fixed", name: "Fixed rule (fallback)", async decide() { return { ruling: null, reason: "fixed_rule" }; } };
}

/**
 * (c) Simple controller: PID on the 24 h net flow plus a proportional term on the backing ratio.
 * Outflow → raise tax, buy back, pay lockers more, fund the brain less. Inflow → the reverse.
 * Targets are raw; the constitution rate-limits them like any other ruling.
 */
export function controllerPolicy(): Policy {
  let integ = 0;
  let prevE = 0;
  const Kp = 0.8, Ki = 0.15, Kd = 0.3, BR_TARGET = 0.6;
  return {
    key: "controller", name: "PID controller",
    async decide(c: Chair) {
      const buy = toNear(c.volBuy), sell = toNear(c.volSell);
      const nf = buy + sell > 0 ? (buy - sell) / (buy + sell) : 0;
      const e = -nf; // > 0 on net outflow
      integ = Math.max(-3, Math.min(3, 0.7 * integ + e));
      const de = e - prevE;
      prevE = e;
      const ctl = Math.max(-1, Math.min(1, Kp * e + Ki * integ + Kd * de));
      const price = toNear(c.price());
      const br = price > 0 ? toNear(c.floor()) / price : 1;
      const gap = Math.max(0, BR_TARGET - br) / BR_TARGET;
      return {
        ruling: {
          tax_bps: Math.round(200 + 100 * ctl),
          endowment_share: Math.round(50 - 20 * ctl),
          locker_share: Math.round(20 + 20 * ctl),
          buyback_burn: Math.round(50 * Math.min(1, Math.max(0, ctl) + 2 * gap)),
        },
        reason: null,
      };
    },
  };
}

/** `extract_object`: the whole trimmed content if it is a JSON object, else the first '{' to the last '}'. */
function extractObject(content: string): Record<string, unknown> | null {
  const obj = (t: string) => {
    try { const v = JSON.parse(t); return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null; } catch { return null; }
  };
  const whole = obj(content.trim());
  if (whole) return whole;
  const a = content.indexOf("{"), b = content.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  return obj(content.slice(a, b + 1));
}

const I64_MAX = 9223372036854775807, I64_MIN = -9223372036854775808;
/** `int_field`: an integral JSON number (saturating at the i64 range); fractions, strings, missing fail. */
function intField(m: Record<string, unknown>, k: string): number | null {
  const v = m[k];
  if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) return null;
  return Math.max(I64_MIN, Math.min(I64_MAX, v));
}

/** Contract check 3 (`parse_ruling`) on the message content, for a brief with `petitions` petitions. */
export function parseRuling(content: string, petitions: number): Ruling | null {
  const m = extractObject(content);
  if (!m) return null;
  const tax_bps = intField(m, "tax_bps"), endowment_share = intField(m, "endowment_share");
  const locker_share = intField(m, "locker_share"), buyback_burn = intField(m, "buyback_burn");
  if (tax_bps === null || endowment_share === null || locker_share === null || buyback_burn === null) return null;
  if (typeof m.minutes !== "string") return null;
  let answers: string[];
  if (!("answers" in m)) {
    if (petitions !== 0) return null;
    answers = [];
  } else {
    if (!Array.isArray(m.answers) || m.answers.length < petitions) return null;
    const first = m.answers.slice(0, petitions);
    if (!first.every((x) => typeof x === "string")) return null;
    answers = first as string[];
  }
  return { tax_bps, endowment_share, locker_share, buyback_burn, minutes: m.minutes, answers };
}

/** (d) LLM chair: the real meeting request to the model the IQ ladder selects. */
export function llmPolicy(client: LlmClient, opts: { key?: string; name?: string; systemPrompt?: string } = {}): Policy {
  const systemPrompt = opts.systemPrompt ?? SYSTEM_PROMPT;
  return {
    key: opts.key ?? "llm", name: opts.name ?? "LLM chair",
    async decide(c: Chair) {
      const model = ladderModel(c.brainReported);
      if (!model) return { ruling: null, reason: "asleep", model: null };
      const brief = buildBrief(c);
      const request = buildRequest(model, brief, systemPrompt);
      const requestSha256 = createHash("sha256").update(request).digest("hex");
      const res = await client.complete(request);
      const llm = { requestSha256, cacheKey: res.key, cached: res.cached, promptTokens: res.promptTokens, completionTokens: res.completionTokens, usd: res.usd, content: res.content ?? "", error: res.error };
      if (res.error || res.content == null) return { ruling: null, reason: "unsigned", model, brief, llm };
      const ruling = parseRuling(res.content, c.topPetitions().length);
      if (!ruling) return { ruling: null, reason: "unparseable", model, brief, llm };
      return { ruling, reason: null, model, brief, llm };
    },
  };
}
