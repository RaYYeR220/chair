import { type PreviewView, toPreviewView } from "@/lib/views";

/** Browser calls to the app's own API. Every helper resolves to a result, never throws. */

export type Result<T> = { ok: true; data: T } | { ok: false; error: string; status?: number; body?: Record<string, unknown> };

async function call<T>(url: string, init?: RequestInit, timeoutMs = 30_000): Promise<Result<T>> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok || !body || body.ok === false) {
      const why = typeof body?.error === "string" ? body.error : `request failed (${res.status})`;
      const retry = typeof body?.retry_after_s === "number" ? ` Try again in ${body.retry_after_s} s.` : "";
      return { ok: false, error: `${why}.${retry}`.replace(/\.\./, "."), status: res.status, body: body ?? undefined };
    }
    return { ok: true, data: body as T };
  } catch (e) {
    const err = e as Error;
    return { ok: false, error: err.name === "TimeoutError" ? "testnet took too long to answer" : "couldn’t reach the server" };
  }
}

export const getJson = <T>(url: string, timeoutMs?: number) => call<T>(url, undefined, timeoutMs);

export const postJson = <T>(url: string, body: unknown, timeoutMs?: number) =>
  call<T>(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, timeoutMs);

/** POST /api/preview, flattened for display. */
export async function runPreview(body: Record<string, unknown>): Promise<Result<PreviewView>> {
  const r = await postJson<Parameters<typeof toPreviewView>[0]>("/api/preview", body);
  return r.ok ? { ok: true, data: toPreviewView(r.data) } : r;
}
