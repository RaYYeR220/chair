/** Display helpers shared by the landing and the app. */

/** `0x1234ab…cdef`: the head and tail of a hash or address. */
export const sh = (h: string | null | undefined, a = 8, b = 4) => (h && h.length > a + b + 1 ? `${h.slice(0, a)}…${h.slice(-b)}` : (h ?? ""));

/** A weight in CHAIR-days: 10.5M, 1.41M, 500K. */
export function fmtW(w: number): string {
  if (w >= 1e9) return `${parseFloat((w / 1e9).toFixed(w >= 1e10 ? 1 : 2))}B`;
  if (w >= 1e6) return `${parseFloat((w / 1e6).toFixed(w >= 1e7 ? 1 : 2))}M`;
  if (w >= 1e3) return `${Math.round(w / 1e3)}K`;
  return String(Math.round(w));
}

/** A share as a percentage with one decimal: 84.6%. */
export const pct1 = (part: number, whole: number) => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "–");

/** NEAR with a sensible number of decimals for its size. */
export function fmtNear(n: number | string): string {
  const x = typeof n === "string" ? Number(n) : n;
  if (!Number.isFinite(x)) return "–";
  if (x === 0) return "0";
  const d = x >= 100 ? 2 : x >= 1 ? 4 : x >= 0.01 ? 4 : 6;
  return x.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: 0 });
}

/** Human names for the IQ ladder's models. */
const MODEL_NAMES: Record<string, string> = {
  "z-ai/glm-5.3-flash": "GLM-5.3-flash",
  "deepseek-ai/DeepSeek-V4.1-Flash-1017": "DeepSeek-V4.1-Flash",
  "moonshotai/kimi-k3": "Kimi K3",
};
export const modelName = (m: string | null | undefined) => (m ? (MODEL_NAMES[m] ?? m) : "asleep");

/** `Nov 10, 03:17 UTC`. */
export function utc(msEpoch: number): string {
  const d = new Date(msEpoch);
  return `${d.toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}, ${d.toISOString().slice(11, 16)} UTC`;
}

/** `4:05` or `1:02:03` from seconds. */
export function clock(s: number): string {
  const t = Math.max(0, Math.round(s));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), x = t % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`;
}

/** The account without its network suffix. */
export const acct = (a: string) => a.replace(/\.testnet$/, "");

/** First sentence, clipped at `n` characters on a word. */
export function firstSentence(a: string | null | undefined, n = 118): string | null {
  if (!a) return null;
  let s = a.split(/(?<=[.!?])\s+/)[0];
  let cut = false;
  const d = s.search(/\s[—–]\s/);
  if (d > 0) {
    s = s.slice(0, d);
    cut = true;
  }
  if (s.length > n) {
    s = s.slice(0, s.lastIndexOf(" ", n));
    cut = true;
  }
  return s.replace(/[,;:]$/, "") + (cut ? "…" : "");
}

export const trim = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, s.lastIndexOf(" ", n - 1)).replace(/[,;:.\s]+$/, "")}…`);

/** Signature check results in plain words. */
export const CHECK_LABEL: Record<string, string> = {
  provider_tee: "signed in the provider-TEE format by an allowlisted key",
  gateway: "signed by an allowlisted gateway key",
  bad_signature: "bad signature: the signer is not on the allowlist",
  bad_hash: "bad hash: the signed text does not match the response",
  unsigned: "unsigned: no signature came back",
  unparseable: "unparseable: no ruling object in the reply",
  lapsed: "lapsed: no result before the next meeting",
  asleep: "asleep: the brain had no model to ask",
  pending: "pending: the courier has not answered yet",
};

export const REPO = "https://github.com/RaYYeR220/chair";
export const BLINDBOOK = "https://github.com/RaYYeR220/blindbook";
