import "server-only";
import { z } from "zod";
import { type Network, parseRelayTokens } from "./nearai-gate";

/**
 * Server configuration. Everything has a testnet default except the
 * secrets, so the read-only routes work with no env at all. Secrets are read
 * here and nowhere else, and never leave the server.
 */

export const NETWORKS = {
  testnet: {
    rpc: "https://test.rpc.fastnear.com",
    archivalRpc: "https://archival-rpc.testnet.fastnear.com",
    nearblocksApi: "https://api-testnet.nearblocks.io",
    explorer: "https://testnet.nearblocks.io",
    contract: "token3.chair-dev.testnet",
  },
  mainnet: {
    rpc: "https://rpc.mainnet.fastnear.com",
    archivalRpc: "https://archival-rpc.mainnet.fastnear.com",
    nearblocksApi: "https://api.nearblocks.io",
    explorer: "https://nearblocks.io",
    contract: "token.thechair.near",
  },
} as const;

const optionalString = z
  .string()
  .trim()
  .transform((s) => (s === "" ? undefined : s))
  .optional();

const schema = z.object({
  CHAIR_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
  CHAIR_CONTRACT_ID: optionalString,
  CHAIR_RPC_URL: optionalString.pipe(z.string().url().optional()),
  CHAIR_ARCHIVAL_RPC_URL: optionalString.pipe(z.string().url().optional()),
  NEARBLOCKS_API_URL: optionalString.pipe(z.string().url().optional()),
  NEARBLOCKS_API_KEY: optionalString,
  /** Known convene transactions, `meeting:hash` pairs separated by commas. */
  CHAIR_KNOWN_CONVENES: optionalString,

  /** 32-byte secp256k1 hex key of the testnet test model signer. */
  CHAIR_TEST_MODEL_KEY: optionalString.pipe(
    z
      .string()
      .regex(/^(0x)?[0-9a-fA-F]{64}$/, "must be 32 bytes of hex")
      .optional(),
  ),
  /** The server-held demo account that pays for relayed petitions and convenes. */
  CHAIR_DEMO_ACCOUNT_ID: optionalString,
  CHAIR_DEMO_SECRET_KEY: optionalString.pipe(
    z
      .string()
      .regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/, "must be an ed25519:<base58> secret key")
      .optional(),
  ),

  /** Petitioner sub-accounts the relay rotates through (each files once a day). */
  CHAIR_RELAY_POOL_SIZE: z.coerce.number().int().min(1).max(32).default(8),
  /** NEAR each petitioner sub-account spends on CHAIR when it runs low. */
  CHAIR_RELAY_BUY_NEAR: z.coerce.number().positive().max(1).default(0.06),
  CHAIR_RELAY_LOCK_DAYS: z.coerce.number().int().refine((d) => [1, 7, 30].includes(d), "1, 7 or 30").default(1),
  /** The demo account never spends below this balance (NEAR). */
  CHAIR_RELAY_FLOOR_NEAR: z.coerce.number().min(0).default(2),
  /** NEAR the relay may spend per UTC day per server instance. */
  CHAIR_RELAY_DAILY_CAP_NEAR: z.coerce.number().positive().default(1.5),
  CHAIR_RELAY_IP_COOLDOWN_S: z.coerce.number().int().min(0).default(600),
  CHAIR_RELAY_IP_DAILY_MAX: z.coerce.number().int().min(1).default(5),
  CHAIR_CONVENE_IP_COOLDOWN_S: z.coerce.number().int().min(0).default(120),
  /**
   * Testing aid, off by default. `1`: the petition relay and convene validate
   * the request and answer with a realistic response marked `dry_run`, worked
   * out from read-only views. Nothing is signed or sent.
   */
  CHAIR_RELAY_DRY_RUN: z
    .enum(["0", "1", "true", "false", ""])
    .default("0")
    .transform((v) => v === "1" || v === "true"),

  /**
   * Secret. The NEAR AI Cloud API key the courier relay
   * (`/api/nearai/v1/...`) adds to the two calls it forwards. Unset: the relay
   * answers 503 and forwards nothing.
   */
  NEARAI_API_KEY: optionalString,
  /**
   * Token contracts whose courier may use the relay, comma-separated, each
   * `.testnet` or `.near` (its network, and so its RPC, follows the suffix).
   * Default: `token5.chair-dev.testnet` on testnet, `token.thechair.near` on mainnet.
   */
  CHAIR_RELAY_TOKENS: optionalString,
  /** Upstream completions per (token, meeting) per server instance. */
  CHAIR_NEARAI_MAX_FORWARDS: z.coerce.number().int().min(1).max(5).default(2),
  /**
   * Local testing only, off by default: the relay gate compares the body with
   * this sha256 instead of reading the token's open meeting from chain. It is
   * ignored on Vercel and whenever NODE_ENV is production.
   */
  CHAIR_NEARAI_TEST_REQUEST_SHA256: optionalString.pipe(
    z
      .string()
      .regex(/^[0-9a-f]{64}$/, "must be 64 lowercase hex characters")
      .optional(),
  ),
});

function load() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // Paths and messages only: never echo a value, it may be a secret.
    const why = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid server env: ${why}`);
  }
  const e = parsed.data;
  const net = NETWORKS[e.CHAIR_NETWORK];
  let relayTokens: string[];
  try {
    relayTokens = parseRelayTokens(e.CHAIR_RELAY_TOKENS, e.CHAIR_NETWORK);
  } catch (err) {
    throw new Error(`invalid server env: ${(err as Error).message}`);
  }
  const testHashAllowed = !process.env.VERCEL && process.env.NODE_ENV !== "production";
  return {
    networkId: e.CHAIR_NETWORK,
    contractId: e.CHAIR_CONTRACT_ID ?? net.contract,
    rpc: e.CHAIR_RPC_URL ?? net.rpc,
    archivalRpc: e.CHAIR_ARCHIVAL_RPC_URL ?? net.archivalRpc,
    nearblocksApi: e.NEARBLOCKS_API_URL ?? net.nearblocksApi,
    nearblocksKey: e.NEARBLOCKS_API_KEY,
    explorer: net.explorer,
    knownConvenes: parseKnown(e.CHAIR_KNOWN_CONVENES),
    testModelKey: e.CHAIR_TEST_MODEL_KEY,
    demo:
      e.CHAIR_DEMO_ACCOUNT_ID && e.CHAIR_DEMO_SECRET_KEY
        ? { accountId: e.CHAIR_DEMO_ACCOUNT_ID, secretKey: e.CHAIR_DEMO_SECRET_KEY }
        : null,
    relay: {
      poolSize: e.CHAIR_RELAY_POOL_SIZE,
      buyNear: e.CHAIR_RELAY_BUY_NEAR,
      lockDays: e.CHAIR_RELAY_LOCK_DAYS,
      floorNear: e.CHAIR_RELAY_FLOOR_NEAR,
      dailyCapNear: e.CHAIR_RELAY_DAILY_CAP_NEAR,
      ipCooldownS: e.CHAIR_RELAY_IP_COOLDOWN_S,
      ipDailyMax: e.CHAIR_RELAY_IP_DAILY_MAX,
    },
    conveneIpCooldownS: e.CHAIR_CONVENE_IP_COOLDOWN_S,
    dryRun: e.CHAIR_RELAY_DRY_RUN,
    nearai: {
      apiKey: e.NEARAI_API_KEY,
      tokens: relayTokens,
      maxForwards: e.CHAIR_NEARAI_MAX_FORWARDS,
      testRequestSha256: testHashAllowed ? e.CHAIR_NEARAI_TEST_REQUEST_SHA256 : undefined,
    },
  };
}

function parseKnown(raw: string | undefined): Map<number, string> {
  const out = new Map<number, string>();
  for (const pair of (raw ?? "").split(",")) {
    const [n, hash] = pair.split(":").map((s) => s.trim());
    if (n && hash && /^\d+$/.test(n) && /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(hash)) out.set(Number(n), hash);
  }
  return out;
}

export const env = load();
export type Env = typeof env;

export const isTestnet = env.networkId === "testnet";

/** The RPC for a network: the configured one for the site's own network, else FastNEAR's. */
export function rpcFor(network: Network): string {
  return network === env.networkId ? env.rpc : NETWORKS[network].rpc;
}

export function txUrl(hash: string) {
  return `${env.explorer}/txns/${hash}`;
}

export function accountUrl(id: string) {
  return `${env.explorer}/address/${id}`;
}
