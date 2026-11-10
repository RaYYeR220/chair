import { ImageResponse } from "next/og";

export const alt =
  "CHAIR: lockers drawn as dots sized by weight, each joined by a hairline to the Chair, whose ring caps the locker share at 25%. “Petition the Chair. It has to answer.”";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const GROUND = "#fbfaf7";
const INK = "#111014";
const VIOLET = "#5e45d8";

/** A Google font as TTF (served to clients that don't ask for woff2); null if it can't be fetched. */
async function googleFont(query: string): Promise<ArrayBuffer | null> {
  try {
    const css = await fetch(`https://fonts.googleapis.com/css2?${query}&display=swap`, { signal: AbortSignal.timeout(8_000) }).then((r) => r.text());
    const url = /src: url\((https:[^)]+\.ttf)\)/.exec(css)?.[1];
    return url ? await fetch(url, { signal: AbortSignal.timeout(8_000) }).then((r) => r.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

/** Fetched on the first render and kept for the life of the server (never at module load: that would block the prerender). */
let fonts: Promise<[ArrayBuffer | null, ArrayBuffer | null]> | null = null;

/** Mulberry32, so the field is the same on every render. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The hero in one frame: the field of lockers, their hairlines into the Chair, and the 25% gauge. */
export default async function Image() {
  fonts ??= Promise.all([googleFont("family=Bricolage+Grotesque:opsz,wght@96,600"), googleFont("family=Instrument+Sans:wght@500")]);
  const [display, sans] = await fonts;
  const W = size.width, H = size.height;
  const cx = W / 2, cy = 520, GR = 30;
  const R = rng(20261110);
  // the whale and the heaviest lockers sit where the hero places them; the rest are small and illustrative
  const dots: { x: number; y: number; r: number; dark: boolean }[] = [
    { x: 175, y: 440, r: 44, dark: true },
    { x: 1040, y: 330, r: 18, dark: true },
    { x: 800, y: 420, r: 6, dark: true },
  ];
  for (let i = 0; i < 22; i++) {
    const x = 60 + R() * (W - 120), y = 60 + R() * 380;
    if (Math.abs(x - cx) < 330 && y > 120 && y < 400) continue;
    dots.push({ x, y, r: 2.5 + Math.pow(R(), 3) * 9, dark: false });
  }
  const path = (x: number, y: number) =>
    `M${x} ${y} C${x} ${y + (cy - y) * 0.55} ${cx + (x - cx) * 0.16} ${cy - Math.max(40, Math.min(150, (cy - y) * 0.6))} ${cx} ${cy}`;
  const a0 = -Math.PI / 2, aB = a0 + Math.PI / 2;
  const arc = (from: number, to: number) =>
    `M${cx + Math.cos(from) * GR} ${cy + Math.sin(from) * GR} A${GR} ${GR} 0 ${to - from > Math.PI ? 1 : 0} 1 ${cx + Math.cos(to) * GR} ${cy + Math.sin(to) * GR}`;

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", position: "relative", background: GROUND }}>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ position: "absolute", left: 0, top: 0 }}>
          {dots.map((d, i) => (
            <path key={`p${i}`} d={path(d.x, d.y)} fill="none" stroke={INK} strokeOpacity={d.dark ? (i === 0 ? 0.55 : 0.35) : 0.1} strokeWidth={d.dark && i === 0 ? 1.4 : 1} />
          ))}
          {dots.map((d, i) => (
            <circle key={`c${i}`} cx={d.x} cy={d.y} r={d.r} fill={GROUND} stroke={INK} strokeOpacity={d.dark ? 0.7 : 0.4} strokeWidth={1} />
          ))}
          <circle cx={dots[0].x} cy={dots[0].y} r={dots[0].r * 0.62} fill="none" stroke={INK} strokeOpacity={0.1} />
          <circle cx={cx} cy={cy} r={GR + 6} fill={GROUND} />
          <circle cx={cx} cy={cy} r={GR} fill="none" stroke={INK} strokeOpacity={0.2} />
          <path d={arc(aB, a0 + Math.PI * 2 - 0.0001)} fill="none" stroke={VIOLET} strokeOpacity={0.5} strokeWidth={1.4} strokeDasharray="2 3" />
          <path d={arc(a0, aB)} fill="none" stroke={VIOLET} strokeWidth={3.4} />
          <path d={`M${cx + GR - 7} ${cy} L${cx + GR + 7} ${cy}`} stroke={INK} strokeOpacity={0.85} strokeWidth={1.6} />
          <circle cx={cx} cy={cy} r={10} fill="none" stroke={VIOLET} strokeWidth={1.6} />
          <circle cx={cx} cy={cy} r={3.4} fill={VIOLET} />
        </svg>
        <div style={{ position: "absolute", left: 0, right: 0, top: 92, display: "flex", flexDirection: "column", alignItems: "center", color: INK }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, fontFamily: "Instrument Sans", fontSize: 24, color: "#47444f" }}>
            <svg width="26" height="26" viewBox="0 0 20 20">
              <circle cx="10" cy="10" r="8.2" fill="none" stroke={INK} strokeWidth="1.3" />
              <path d="M10 1.8 A8.2 8.2 0 0 1 18.2 10" fill="none" stroke={VIOLET} strokeWidth="2.4" />
              <circle cx="10" cy="10" r="2.2" fill={VIOLET} />
            </svg>
            CHAIR
          </div>
          <div
            style={{
              marginTop: 26,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              fontFamily: "Bricolage Grotesque",
              fontSize: 96,
              lineHeight: 0.95,
              letterSpacing: "-0.045em",
            }}
          >
            <span>Petition the Chair.</span>
            <span>It has to answer.</span>
          </div>
          <div style={{ marginTop: 28, fontFamily: "Instrument Sans", fontSize: 22, color: "#47444f" }}>
            The AI can be fooled. The contract can’t: asked for 100, it applied 25.
          </div>
        </div>
        <div style={{ position: "absolute", left: cx + GR + 18, top: cy - 13, display: "flex", fontFamily: "Instrument Sans", fontSize: 18, color: INK }}>
          locker share ≤ 25%
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        ...(display ? [{ name: "Bricolage Grotesque", data: display, style: "normal" as const, weight: 600 as const }] : []),
        ...(sans ? [{ name: "Instrument Sans", data: sans, style: "normal" as const, weight: 500 as const }] : []),
      ],
    },
  );
}
