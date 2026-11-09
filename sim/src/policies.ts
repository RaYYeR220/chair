// The four chairs. Every ruling goes through the same constitution (Chair.hold → clampRuling).
import { CFG } from "./config.ts";
import { type Chair, type Ruling, type FallbackReason, ladderModel, toNear } from "./token.ts";
import { buildBrief, buildRequest } from "./prompt.ts";
import type { LlmClient } from "./llm.ts";

export interface Decision {
  ruling: Ruling | null; // null → the fallback rule runs
  reason: FallbackReason | "fixed_rule" | null;
  model?: string | null;
  llm?: { requestSha256: string; cached: boolean; promptTokens: number; completionTokens: number; usd: number; content: string; error?: string };
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

/** Contract check 3: the content must parse as a ruling. Mirrors what the contract accepts. */
export function parseRuling(content: string): Ruling | null {
  let t = content.trim();
  const fence = t.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fence) t = fence[1].trim();
  let j: any;
  try { j = JSON.parse(t); } catch { return null; }
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  for (const f of ["tax_bps", "endowment_share", "locker_share", "buyback_burn"]) if (!Number.isInteger(j[f])) return null;
  if (typeof j.minutes !== "string") return null;
  if (!Array.isArray(j.answers) || j.answers.length !== 3 || !j.answers.every((x: unknown) => typeof x === "string")) return null;
  return { tax_bps: j.tax_bps, endowment_share: j.endowment_share, locker_share: j.locker_share, buyback_burn: j.buyback_burn, minutes: j.minutes, answers: j.answers };
}

/** (d) LLM chair: the real meeting request to the model the IQ ladder selects. */
export function llmPolicy(client: LlmClient): Policy {
  return {
    key: "llm", name: "LLM chair",
    async decide(c: Chair) {
      const model = ladderModel(c.brainReported);
      if (!model) return { ruling: null, reason: "asleep", model: null };
      const body = buildRequest(model, buildBrief(c));
      const res = await client.complete(body);
      const llm = { requestSha256: res.key, cached: res.cached, promptTokens: res.promptTokens, completionTokens: res.completionTokens, usd: res.usd, content: res.content ?? "", error: res.error };
      if (res.error || res.content == null) return { ruling: null, reason: "unsigned", model, llm };
      const ruling = parseRuling(res.content);
      if (!ruling) return { ruling: null, reason: "unparseable", model, llm };
      return { ruling, reason: null, model, llm };
    },
  };
}
