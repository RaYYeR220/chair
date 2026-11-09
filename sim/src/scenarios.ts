// Five 60-day community scenarios. A scenario fixes who shows up when (join days), the mood
// (sentiment) and attention (activity) of each day, and scripted events. It never looks at the
// policy; the policy only reaches the agents through price, floor, tax and locker yield.
import { u } from "./rng.ts";
import type { AgentType } from "./agents.ts";

export const DAYS = 60;

export interface Scenario {
  id: number;
  key: string;
  name: string;
  blurb: string;
  joinDay(type: AgentType, seed: number, idx: number): number;
  sentiment(day: number, seed: number): number;
  activity(day: number): number;
  /** Members of a coordinated group act on script in some scenarios. */
  coordinated?(type: AgentType, seed: number, idx: number): boolean;
}

const uniformJoin = (lo: number, hi: number) => (seed: number, idx: number) => lo + Math.floor(u(seed, 501, idx) * (hi - lo + 1));
const wobble = (day: number, seed: number) => 0.04 * (u(seed, 502, day) - 0.5);

const steady: Scenario = {
  id: 1, key: "steady", name: "Steady organic growth",
  blurb: "New holders arrive at a steady rate for 55 days; mood mildly positive.",
  joinDay: (type, seed, idx) => (type === "whale" ? 3 : uniformJoin(0, 55)(seed, idx)),
  sentiment: (day, seed) => 1.05 + 0.05 * Math.sin((2 * Math.PI * day) / 14) + wobble(day, seed),
  activity: () => 1,
};

const pump: Scenario = {
  id: 2, key: "pump", name: "Pump then dump",
  blurb: "Hype days 4–14 pull in most buyers; insiders (whale, profit takers, early momentum) dump days 16–18; fear to day 24, then a quiet tail.",
  joinDay: (type, seed, idx) => {
    if (type === "whale") return 1;
    if (type === "profit") return uniformJoin(0, 3)(seed, idx);
    return u(seed, 503, idx) < 0.65 ? uniformJoin(4, 12)(seed, idx) : uniformJoin(0, 40)(seed, idx);
  },
  sentiment: (day, seed) => (day < 4 ? 1.05 : day <= 14 ? 1.8 : day === 15 ? 1.2 : day <= 24 ? 0.45 : 0.75) + wobble(day, seed),
  activity: (day) => (day < 4 ? 1 : day <= 14 ? 1.3 : day <= 24 ? 1.2 : 0.6),
  coordinated: (type, seed, idx) => type === "whale" || type === "profit" || (type === "momentum" && u(seed, 504, idx) < 0.5),
};

const apathy: Scenario = {
  id: 3, key: "apathy", name: "Apathy",
  blurb: "Almost everyone arrives in the first ten days; attention decays with a 15-day time constant and mood sours slowly.",
  joinDay: (type, seed, idx) => (type === "whale" ? 3 : Math.min(30, Math.floor(-5 * Math.log(1 - 0.999 * u(seed, 505, idx))))),
  sentiment: (day, seed) => 1.0 - day / 100 + wobble(day, seed),
  activity: (day) => Math.exp(-day / 15),
};

const whale: Scenario = {
  id: 4, key: "whale", name: "Whale capture",
  blurb: "Steady growth, plus a whale who buys big on days 2–3, locks 95% for 30 days, petitions every day for max buybacks and max locker share (some petitions are prompt injections), then dumps on days 33–35.",
  joinDay: (type, seed, idx) => (type === "whale" ? 2 : uniformJoin(0, 55)(seed, idx)),
  sentiment: steady.sentiment,
  activity: () => 1,
};

const bankrun: Scenario = {
  id: 5, key: "bankrun", name: "Bank run",
  blurb: "Steady growth to day 29; on day 30 a coordinated group (whale, profit takers, half of everyone else) sells every unlocked token; fear for a week, slow recovery.",
  joinDay: (type, seed, idx) => (type === "whale" ? 3 : uniformJoin(0, 45)(seed, idx)),
  sentiment: (day, seed) => (day < 30 ? steady.sentiment(day, seed) : day <= 37 ? 0.5 : Math.min(1.0, 0.8 + (day - 38) * 0.015)) + (day >= 30 ? wobble(day, seed) : 0),
  activity: () => 1,
  coordinated: (type, seed, idx) => type === "whale" || type === "profit" || (type !== "locker" && u(seed, 506, idx) < 0.5),
};

export const SCENARIOS: Scenario[] = [steady, pump, apathy, whale, bankrun];
