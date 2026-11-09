# CHAIR specification

CHAIR is a memecoin that runs its own central bank. The NEAR its trading fees accumulate is staked to pay for its own AI inference on NEAR AI Cloud. Once a day the coin holds a rate meeting: a model running in a TEE reads the state of the coin and the holders' petitions, then rules. The contract checks the model's signature itself and applies the ruling only inside a constitution fixed at launch. **The AI can be fooled. The contract can't.**

## 1. Accounts

| Account | Holds | Keys |
| --- | --- | --- |
| `token` (e.g. `token.thechair.near`) | The NEP-141 token, the bonding-curve reserve, the buyback fund, the locker reward pool | **none** after deploy (code and parameters immutable) |
| `brain` (e.g. `brain.thechair.near`) | The endowment, staked in the NEAR AI inference farm (`stake.dao`) | one full-access key derived by NEAR's MPC network for the brain contract alone, used only to sign NEP-413 login messages to NEAR AI Cloud (§6) |

The token sends endowment NEAR to the brain, never the other way.

## 2. Bonding curve

- **Pricing.** The price is a function of the curve's sold amount `s` (base units): `p(s) = p0 + k·s` (linear).
  - Buying `Δ` costs `∫ p` over `[s, s+Δ]`.
  - Selling `Δ` returns `∫ p` over `[s−Δ, s]`.
  - The reserve always equals `∫₀ˢ p`, with exact integer math and rounding in the reserve's favour.
- **Tax.** Every buy and sell pays a tax `τ` in NEAR on top of (buy) or out of (sell) the curve amount. The tax is split by the current policy:
  - `endowment_share` → sent to `brain` and staked for inference;
  - `buyback_share` → buyback fund;
  - `locker_share` → locker reward pool (NEAR).
- **No allocation.** No pre-mint, no team allocation. Every token in existence was bought on the curve.

## 3. Locks and petitions

- **Lock.** A holder locks tokens for `d ∈ {1, 7, 30}` days. Weight = tokens × days. Locked tokens can't move until unlock.
- **Rewards.** Locker rewards accrue in NEAR, pro rata to weight, from the reward pool, and are paid daily at the meeting.
- **Petition.** A locker can attach one petition (≤ 280 characters) per day. It costs a fixed token fee that is burned. The meeting brief carries the three petitions with the highest weight, and the ruling must answer each.

## 4. The constitution (fixed at `new`, readable via `get_constitution`)

| Lever | Bounds | Max change per meeting |
| --- | --- | --- |
| Tax `τ` | 100–300 bps | ±50 bps |
| `endowment_share` | 30–100% of tax | ±10 pts |
| `locker_share` | 0–50% of tax | ±10 pts |
| `buyback_share` | the remainder | n/a |
| Buyback-and-burn | ≤ buyback fund balance and ≤ 0.5% of supply per meeting | n/a |

- A ruling outside these bounds is **clamped**, never rejected, and the clamp is recorded.
- Meetings are at least `meeting_interval` apart: 23 h on mainnet, configurable at `new` for testnet demos.
- If the brain is asleep, or a ruling is missing, unsigned or malformed, the **fallback rule** runs instead. The fallback moves tax 10 bps toward 200 and holds everything else.

## 5. The meeting

1. **`convene()`.** Anyone may call it once the interval has passed. The contract snapshots a **brief** and builds the exact model request bytes.
   - Snapshot fields: meeting number, supply, `s`, reserve, curve price, 24 h buy and sell volume, current levers, fund balances, endowment (as last reported by the brain), locker weight, and the top 3 petitions.
   - Request bytes: a compact JSON chat-completions body with a fixed system prompt (the constitution and the output schema), the brief as the user message, `temperature: 0`, and `model` = the tier from the IQ ladder (§7).
   - It stores `sha256(request)` and calls OutLayer `request_execution` with the request as input. The courier module (§8) needs no trust.
2. **Callback `on_ruling(meeting, result)`.** The module returns `{response_text, signature_text, signature}`, where `response_text` is the exact chat-completion body from NEAR AI. The contract checks, in order:
   1. `signature_text == model_id + ":" + hex(sha256(request)) + ":" + hex(sha256(response_text))`
   2. `ecrecover(keccak256("\x19Ethereum Signed Message:\n" + len + signature_text), signature)` is in `model_signers` (an allowlist of NEAR AI TEE signing addresses).
   3. The JSON content of `response_text` parses as a ruling: `{tax_bps, endowment_share, locker_share, buyback_burn, minutes, answers[3]}`.

   If every check passes, the ruling is clamped and applied. Otherwise the fallback rule runs, and the reason (`unsigned`, `bad_signature`, `bad_hash`, `unparseable`, `asleep`) is recorded.
3. **Application.**
   - Set the levers.
   - Execute the buyback: buy on the curve with fund NEAR, then burn. The burn leaves `s` unchanged, so the reserve becomes over-collateralised and the floor rises.
   - Pay locker rewards.
   - Store the minutes: hash on-chain and full text in an event.
   - Emit `meeting_held`.
4. **`preview_ruling(response_text, signature_text, signature, meeting)`.** A view that runs checks 1–3 and the clamp without changing state. It returns what would execute. This drives the public demo: forged signature → `bad_signature`; jailbroken but genuinely signed ruling → clamped.

## 6. Paying for the brain (staking for inference)

- `brain` stakes the endowment in the NEAR AI farm. The farm is `stake.dao`, product `prod_33Kp14MGUJa2QA`, price `price_QzmSvxbZqdbV0XbG6VD6KkbB`, validator `nearai.pool.near`, minimum 1 NEAR. The staking yield becomes NEAR AI Cloud credits for the organisation linked to `brain`.
- **Login.** Linking the farm and issuing an API key require a NEP-413 login signed with a full-access key of `brain`.
  - **Primary:** the brain contract requests an ed25519 signature from `v1.signer` (domain 1, path `nearai-login`) over a NEP-413 hash it computes itself (tag `2^31+413`, recipient fixed to NEAR AI). The corresponding derived public key is added once as `brain`'s only full-access key. The contract never signs anything that isn't a NEP-413 login hash.
  - **Fallback:** a key generated inside the OutLayer TEE.
- The API key lives in OutLayer encrypted secrets bound to the courier project. The worst case for a leaked API key is spent credits, never NEAR.

## 7. IQ ladder

The endowment determines the model tier. The ladder is a fixed table set at `new`:

| Endowment staked | Model |
| --- | --- |
| < 1 NEAR | asleep: fallback rule only |
| ≥ 1 NEAR | `z-ai/glm-5.3-flash` |
| ≥ 50 NEAR | `deepseek-ai/DeepSeek-V4.1-Flash-1017` |
| ≥ 500 NEAR | `moonshotai/kimi-k3` |

## 8. Courier module (OutLayer, WASI P2)

1. Reads the request bytes from input.
2. POSTs them unchanged to `https://cloud-api.near.ai/v1/chat/completions` with the API key from secrets.
3. Fetches `/v1/signature/{chat_id}?model=…&signing_algo=ecdsa`.
4. Returns `{response_text, signature_text, signature}`.

It cannot alter the ruling without breaking check 2.

## 9. Trust and limits

- **Signer allowlist.** `model_signers` changes only through a 48 h timelocked owner proposal, which emits an event and can be vetoed by nobody. That proposal is the trust point, and it is written down. NEAR AI rotates TEE signing keys per instance.
- **Re-rolls.** A relayer could re-roll a meeting and pick the ruling it likes. The contract accepts only the first valid result per meeting, and the request pins `temperature: 0` and the brief.
- **Plutocracy.** Steering is token-weighted by design.
