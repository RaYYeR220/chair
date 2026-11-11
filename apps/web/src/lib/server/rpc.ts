import "server-only";
import { env } from "./env";

/** A contract panic or an RPC-level error, with the node's message. */
export class RpcError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
    readonly kind?: string,
  ) {
    super(message);
  }
}

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

async function post(url: string, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "chair", method, params }),
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
    } catch (e) {
      last = e;
      continue;
    }
    if (RETRY_STATUS.has(res.status)) {
      last = new RpcError(`rpc http ${res.status}`);
      continue;
    }
    const body = (await res.json()) as { result?: unknown; error?: { name?: string; cause?: { name?: string; info?: unknown }; message?: string; data?: unknown } };
    if (body.error) {
      const kind = body.error.cause?.name ?? body.error.name;
      const vm = (body.error.cause?.info as { vm_error?: string } | undefined)?.vm_error;
      if (kind === "CONTRACT_EXECUTION_ERROR" && vm) throw new RpcError(cleanPanic(vm), body.error, "ContractPanic");
      throw new RpcError(
        `${kind ?? "rpc error"}: ${typeof body.error.data === "string" ? body.error.data : body.error.message ?? ""}`.trim(),
        body.error,
        kind,
      );
    }
    return body.result;
  }
  throw last instanceof Error ? last : new RpcError("rpc unreachable");
}

/** `url` overrides the site's RPC (the NEAR AI relay reads tokens on either network). */
export function rpc<T>(method: string, params: unknown, opts: { archival?: boolean; timeoutMs?: number; url?: string } = {}): Promise<T> {
  return post(opts.url ?? (opts.archival ? env.archivalRpc : env.rpc), method, params, opts.timeoutMs ?? 12_000) as Promise<T>;
}

export type Finality = "final" | "optimistic";

/** A contract view call. Contract panics surface as `RpcError` with the panic text. */
export async function view<T>(
  method: string,
  args: object = {},
  opts: { contract?: string; finality?: Finality; rpcUrl?: string; timeoutMs?: number } = {},
): Promise<T> {
  const res = await rpc<{ result?: number[]; error?: string; logs?: string[] }>(
    "query",
    {
      request_type: "call_function",
      finality: opts.finality ?? "final",
      account_id: opts.contract ?? env.contractId,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    },
    { url: opts.rpcUrl, timeoutMs: opts.timeoutMs },
  );
  if (res.error) throw new RpcError(cleanPanic(res.error), res.error, "ContractPanic");
  if (!res.result) throw new RpcError(`${method}: empty result`);
  const text = Buffer.from(res.result).toString("utf8");
  return (text === "" ? null : JSON.parse(text)) as T;
}

/**
 * The panic message out of a node's wrapper: `... GuestPanic { panic_msg: "X" })`
 * or `... Smart contract panicked: X`.
 */
export function cleanPanic(s: string): string {
  const guest = /panic_msg: (?:\\)?"(.*?)(?:\\)?" \}/s.exec(s);
  if (guest) return guest[1].replace(/\\"/g, '"');
  const sc = /Smart contract panicked: (.*?)(?:"\s*\}*\)*\s*$|$)/s.exec(s);
  return (sc ? sc[1] : s).replace(/\\"/g, '"').trim();
}

export interface BlockHeader {
  height: number;
  hash: string;
  timestamp: number;
  timestamp_nanosec: string;
}

export async function finalBlock(finality: Finality = "final"): Promise<BlockHeader> {
  const b = await rpc<{ header: BlockHeader }>("block", { finality });
  return b.header;
}

export interface AccountState {
  amount: string;
  locked: string;
  storage_usage: number;
}

export async function viewAccount(accountId: string): Promise<AccountState | null> {
  try {
    return await rpc<AccountState>("query", { request_type: "view_account", finality: "final", account_id: accountId });
  } catch (e) {
    if (e instanceof RpcError && (e.kind === "UNKNOWN_ACCOUNT" || /does not exist/.test(e.message))) return null;
    throw e;
  }
}

/** An account's access keys (`view_access_key_list`). The token account should have none. */
export async function accessKeys(accountId: string): Promise<{ public_key: string }[]> {
  const r = await rpc<{ keys: { public_key: string }[] }>("query", {
    request_type: "view_access_key_list",
    finality: "final",
    account_id: accountId,
  });
  return r.keys;
}

// ---------------------------------------------------------------- transactions

export interface ReceiptOutcome {
  id: string;
  block_hash: string;
  outcome: {
    executor_id: string;
    gas_burnt: number;
    logs: string[];
    receipt_ids: string[];
    status: { SuccessValue?: string; SuccessReceiptId?: string; Failure?: unknown };
  };
}

export interface TxStatus {
  final_execution_status?: string;
  status: { SuccessValue?: string; Failure?: unknown } | string;
  transaction: { hash: string; signer_id: string; receiver_id: string; actions: unknown[] };
  transaction_outcome: { id: string; block_hash: string };
  receipts_outcome: ReceiptOutcome[];
  receipts?: {
    receipt_id: string;
    predecessor_id: string;
    receiver_id: string;
    receipt: { Action?: { actions: ({ FunctionCall?: { method_name: string; args: string; deposit: string } } | string)[] } };
  }[];
}

/**
 * Full status of a transaction with every receipt in its tree. Falls back to
 * the archival node when the regular one has garbage-collected it.
 */
export async function txStatus(hash: string, sender: string, waitUntil = "NONE"): Promise<TxStatus> {
  const params = { tx_hash: hash, sender_account_id: sender, wait_until: waitUntil };
  try {
    return await rpc<TxStatus>("EXPERIMENTAL_tx_status", params, { timeoutMs: 20_000 });
  } catch (e) {
    if (e instanceof RpcError && /UNKNOWN_TRANSACTION|GARBAGE_COLLECTED|UNKNOWN_BLOCK/i.test(`${e.kind} ${e.message}`)) {
      return rpc<TxStatus>("EXPERIMENTAL_tx_status", params, { archival: true, timeoutMs: 20_000 });
    }
    throw e;
  }
}

export function decodeValue(b64: string | undefined): unknown {
  if (b64 === undefined) return undefined;
  const text = Buffer.from(b64, "base64").toString("utf8");
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The method each receipt called, by receipt id. */
export function receiptMethods(tx: TxStatus): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of tx.receipts ?? []) {
    const fc = r.receipt.Action?.actions.find((a) => typeof a === "object" && a.FunctionCall);
    if (fc && typeof fc === "object" && fc.FunctionCall) out.set(r.receipt_id, fc.FunctionCall.method_name);
    else if (r.receipt.Action) out.set(r.receipt_id, typeof r.receipt.Action.actions[0] === "string" ? String(r.receipt.Action.actions[0]) : "Transfer");
  }
  return out;
}

export interface ChainEvent {
  standard: string;
  event: string;
  data: Record<string, unknown>;
  receipt_id: string;
  executor: string;
  block_hash: string;
}

/** Every NEP-297 event in the transaction tree, in execution order. */
export function txEvents(tx: TxStatus): ChainEvent[] {
  const out: ChainEvent[] = [];
  for (const r of tx.receipts_outcome) {
    for (const log of r.outcome.logs) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      try {
        const e = JSON.parse(log.slice("EVENT_JSON:".length)) as { standard: string; event: string; data: unknown };
        const data = Array.isArray(e.data) ? e.data[0] : e.data;
        out.push({
          standard: e.standard,
          event: e.event,
          data: (data ?? {}) as Record<string, unknown>,
          receipt_id: r.id,
          executor: r.outcome.executor_id,
          block_hash: r.block_hash,
        });
      } catch {
        // a malformed log line is not an event
      }
    }
  }
  return out;
}

export function txFailure(tx: TxStatus): string | null {
  const failures = tx.receipts_outcome.filter((r) => r.outcome.status.Failure !== undefined);
  const top = typeof tx.status === "object" && tx.status.Failure !== undefined ? tx.status.Failure : failures[0]?.outcome.status.Failure;
  if (top === undefined) return null;
  const s = JSON.stringify(top);
  const panic = /"FunctionCallError":\{"ExecutionError":"(.*?)"\}/.exec(s);
  return panic ? cleanPanic(panic[1]) : s.slice(0, 500);
}
