// Counter-based RNG: every draw is a pure hash of (seed, keys...). The same agent on the same
// day draws the same numbers under every policy (common random numbers), so differences
// between policies come from the policy, not from a diverged random stream.

function mix32(a: number): number {
  a = Math.imul(a ^ (a >>> 16), 0x85ebca6b);
  a = Math.imul(a ^ (a >>> 13), 0xc2b2ae35);
  return (a ^ (a >>> 16)) >>> 0;
}

export function u(seed: number, ...keys: number[]): number {
  let h = mix32((seed | 0) ^ 0x9e3779b9);
  for (const k of keys) h = mix32((h + Math.imul((k | 0) ^ 0x7f4a7c15, 0x27d4eb2d)) >>> 0);
  return mix32(h ^ 0x165667b1) / 4294967296;
}

/** Standard normal via Box–Muller from two counter draws. */
export function gauss(seed: number, ...keys: number[]): number {
  const a = Math.max(u(seed, ...keys, 1), 1e-12);
  const b = u(seed, ...keys, 2);
  return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * b);
}

export function pick<T>(xs: T[], r: number): T { return xs[Math.min(xs.length - 1, Math.floor(r * xs.length))]; }
