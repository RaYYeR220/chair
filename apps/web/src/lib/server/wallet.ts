import "server-only";
import { createHash } from "node:crypto";
import { Account, type Action, actions, baseEncode, JsonRpcProvider, KeyPair, KeyPairSigner } from "near-api-js";
import type { TxRef } from "@/lib/chair-types";
import { env, txUrl } from "./env";
import { cleanPanic, decodeValue } from "./rpc";

/**
 * The server-held demo account (and the petitioner sub-accounts it creates,
 * which share its key). Its secret is read from env here and never leaves
 * the server.
 */

export const TGAS = 10n ** 12n;

let provider: JsonRpcProvider | null = null;
const getProvider = () => (provider ??= new JsonRpcProvider({ url: env.rpc }));

function secret(): string {
  if (!env.demo) throw new Error("the demo account is not configured");
  return env.demo.secretKey;
}

export const demoAvailable = () => env.demo !== null;
export const demoAccountId = () => env.demo?.accountId ?? null;

export function demoPublicKey(): string {
  return KeyPair.fromString(secret() as `ed25519:${string}`).getPublicKey().toString();
}

const accounts = new Map<string, Account>();
export function account(accountId = env.demo?.accountId ?? ""): Account {
  let a = accounts.get(accountId);
  if (!a) {
    a = new Account(accountId, getProvider(), KeyPairSigner.fromSecretKey(secret() as `ed25519:${string}`));
    accounts.set(accountId, a);
  }
  return a;
}

export interface TxResult {
  ok: boolean;
  hash: string;
  url: string;
  value?: unknown;
  error?: string;
  logs: string[];
}

function txHash(signed: { transaction: { encode(): Uint8Array } }): string {
  return baseEncode(createHash("sha256").update(signed.transaction.encode()).digest());
}

interface RpcTxResponse {
  status?: { SuccessValue?: string; Failure?: unknown } | string;
  receipts_outcome?: { outcome: { logs: string[]; status: { Failure?: unknown } } }[];
}

function summarize(hash: string, res: RpcTxResponse): TxResult {
  const receipts = res.receipts_outcome ?? [];
  const logs = receipts.flatMap((r) => r.outcome.logs);
  const failure =
    (typeof res.status === "object" && res.status?.Failure) || receipts.find((r) => r.outcome.status.Failure !== undefined)?.outcome.status.Failure;
  let error: string | undefined;
  if (failure) {
    const s = JSON.stringify(failure);
    const panic = /"ExecutionError":"(.*?)"\}/.exec(s);
    error = panic ? cleanPanic(panic[1]) : s.slice(0, 400);
  }
  return {
    ok: !failure,
    hash,
    url: txUrl(hash),
    value: typeof res.status === "object" ? decodeValue(res.status?.SuccessValue) : undefined,
    error,
    logs,
  };
}

/**
 * Sign and send one transaction. The hash is computed before sending, so
 * callers get it even when they only wait for inclusion.
 */
export async function send(
  signerId: string,
  receiverId: string,
  acts: Action[],
  waitUntil: "INCLUDED" | "EXECUTED_OPTIMISTIC" | "FINAL" = "EXECUTED_OPTIMISTIC",
): Promise<TxResult> {
  for (let attempt = 0; ; attempt++) {
    const a = account(signerId);
    const signed = await a.createSignedTransaction({ receiverId, actions: acts });
    const hash = txHash(signed);
    try {
      const res = (await a.provider.sendTransactionUntil(signed, waitUntil)) as RpcTxResponse;
      return summarize(hash, res);
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      // A stale nonce: rebuild the account (fresh nonce cache) and retry.
      if (attempt < 2 && /nonce/i.test(msg)) {
        accounts.delete(signerId);
        continue;
      }
      // Timeouts leave the tx in flight; the caller can look it up by hash.
      if (/timeout|TIMEOUT/i.test(msg)) return { ok: false, hash, url: txUrl(hash), error: "timed out waiting for the transaction", logs: [] };
      throw e;
    }
  }
}

export const call = (signerId: string, contract: string, method: string, args: object, gasT: number, deposit = 0n, waitUntil?: "INCLUDED" | "EXECUTED_OPTIMISTIC" | "FINAL") =>
  send(signerId, contract, [actions.functionCall(method, args, BigInt(gasT) * TGAS, deposit)], waitUntil);

export function ref(label: string, r: TxResult): TxRef & { ok: boolean; error?: string } {
  return { label, hash: r.hash, url: r.url, ok: r.ok, ...(r.error ? { error: r.error } : {}) };
}

export { actions };
