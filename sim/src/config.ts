import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SIM_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_DIR = join(SIM_DIR, "..");

const raw = JSON.parse(readFileSync(join(SIM_DIR, "chair.config.json"), "utf8"));
const a = raw.new_args;
const k = raw.constitution;

export const YOCTO = 10n ** 24n;
export const DECIMALS: number = k.token_decimals;
export const ONE = 10n ** BigInt(DECIMALS); // base units per whole token

export interface Bound { min: number; max: number; max_step: number }
export interface LeverSet { tax_bps: number; endowment_share: number; locker_share: number }
export interface Tier { min: bigint; model: string }

/** The constitution's bounds: compile-time constants in the contract. */
export interface Rules { tax: Bound; endowment: Bound; locker: Bound; buybackMaxBps: number; fallbackTaxTarget: number; fallbackTaxStep: number }

export const RULES: Rules = {
  tax: k.tax_bps as Bound,
  endowment: k.endowment_share as Bound,
  locker: k.locker_share as Bound,
  buybackMaxBps: k.buyback_burn_max_bps as number,
  fallbackTaxTarget: k.fallback.tax_target_bps as number,
  fallbackTaxStep: k.fallback.tax_step_bps as number,
};

/** The same rules with a different locker_share ceiling (the v1-bound control run). */
export const withLockerMax = (max: number): Rules => ({ ...RULES, locker: { ...RULES.locker, max } });

export const CFG = {
  p0: BigInt(a.curve.p0) as bigint, // yocto per whole token
  k: BigInt(a.curve.k) as bigint, // yocto per whole token per whole token of s
  launch: (a.levers ?? k.default_levers) as LeverSet,
  ...RULES,
  lockDays: k.lock_days as number[],
  petitionFee: BigInt(a.petition_fee) as bigint, // base units
  petitionMaxChars: k.petition_max_chars as number,
  petitionTopN: k.petitions_in_brief as number,
  storageDeposit: BigInt(k.storage_deposit) as bigint,
  rewardScale: BigInt(k.reward_scale) as bigint,
  ladder: (a.ladder as { min_endowment: string; model: string }[]).map((r): Tier => ({ min: BigInt(r.min_endowment), model: r.model })),
  venice: raw.venice as {
    base_url: string;
    model_map: Record<string, string>;
    usd_per_mtok: Record<string, { input: number; output: number }>;
    max_calls_per_run: number;
  },
  rawNewArgs: a,
  rawConstitution: k,
  source: raw._source as string,
  mechanics: raw.contract_mechanics as Record<string, string>,
};
