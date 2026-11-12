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

/** The site's testnet contract, for links that must work even when testnet cannot be read. */
export const CONTRACT = "token5.chair-dev.testnet";
export const EXPLORER = "https://testnet.nearblocks.io";
export const OUTLAYER_ATTESTATIONS = "https://testnet-api.outlayer.ai/attestations/by-request";

/**
 * Mainnet (docs/LAUNCH.md): the live token and its first meeting, a ruling by
 * NEAR AI's GLM 5.3 Flash. The landing reads the meeting live; these are the
 * pointers for links that must work when mainnet cannot be read.
 */
export const MAINNET_CONTRACT = "token.thechair.near";
export const MAINNET_EXPLORER = "https://nearblocks.io";
export const MAINNET_MEETING = 1;
export const MAINNET_PROOF_TX = "2fLXR3VnybmHR8sK2nMrS2oCRoefgumLMseA3VDLYCBr";
export const MAINNET_ATTESTATION = "https://api.outlayer.ai/attestations/by-request/3008";

/**
 * The real chair's first meetings on token5 (docs/LAUNCH.md): NEAR AI's GLM 5.3
 * Flash read the Illia petition and the injection and declined both. The
 * landing reads them live; these are only the pointers.
 */
export const REAL_CHAIR_CONTRACT = "token5.chair-dev.testnet";
export const REAL_MEETINGS = [1, 2];
export const REAL_PROOF_TX = "A9rkGGZ7PHKh1GAxQPxx9FdNDixTaLUrpuQh95bnHdE5";

/**
 * token3: the testnet token whose chair is the test signer, a chair that obeys
 * prompt injections on purpose and signs with a test key. Its meeting 1 is the
 * clamp the landing shows (docs/LAUNCH.md).
 */
export const TEST_CHAIR_CONTRACT = "token3.chair-dev.testnet";
export const TEST_CHAIR_TX = "3XxXDYm6ffsEVwFLwhbfhn61QfSkPui7QiBLp2qd35im";

/** The testnet test model signer: a test key, not a NEAR AI model. It is on token3's, token4's and token5's `model_signers`, and on no mainnet list. */
export const TEST_SIGNER = "0xc05345aa0ef4976fc189a3eeb2eacba450a5a87f";
/** The testnet test gateway key, on token4's and token5's `gateway_signers`. */
export const TEST_GATEWAY_SIGNER = "0x41356bf67420f68ed56f44554dcb9697391f3b7b";
