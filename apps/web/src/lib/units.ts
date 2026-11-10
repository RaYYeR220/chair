/**
 * Unit conversions shared by the server and the browser. Amounts on chain are
 * decimal strings: NEAR in yoctoNEAR (10^24), CHAIR in base units (10^18).
 */

/** Exact decimal of `v / 10^decimals`, trailing zeros trimmed (as the contract's `decimal`). */
export function decimal(v: string | bigint, decimals: number): string {
  const s = BigInt(v).toString();
  const neg = s.startsWith("-");
  const digits = neg ? s.slice(1) : s;
  const padded = digits.padStart(decimals + 1, "0");
  const int = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return `${neg ? "-" : ""}${int}${frac ? `.${frac}` : ""}`;
}

export const near = (yocto: string | bigint) => decimal(yocto, 24);
export const tokens = (base: string | bigint) => decimal(base, 18);
