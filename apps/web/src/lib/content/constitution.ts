import type { Rules } from "@/lib/chair-types";

/**
 * The constitution's compile-time constants (contracts/token, `get_constitution`),
 * used to draw the rails and the ladder when testnet cannot be read. They are
 * fixed at launch, so these are the contract's values, not a snapshot; today's
 * levers and endowment are never filled in from here.
 */
export const RULES: Rules = {
  tax_bps: { min: 100, max: 300, max_step: 50 },
  endowment_share: { min: 30, max: 100, max_step: 10 },
  locker_share: { min: 0, max: 25, max_step: 10 },
  buyback_share: "100 - endowment_share - locker_share",
  buyback_burn: { min: 0, max: 50, max_step: null },
  fallback_tax_target_bps: 200,
  fallback_tax_step_bps: 10,
};

export const LADDER = [
  { model: "z-ai/glm-5.3-flash", min_near: 1 },
  { model: "deepseek-ai/DeepSeek-V4.1-Flash-1017", min_near: 50 },
  { model: "moonshotai/kimi-k3", min_near: 500 },
];

/** The launch levers (docs/LAUNCH.md): the IQ ladder's "wakes after" volumes are worked out at these. */
export const LAUNCH = { tax_bps: 300, endowment_share: 60 };

/** NEAR of trading volume that stakes `n` NEAR into the endowment at the launch levers. */
export const volumeFor = (n: number) => n / ((LAUNCH.tax_bps / 10_000) * (LAUNCH.endowment_share / 100));

/** "about 56", "about 2,800": two significant figures. */
export function about(x: number): string {
  const p = Math.pow(10, Math.max(0, Math.floor(Math.log10(x)) - 1));
  return `about ${(Math.round(x / p) * p).toLocaleString("en-US")}`;
}

/** The testnet contract, for links that must work even when testnet cannot be read. */
export const CONTRACT = "token3.chair-dev.testnet";
export const EXPLORER = "https://testnet.nearblocks.io";

/** The testnet test model signer on token3's `model_signers`: a test key that obeys injections on purpose, not a NEAR AI model. */
export const TEST_SIGNER = "0xc05345aa0ef4976fc189a3eeb2eacba450a5a87f";
