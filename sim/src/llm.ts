// OpenAI-compatible client for Venice AI with a content-addressed response cache.
// Cache key = sha256 of the exact bytes sent to Venice; reruns replay the cache and cost nothing.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CFG, SIM_DIR } from "./config.ts";

export interface LlmResult {
  key: string;
  cached: boolean;
  content: string | null;
  promptTokens: number;
  completionTokens: number;
  usd: number;
  error?: string;
}

export interface LlmStats { calls: number; cacheHits: number; errors: number; promptTokens: number; completionTokens: number; usd: number; byModel: Record<string, { calls: number; promptTokens: number; completionTokens: number; usd: number }> }

export const CACHE_DIR = join(SIM_DIR, "cache", "llm");

/** The API key comes from the environment, or from sim/.env (VENICE_API_KEY=...). Never logged. */
function readKey(): string | null {
  if (process.env.VENICE_API_KEY) return process.env.VENICE_API_KEY.trim();
  const file = join(SIM_DIR, ".env");
  if (!existsSync(file)) return null;
  const line = readFileSync(file, "utf8").split(/\r?\n/).find((l) => l.startsWith("VENICE_API_KEY="));
  const v = line?.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
  return v || null;
}

/** The body sent to Venice: the contract's request with Venice's model id, and Venice's own system prompt off. */
export function veniceBody(request: string): string {
  const body = JSON.parse(request);
  const vm = CFG.venice.model_map[body.model];
  if (!vm) throw new Error(`no Venice mapping for ${body.model}`);
  return JSON.stringify({ ...body, model: vm, venice_parameters: { include_venice_system_prompt: false } });
}

export class LlmClient {
  stats: LlmStats = { calls: 0, cacheHits: 0, errors: 0, promptTokens: 0, completionTokens: 0, usd: 0, byModel: {} };
  private key: string | null = null;
  constructor(private opts: { offline: boolean; maxCalls: number; retryErrors: boolean; log?: (s: string) => void }) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }

  /** API calls this client may still make. */
  remaining(): number { return this.opts.maxCalls - this.stats.calls; }

  /** True if this exact request is already cached. */
  isCached(request: string): boolean {
    const file = join(CACHE_DIR, `${createHash("sha256").update(veniceBody(request)).digest("hex")}.json`);
    if (!existsSync(file)) return false;
    return !JSON.parse(readFileSync(file, "utf8")).error || !this.opts.retryErrors;
  }

  private account(vm: string, pt: number, ct: number): number {
    const p = CFG.venice.usd_per_mtok[vm] ?? { input: 0, output: 0 };
    const usd = (pt * p.input + ct * p.output) / 1e6;
    const m = (this.stats.byModel[vm] ??= { calls: 0, promptTokens: 0, completionTokens: 0, usd: 0 });
    m.calls++; m.promptTokens += pt; m.completionTokens += ct; m.usd += usd;
    this.stats.promptTokens += pt; this.stats.completionTokens += ct; this.stats.usd += usd;
    return usd;
  }

  /** `request` is the contract's exact request bytes. */
  async complete(request: string): Promise<LlmResult> {
    const bytes = veniceBody(request);
    const key = createHash("sha256").update(bytes).digest("hex");
    const file = join(CACHE_DIR, `${key}.json`);
    const vm = JSON.parse(bytes).model as string;
    if (existsSync(file)) {
      const hit = JSON.parse(readFileSync(file, "utf8"));
      if (!hit.error || !this.opts.retryErrors) {
        this.stats.cacheHits++;
        const usage = hit.usage ?? {};
        const usd = this.account(vm, usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0);
        return { key, cached: true, content: hit.content ?? null, promptTokens: usage.prompt_tokens ?? 0, completionTokens: usage.completion_tokens ?? 0, usd, error: hit.error };
      }
    }
    if (this.opts.offline) return { key, cached: false, content: null, promptTokens: 0, completionTokens: 0, usd: 0, error: "offline: not in cache" };
    if (this.stats.calls >= this.opts.maxCalls) return { key, cached: false, content: null, promptTokens: 0, completionTokens: 0, usd: 0, error: "call budget exhausted" };
    this.key ??= readKey();
    if (!this.key) return { key, cached: false, content: null, promptTokens: 0, completionTokens: 0, usd: 0, error: "no VENICE_API_KEY" };

    this.stats.calls++;
    let lastErr = "";
    for (let attempt = 0; attempt < 4; attempt++) {
      const t0 = Date.now();
      try {
        const res = await fetch(`${CFG.venice.base_url}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.key}` },
          body: bytes,
          signal: AbortSignal.timeout(300_000),
        });
        const text = await res.text();
        if (!res.ok) {
          lastErr = `http ${res.status}: ${text.slice(0, 300)}`;
          if (res.status === 429 || res.status >= 500) { await sleep(5000 * 3 ** attempt); continue; }
          break;
        }
        const j = JSON.parse(text);
        const content: string | null = j.choices?.[0]?.message?.content ?? null;
        const usage = j.usage ?? {};
        const rec = { request_sha256: key, venice_model: vm, at: new Date().toISOString(), latency_ms: Date.now() - t0, usage, content, response_text: text };
        writeFileSync(file, JSON.stringify(rec, null, 1));
        const usd = this.account(vm, usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0);
        this.opts.log?.(`llm ${vm} ${key.slice(0, 10)} ${Date.now() - t0}ms in=${usage.prompt_tokens} out=${usage.completion_tokens}`);
        return { key, cached: false, content, promptTokens: usage.prompt_tokens ?? 0, completionTokens: usage.completion_tokens ?? 0, usd };
      } catch (e) {
        lastErr = String((e as Error).message ?? e);
        await sleep(5000 * 3 ** attempt);
      }
    }
    this.stats.errors++;
    writeFileSync(file, JSON.stringify({ request_sha256: key, venice_model: vm, at: new Date().toISOString(), error: lastErr }, null, 1));
    this.opts.log?.(`llm ${vm} ${key.slice(0, 10)} ERROR ${lastErr}`);
    return { key, cached: false, content: null, promptTokens: 0, completionTokens: 0, usd: 0, error: lastErr };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
