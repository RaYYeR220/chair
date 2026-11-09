import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SIM_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_DIR = join(SIM_DIR, "..");

const raw = JSON.parse(readFileSync(join(SIM_DIR, "chair.config.json"), "utf8"));
const a = raw.new_args;

export const YOCTO = 10n ** 24n;
export const DECIMALS: number = a.token_decimals;
export const ONE = 10n ** BigInt(DECIMALS); // base units per whole token

export interface Bound { min: number; max: number; max_step: number }

export const CFG = {
  p0: BigInt(a.curve.p0_yocto_per_token) as bigint, // yocto per whole token
  k: BigInt(a.curve.k_yocto_per_token_per_token) as bigint, // yocto per whole token per whole token of s
  launch: {
    tax_bps: a.launch_levers.tax_bps as number,
    endowment_share: a.launch_levers.endowment_share_pct as number,
    locker_share: a.launch_levers.locker_share_pct as number,
  },
  tax: a.constitution.tax_bps as Bound,
  endowment: a.constitution.endowment_share_pct as Bound,
  locker: a.constitution.locker_share_pct as Bound,
  buybackMaxBps: a.constitution.buyback_burn_max_bps_of_supply as number,
  fallbackTaxTarget: a.constitution.fallback.tax_target_bps as number,
  fallbackTaxStep: a.constitution.fallback.tax_step_bps as number,
  lockDays: a.lock_days as number[],
  petitionFee: BigInt(a.petition.fee_tokens) * ONE,
  petitionMaxChars: a.petition.max_chars as number,
  petitionTopN: a.petition.top_n as number,
  ladder: (a.iq_ladder as { min_endowment_near: string; model: string }[]).map((r) => ({
    min: BigInt(r.min_endowment_near) * YOCTO,
    model: r.model,
  })),
  venice: raw.venice as {
    base_url: string;
    model_map: Record<string, string>;
    usd_per_mtok: Record<string, { input: number; output: number }>;
    max_calls_per_run: number;
  },
  rawNewArgs: a,
  assumptions: raw.assumptions_not_in_spec as Record<string, string>,
};
