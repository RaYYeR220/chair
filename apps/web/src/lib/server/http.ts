import "server-only";
import { RpcError } from "./rpc";

/** Cache-Control presets. CDN caching (`s-maxage`) is shared across server instances. */
export const CACHE = {
  none: "no-store",
  live: "public, max-age=0, s-maxage=2, stale-while-revalidate=10",
  short: "public, max-age=0, s-maxage=5, stale-while-revalidate=30",
  /** A held or lapsed meeting never changes. */
  forever: "public, max-age=3600, s-maxage=31536000, immutable",
} as const;

export function json(data: unknown, init: { status?: number; cache?: string } = {}) {
  return Response.json(data, {
    status: init.status ?? 200,
    headers: { "cache-control": init.cache ?? CACHE.none },
  });
}

/** Errors with a `status` keep it; contract panics are 422 with their text; anything else 502. */
export function fail(e: unknown) {
  const err = e as Error & { status?: number; extra?: Record<string, unknown> };
  if (typeof err?.status === "number") {
    return json({ ok: false, error: err.message, ...(err.extra ?? {}) }, { status: err.status });
  }
  if (e instanceof RpcError) {
    return json({ ok: false, error: e.message }, { status: e.kind === "ContractPanic" ? 422 : 502 });
  }
  return json({ ok: false, error: err?.message ?? String(e) }, { status: 502 });
}

export async function readJson(req: Request, maxBytes = 128 * 1024): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > maxBytes) throw Object.assign(new Error(`body over ${maxBytes} bytes`), { status: 413 });
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw Object.assign(new Error("body must be a JSON object"), { status: 400 });
}
