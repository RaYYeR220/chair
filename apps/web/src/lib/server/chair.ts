import "server-only";
import type {
  AccountView,
  BuyQuote,
  ConstitutionView,
  CurveView,
  FundsView,
  GovernanceView,
  LeversView,
  Meeting,
  Petition,
  RequestPreview,
  RulingPreview,
  Stats,
  StatusView,
} from "@/lib/chair-types";
import { decimal, near, tokens } from "@/lib/units";
import { env, site, type Target } from "./env";
import { accessKeys, finalBlock, type Finality, view } from "./rpc";

/**
 * Typed client for the token contract's views (contracts/token/src: lib.rs,
 * meeting.rs, locks.rs, trade.rs, ft.rs). Every method maps one view.
 * `chairAt` reads any CHAIR token; `chair` is the site's own.
 */
export function chairAt(t: Target) {
  const at = (f?: Finality) => ({ finality: f, contract: t.contract, rpcUrl: t.rpc });
  return {
    curve: (f?: Finality) => view<CurveView>("get_curve", {}, at(f)),
    levers: (f?: Finality) => view<LeversView>("get_levers", {}, at(f)),
    funds: (f?: Finality) => view<FundsView>("get_funds", {}, at(f)),
    status: (f?: Finality) => view<StatusView>("get_status", {}, at(f)),
    stats: (f?: Finality) => view<Stats>("get_stats", {}, at(f)),
    constitution: () => view<ConstitutionView>("get_constitution", {}, at()),
    governance: () => view<GovernanceView>("get_governance", {}, at()),
    petitions: (f?: Finality) => view<Petition[]>("get_petitions", {}, at(f)),
    meeting: (n: number, f?: Finality) => view<Meeting | null>("get_meeting", { meeting: n }, at(f)),
    lastRequest: () => view<string | null>("get_last_request", {}, at()),
    requestPreview: (f?: Finality) => view<RequestPreview>("get_request_preview", {}, at(f)),
    previewRuling: (args: { response_text: string; signature_text: string; signature: string; meeting: number }) =>
      view<RulingPreview>("preview_ruling", args, at("optimistic")),
    account: (accountId: string, f?: Finality) => view<AccountView | null>("get_account", { account_id: accountId }, at(f)),
    quoteBuy: (nearIn: bigint, accountId?: string) =>
      view<BuyQuote>("quote_buy", { near_in: nearIn.toString(), account_id: accountId ?? null }, at("optimistic")),
    ftBalance: (accountId: string) => view<string>("ft_balance_of", { account_id: accountId }, at()),
    totalSupply: () => view<string>("ft_total_supply", {}, at()),
  };
}

export const chair = chairAt(site);

// ---------------------------------------------------------------- short-lived cache

type Entry = { at: number; value: Promise<unknown> };
const memo = new Map<string, Entry>();

/** Coalesces identical reads for `ttlMs` per server instance. */
export function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;
  const value = load();
  memo.set(key, { at: Date.now(), value });
  value.catch(() => memo.delete(key));
  return value;
}

export function forget(prefix = "") {
  for (const k of memo.keys()) if (k.startsWith(prefix)) memo.delete(k);
}

// ---------------------------------------------------------------- formatting

export { decimal, near, tokens };

export function parseNear(n: number | string): bigint {
  const [i, f = ""] = String(n).split(".");
  return BigInt(i || "0") * 10n ** 24n + BigInt((f + "0".repeat(24)).slice(0, 24) || "0");
}

// ---------------------------------------------------------------- state

/** The IQ ladder position for an endowment (SPEC §7). */
export function iqTier(c: ConstitutionView, endowment: bigint) {
  const ladder = c.ladder;
  let index = -1;
  ladder.forEach((t, i) => {
    if (endowment >= BigInt(t.min_endowment)) index = i;
  });
  const next = ladder[index + 1] ?? null;
  return {
    index,
    asleep: index < 0,
    model: index >= 0 ? ladder[index].model : null,
    endowment_near: near(endowment),
    next: next
      ? { model: next.model, min_endowment_near: near(next.min_endowment), missing_near: near(BigInt(next.min_endowment) - endowment) }
      : null,
    ladder: ladder.map((t, i) => ({ model: t.model, min_endowment_near: near(t.min_endowment), reached: i <= index })),
  };
}

export function parseBrief(request: string | null) {
  if (!request) return null;
  try {
    const body = JSON.parse(request) as { model: string; messages: { role: string; content: string }[]; temperature: number };
    const user = body.messages.find((m) => m.role === "user");
    return { model: body.model, temperature: body.temperature, brief: user ? JSON.parse(user.content) : null };
  } catch {
    return null;
  }
}

export async function getState() {
  const [block, status, curve, funds, stats, petitions, preview, constitution, governance, keys] = await Promise.all([
    finalBlock(),
    chair.status(),
    chair.curve(),
    chair.funds(),
    chair.stats(),
    chair.petitions(),
    chair.requestPreview(),
    cached("constitution", 60_000, chair.constitution),
    cached("governance", 60_000, chair.governance),
    // The token account's access keys: none means nobody can redeploy it. A failed read is `null`, never a guess.
    cached("token-keys", 60_000, () => accessKeys(env.contractId)).catch(() => null),
  ]);
  const now = BigInt(block.timestamp_nanosec);
  const next = BigInt(status.next_meeting_at);
  const opensIn = next > now ? Number((next - now) / 1_000_000_000n) : 0;
  const tier = iqTier(constitution, BigInt(funds.endowment_reported));
  const previewParsed = parseBrief(preview.request);
  return {
    contract: env.contractId,
    network: env.networkId,
    block: { height: block.height, timestamp: block.timestamp_nanosec },
    status,
    levers: status.levers,
    meetings: {
      count: status.meeting_count,
      open: status.open_meeting,
      next_meeting_at: status.next_meeting_at,
      opens_in_s: opensIn,
      can_convene: opensIn === 0,
      interval_s: constitution.meeting_interval_s,
      convene_deposit: constitution.outlayer.deposit,
    },
    curve: {
      ...curve,
      price_near: near(curve.price),
      floor_price_near: near(curve.floor_price),
      supply_chair: tokens(curve.supply),
      burned_chair: tokens(curve.burned),
      reserve_near: near(curve.reserve),
    },
    funds: {
      ...funds,
      display: {
        reserve: near(funds.reserve),
        buyback_fund: near(funds.buyback_fund),
        locker_pool: near(funds.locker_pool),
        locker_owed: near(funds.locker_owed),
        endowment_pending: near(funds.endowment_pending),
        endowment_sent: near(funds.endowment_sent),
        endowment_reported: near(funds.endowment_reported),
      },
    },
    endowment: { reported: funds.endowment_reported, reported_at: funds.endowment_reported_at, ...tier },
    stats,
    petitions: {
      queued: petitions,
      max_queue: 8,
      in_brief: constitution.petitions_in_brief,
      fee: constitution.petition_fee,
      fee_chair: tokens(constitution.petition_fee),
      max_chars: constitution.petition_max_chars,
    },
    request_preview: {
      meeting: preview.meeting,
      model: preview.model,
      seed_placeholder: preview.seed_placeholder,
      brief: previewParsed?.brief ?? null,
      request: preview.request,
    },
    governance,
    token_account: { account_id: env.contractId, keys: keys ? keys.map((k) => k.public_key) : null },
    constitution: { ...constitution, system_prompt_bytes: Buffer.byteLength(constitution.system_prompt) },
  };
}
