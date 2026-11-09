# CHAIR brain: paying for inference, logging in, and the courier

This covers SPEC §6 (the brain stakes the endowment and logs in to NEAR AI Cloud) and §8 (the courier). Everything marked **verified** was read in source or checked on chain. Anything not established that way is marked **could not determine**.

**Verdict: GO for the MPC login path.** On testnet, the brain contract:

1. had NEAR's MPC network sign a NEP-413 login hash that the contract computed itself;
2. received the signature in a callback and checked it on chain;
3. added the MPC-derived key to its own account as a full-access key.

An off-chain checker then verified that signature against the derived key in the same way NEAR AI Cloud does. Whether NEAR AI Cloud accepts the account can only be tested on mainnet. That step is in the runbook (§9).

Sources read:

| Source | Version |
| --- | --- |
| `nearai/cloud-api` | `7a7e10a`, 2026-11-08 |
| `near-kit` | 0.18.3 (cloud-api's NEP-413 verifier) |
| `fastnear/house-of-stake-contracts` | `74b039c`, `staking-contract/` |
| `near/mpc` | tag `3.18.0` |
| NEAR AI Cloud UI bundle | `cloud.near.ai/signin` |

---

## 1. NEAR AI Cloud wallet login (verified)

### There is no challenge endpoint

Login is a single call, `POST https://cloud-api.near.ai/v1/auth/near`, mounted at `crates/api/src/lib.rs:1510`. The client chooses the nonce.

- **Handler:** `routes/auth.rs::near_login`.
- **Service:** `services/src/auth/near.rs::NearAuthService::verify_and_authenticate`.
- **Request body:**

```json
{
  "signed_message": { "accountId": "brain.thechair.near", "publicKey": "ed25519:…", "signature": "<base64 64 bytes>" },
  "payload": { "message": "Sign in to NEAR AI Cloud", "nonce": [32 numbers], "recipient": "cloud.near.ai", "callbackUrl": null }
}
```

- **`User-Agent` header:** required. Without it the call returns 400.
- **The UI** (`cloud.near.ai/signin`) signs the same payload and posts it through its own `/api/auth/near` proxy:
  - recipient: `NEXT_PUBLIC_NEAR_AUTH_RECIPIENT || window.location.host`, which is `cloud.near.ai`;
  - wallet network: hard-coded `"mainnet"`.

### Checks, in order

1. `recipient == NEAR_EXPECTED_RECIPIENT`. The default is `cloud.near.ai`.
2. `message == "Sign in to NEAR AI Cloud"`, exactly.
3. The nonce:
   - the first 8 bytes are a big-endian Unix-millisecond timestamp, and must not be 0;
   - its age must be 0 to 5 minutes, so it can't be in the future and can't be older than 300 000 ms.
4. `near_kit::nep413::verify` with `nonce_validation: None, require_full_access: true`:
   - **Signature:** ed25519 or secp256k1 over `sha256(u32_le(2^31+413) ‖ borsh{message: String, nonce: [u8;32], recipient: String, callback_url: Option<String>})`.
   - **Key:** `view_access_key(accountId, publicKey)` at optimistic finality on `NEAR_RPC_URL` (default `https://free.rpc.fastnear.com`, network `mainnet`) must return `FullAccess`. A function-call key fails.
   - **Timeout:** 10 s.
5. The nonce is consumed (`hex(nonce)` stored; one use only). This happens **after** verification, so bad signatures can't burn nonces.
6. `get_or_create_oauth_user` runs with provider `near`, `provider_user_id = accountId`, and a placeholder email. The first login also creates a personal organization and its default workspace (see `docs/features/organization-staking-wallet-binding.md`).

### Network

**Mainnet only.** Testnet accounts can't log in to production, because the key lookup runs on mainnet RPC.

### What comes back

```json
{ "access_token": "<JWT, 1 h>", "refresh_token": "<7 days>", "refresh_token_expiration": "…", "user": { "message": "Authenticated", "email": "…", "provider": "near" } }
```

Session management:

| Action | Endpoint |
| --- | --- |
| Refresh | `POST /v1/users/me/access-tokens` with `Bearer <refresh_token>`. Rotates the token; the refresh token is bound to the User-Agent. |
| List sessions | `GET /v1/users/me/refresh-tokens` |
| Revoke one | `DELETE /v1/users/me/refresh-tokens/{id}` |
| Revoke all | `DELETE /v1/users/me/tokens` |

Management routes accept **session tokens only** (`middleware/auth.rs::auth_middleware`), not API keys.

### Front-running

**Nothing ties the login challenge to the requester.** There is:

- no server challenge;
- no cookie;
- no client key;
- no IP binding (the handler passes `ip_address: None`).

The User-Agent is recorded, but a client can set it to anything. **Whoever posts a valid signed login first, within 5 minutes, gets the session.** See §8.

### Organization API key

1. Use a session `Bearer <access_token>`.
2. `GET /v1/organizations` (or `GET /v1/users/me`) gives the org id.
3. `GET /v1/organizations/{org_id}/workspaces` gives the workspace id.
4. `POST /v1/workspaces/{workspace_id}/api-keys` with this body:

   ```json
   {"name": "chair-courier", "expires_at": null, "spendLimit": {"amount": <nano-USD i64>, "currency": "USD"}}
   ```

The response is `201 ApiKeyResponse`. `key` (`sk-…`) is shown once, and the key is active within about 10 s.

### Linking the staking position: two flows

The flow depends on the server flag `STAKING_FARM_SELECTED_ORG_BINDING_ENABLED`. It defaults to `false` in `env.example`. **Could not determine the production value.** The lead can read it with any session from `GET /v1/staking/farm/config` (field `selected_org_binding_enabled`).

**A. Legacy (flag off): `POST /v1/organizations/{org_id}/staking/farm/sync`** (`routes/staking_farm.rs:181`).

- Caller requirements:
  - org owner or admin (`require_org_role(manage=true)`);
  - a session whose `auth_provider == "near"`;
  - `org_id` must be that NEAR user's default organization, meaning their earliest membership (`require_near_default_org`).
- It creates the source `{near_account_id = login account, network_id, contract_id, farm_product_id, farm_price_id, credit_nano_usd_per_reward_unit}` from **server config**. It ignores anything the client sends.
- It then syncs.
- **Consequence: the brain itself must log in once.**

**B. Explicit binding (flag on): `POST /v1/organizations/{org_id}/staking/farm/bind`** (`services/src/staking_farm/binding.rs`).

- **`{"phase":"prepare","near_account_id":"brain.thechair.near"}`** returns a challenge that:
  - expires in 5 minutes;
  - has a server-random 32-byte nonce;
  - is stored against `(challenge_id, org, actor)`, where the actor is the caller's user id.

  The message is:

  ```text
  Bind {account} to Cloud organization {org} as its permanent staking credit source and add its NEAR Cloud account as an organization Admin. The wallet cannot be changed and the organization cannot be deleted, even after unstaking.
  Action: org-staking-bind
  Actor: {actor}
  Network: {network}
  Contract: {contract}
  Product: {product}
  Challenge: {challenge_id}
  Expires: {expires_at}
  Terms: org-staking-binding-v1
  ```

- **`{"phase":"confirm","challenge_id","signed_message":{accountId,publicKey,signature},"acknowledged_terms_version":"org-staking-binding-v1","idempotency_key":"<uuid>"}`** runs these checks:
  - the challenge lookup is scoped to the same org and actor;
  - the challenge has not expired;
  - the server config is unchanged;
  - the same `verify_wallet_control` check as login, including the full-access key;
  - the AML gate on the wallet.

  It then atomically:
  - creates the **permanent** source;
  - provisions the wallet's NEAR identity;
  - makes that identity an org **Admin**.

  It returns no login tokens. Limits: 10 challenges per actor per 10 minutes, and 5 proof attempts per challenge.

- **A binding signature is useless to anyone else.** It names the org and the actor, and the challenge can only be confirmed by that actor in that org.
- **The brain never has to log in.** The org belongs to a normal (e.g. GitHub) account, and that account creates the API key.

**What sync checks** (`services/src/staking_farm.rs::sync_for_source`):

1. The source must be `Active`.
2. The AML gate runs on the source wallet.
3. `stake.dao.get_farm_account({account_id})` at optimistic finality. Only `total_earned_reward_units` is used. These are 24-decimal units summed over every position of the account. **It does not check product, price or validator per position.**
4. Credit is computed as `floor(units × credit_nano_usd_per_reward_unit / 1e24)`, and it is monotonic: it never decreases.

Sync is also run automatically during usage once `sync_staleness_seconds` has passed (default 300).

**Could not determine:**
- the production `credit_nano_usd_per_reward_unit`. The price description says "100 $NEAR x 1 month = $1 credit".
- whether production AML passes a fresh contract account.

### Moving endpoints

`openapi_deprecation.rs` marks the org, user and staking routes, and `/v1/auth/*`, as "moving to cloud-platform at the same path". The UI already uses `https://cloud-platform.near.ai/v1` as its management base. That repo is private. Today:

| Request | Result |
| --- | --- |
| `GET cloud-api.near.ai/v1/auth/near` | 405 (the route exists) |
| `GET cloud-platform.near.ai/v1/staking/farm/config` | 401 (the route exists) |

---

## 2. The `stake.dao` farm (verified, `staking-contract/src/stake.rs`, `accounts.rs`, `withdraw.rs`, `gas.rs`)

| Call | Arguments | Deposit | Gas | Notes |
| --- | --- | --- | --- | --- |
| `storage_deposit` | `account_id?: AccountId, registration_only?: bool` | NEAR | small | NEP-145. A first farm position needs `min_storage_deposit + per_farm_position_storage_stake`, which is 0.01 + 0.005 = **0.015 NEAR**. The brain sends exactly that with `registration_only: false`. |
| `stake` | `product_id: String, price_id: Option<String>` | the stake, ≥ `min_lock_amount` (1 NEAR) and ≥ the price amount (1 NEAR) | **prepaid ≥ 300 TGas**, or it panics `Insufficient gas` | Returns `PromiseOrValue<FarmPosition>`. With `price_id: null` it resolves the product's single active Farm price. If a live position exists, the price must match. On a pipeline failure the deposit is refunded. Needs the validator to be idle; a concurrent pipeline means retry. |
| `unstake` | `product_id, amount: Option<U128>` (`null` = all) | **exactly 1 yocto** | ≥ 300 TGas | Queues pool unstake tranches. A full exit closes the position and rolls rewards into the farm account. |
| `withdraw` | `validator_id` | **1 yocto** | ≥ 300 TGas | After `epoch_unstake_settle_epochs` (4) epochs. Pays the caller. |
| `get_farm_position` | `account_id, product_id` | view | | `FarmPositionView \| null`: `staked_near_amount`, `shares`, `pending/total_earned_reward_units`, `status: "Active" \| "Closed"`. |
| `get_farm_account` | `account_id` | view | | `{accumulated_reward_units, pending_reward_units, total_earned_reward_units, active_positions[]}`. This is what NEAR AI syncs. |
| `get_price` | `price_id` | view | | `status: "Active" \| …` |

### Mainnet values (views only, 2026-11-10)

**Config:**
- `min_storage_deposit` 0.01 NEAR
- `per_farm_position_storage_stake` 0.005 NEAR
- `min_lock_amount` 1 NEAR
- `epoch_unstake_settle_epochs` 4
- `owner` `stake.dao`

**Price `price_QzmSvxbZqdbV0XbG6VD6KkbB`:**
- product `prod_33Kp14MGUJa2QA`
- type `Farm`, status `Active`
- amount 1 NEAR, no max
- `farm_reward_rate` 7605141075366948
- description "100 $NEAR x 1 month = $1 credit"

**Product `prod_33Kp14MGUJa2QA`:** "NEAR AI Cloud Credits", validator `nearai.pool.near`.

**Mainnet protocol:** 88, `max_total_prepaid_gas` 1 PGas, so the 300 TGas floor fits inside one transaction.

### Contracts can own positions

Confirmed with `pot-7f3a.brrrain.near`:
- It has a deployed contract (code hash `Eugxn42…`) and holds a 49.63 NEAR Active position on this product and price.
- That position was opened by tx `7KbhgwRgdoDjWo95eiLYYK22TnkY7rP6QpRWcrCjkVaj`. In it, `keeper.brrrain.near` called `pot.flush` (380 TGas), and the pot then called `stake.dao.stake` with 1 NEAR and 306 TGas, so the predecessor was the pot contract.

---

## 3. NEAR MPC signer (verified, `near/mpc` 3.18.0, `crates/contract/src/api/sign.rs`, `keys.rs`)

**Versions:** both `v1.signer` (mainnet) and `v1.signer-prod.testnet` report version **3.18.0** today. Mainnet was 3.17 when the task was written.

**`sign`:**

```json
{"request": {"path": "nearai-login", "payload_v2": {"Eddsa": "<hex of the 32-byte NEP-413 hash>"}, "domain_id": 1}}
```

- **Deposit:** at least **1 yoctoNEAR** (`SIGN_DEPOSIT_YOCTONEAR`); any excess is refunded.
- **Gas:** at least `sign_call_gas_attachment_requirement_tera_gas` = **15 TGas**.
- **Payload:** for a Frost (ed25519) domain, `Eddsa` is the message itself, 0 to 1232 bytes. FROST signs it as plain RFC 8032 ed25519. The brain passes the 32-byte NEP-413 hash, which is exactly what NEP-413 wallets sign.
- **Response:** the result of the yield-resume callback:

  ```json
  {"scheme": "Ed25519", "signature": [64 numbers]}
  ```

  On timeout the call fails, after about 200 blocks.

**`derived_public_key`** (view):

```json
{"path": "nearai-login", "predecessor": "<brain>", "domain_id": 1}
```

It returns `"ed25519:…"`. The tweak is `sha3_256("near-mpc-recovery v0.1.0 epsilon derivation:" ‖ predecessor ‖ "," ‖ path)`, and the key is the domain key plus `tweak·G`. Only the brain contract (as predecessor) can obtain signatures for that key.

**Domain 1 public keys:**
- mainnet: `ed25519:G9hwngxWNKdmqMCmU1Yt6LPhFpayJeKFxyAV1HqMNLtF`
- testnet: `ed25519:6vSEtQxrQj6txUMh33WC4ERyCWmNMRTdufDWAaDY3Un2`

---

## 4. Spike results (testnet, 2026-11-10)

### Accounts

| | Account |
| --- | --- |
| Brain | `brain-038009.relay-bbcced2c.testnet` (final code sha256 `3382801f…ee36`) |
| Mock farm | `farm-038009.relay-bbcced2c.testnet` |
| Operator | `blindbook-crank-e4c061.testnet` |
| Funder / token stand-in | `relay-bbcced2c.testnet` |

**MPC-derived login key:** `ed25519:HxQ7KMjV8xUVULcaPwLgMLo6NTXxjenSSGocNRU8pMmK`. This equals `v1.signer-prod.testnet.derived_public_key({path:"nearai-login", predecessor: brain, domain_id: 1})`, and `view_access_key_list` lists it as **FullAccess**.

### Transactions

| Step | Tx | Gas burnt | Fee | Deposit |
| --- | --- | --- | --- | --- |
| Deploy and `new` | `5F8aUtahMjHvtv9aFQefCuzb5dCu6Ad1yXKiVi5fBzUm` | | 0.0018 NEAR | 2.15 NEAR storage (215 KB) |
| `install_login_key`: derived key, then `AddKey` FullAccess | `QKLm1Rpy3Pmk9ygbdqwUL9BGLYgDic1vXTAJwoGv6w9` | 10.7 TGas | 0.0010 NEAR | 0 |
| `request_login` by a non-operator: refused | `E7u11gDMABUsGXV5EZBL1vaVFLdE9UDerEZXY4azfDZv` | | | |
| **`request_login`: MPC sign, `on_signed` verifies** | **`3K7VnQmQoMqTWC3mAA1iJ6hDyvyNKkKAjtzMxkdxJx8P`** | 13.5 TGas (150 attached) | 0.0013 NEAR | 1 yocto, paid by the brain |
| `request_binding` with a tampered product: refused (`binding names another product`) | `8WeA3bkiabHxQ24cXQJpRnqDYqaZD6sekKzqaTAHscxc` | | | |
| `request_binding` with a server-format challenge: signed | `3gpkfLCZos8JbMmHh8G83E8pRNPozYXwkaectdB1cAfC` | 13.9 TGas | 0.0013 NEAR | 1 yocto |
| Second login within the cooldown: refused | `H1qfS6tC44WnJrhhaG8M3rV6S63JXUjcM54DMM9T34oS` | | | |
| `stake_endowment`: storage, stake, sync, report | `2EQpdY6qE38QM9fR4GnkcAKX5JLVTF4F4zUUAYUuxLJ9` | 13.7 TGas (400 attached) | 0.0012 NEAR | 0.015 storage + 1.0723 stake |
| `retire_position` while the price is active: refused | `3XXfYULVh1z3FcNiwipyJoxKLzgiEzTD4yaaB1Fh2WBy` | | | |
| `retire_position` after archive: unstake, sync, report 0 | `46ivLBp4MLBSpxtrvwH2WMiv2NPipqhuE9n1e4aVMzAg` | 15.9 TGas (450 attached) | 0.0014 NEAR | 1 yocto |
| `withdraw_unstaked` | `ELUTF6gLHF4zriNsdspVsprNZiVrLQDFzpUyT5VFUvHP` | 6.9 TGas | 0.0006 NEAR | 1 yocto |
| Re-stake with `price_id: null`, which follows the active price | `BUH2aszeWnVDTq6QfrFNshNQ92VpSHUXaijXUXLvyn6c` | 12.3 TGas | 0.0011 NEAR | |
| `remove_key` of a foreign key | `FcPuT39K4qmznYH4Pakf7SUaPxNLvhK64k9yqYegcHVh` | | | |
| `remove_key` of the login key: refused | `56ymRsKrwGhVFCMPy3iLg2KQNJjbvS4ZnX7zRFK3pX5i` | | | |
| `on_signed` called by a stranger: `Method on_signed is private` | `2zJgpwzLVkAJv5FqKFJEH5brXQbRZEhnk3J6nb52KTUe` | | | |
| Final code, login again | `9sgpZyj5skM8nnhj5kQwuhAwcz7w9Js2U1B5jt83GaEB` | | | |

**MPC latency:** about 4.8 s from the request block to the `on_signed` block (6 blocks).

### Off-chain verification

`node contracts/brain/scripts/verify-login.mjs brain-038009.relay-bbcced2c.testnet` independently:
- recomputes the NEP-413 hash from the payload (it matches cloud-api's wallet fixtures `036a11…` and `ca89ae…`);
- verifies the ed25519 signature with Node's crypto;
- checks the derived key;
- checks the FullAccess permission over RPC;
- checks the nonce window.

**All checks PASS** for the login and for the binding signature.

---

## 5. `contracts/brain` (own Cargo workspace, near-sdk 5.30.1)

### Methods

**Init**

- **`new(config, operator, price_id?)`**
  - `config`: `{token, farm, product_id, validator_id, min_stake, farm_storage_deposit, mpc, mpc_domain_id, key_path, recipient, network_id, sign_cooldown_sec}`. It is immutable; no setter exists and there is no upgrade path.

**Keys**

- **`install_login_key()`** (anyone, once):
  - calls `mpc.derived_public_key({path, predecessor: self, domain_id})`;
  - stores the key;
  - adds it with `AddKey FullAccess` to the brain's own account.
- **`remove_key(pk)`** (anyone): deletes any key except the login key. Use it to strip the deployer key.

**Signing**

- **`request_login()`** (operator, at least 90 TGas):
  - builds `{message: "Sign in to NEAR AI Cloud", nonce: be64(block_ms − 20 s) ‖ 24 bytes of sha256(random_seed ‖ counter), recipient: config.recipient, callbackUrl: None}`;
  - computes the hash;
  - calls `mpc.sign` with 1 yocto and 50 TGas;
  - in `on_signed`, `env::ed25519_verify`s the result against the login key before storing it.
- **`request_binding(message, nonce_hex)`** (operator): the same, but only for a binding challenge whose message passes `binding::parse`. The parse checks every fixed part byte for byte, requires the account, network, farm contract and product to be the brain's own, and requires the variable parts to be lowercase UUIDs and a `chrono` UTC timestamp. Messages are capped at 1024 bytes.
- **`seal_binding()`** (operator, one-way).
- **`retire_operator()`** (operator, one-way): no signature can ever be requested again.
- Shared limits:
  - one request in flight at a time (stale after 15 minutes);
  - a cooldown of `sign_cooldown_sec` between requests;
  - the login key must be installed first.

**Farm**

- **`deposit_endowment()`** (payable, anyone): emits an event. Plain transfers work too.
- **`stake_endowment()`** (anyone, at least 400 TGas; attach 450):
  - stakes everything above storage plus 0.25 NEAR reserve, if that is at least `min_stake`;
  - sends `[storage_deposit 0.015 if unregistered] + stake{product_id, price_id}` with 305 TGas, as **one batch**, so storage and stake revert together;
  - then `on_staked`, then sync, then report.
- **`sync()`** (anyone, at least 50 TGas): `farm.get_farm_position`, then `on_position` stores the snapshot, then `token.report_endowment({"staked": "<yocto>"})`. It reports 0 when the position is closed or missing, and never reports an unreadable answer.
- **`retire_position()`** (anyone, at least 430 TGas):
  - reads `farm.get_price(position.price_id)`;
  - **only if the price is no longer Active (or is gone)**: `unstake{amount: null}` with 1 yocto, `price_id := None` so the next stake follows the product's active price, then sync.
- **`withdraw_unstaked()`** (anyone, at least 320 TGas): `farm.withdraw{validator_id}` with 1 yocto.
- One farm operation is in flight at a time (stale after 15 minutes).

**Views**

`get_config`, `get_status`, `get_login_public_key`, `get_last_signature` and `nep413_hash(message, nonce_hex, recipient)`.

`get_last_signature` returns `{kind, signed_message{accountId, publicKey, signature}, payload{message, nonce[32], recipient}, nep413_hash, signed_at_ms}`. For a login, `{signed_message, payload}` is the `POST /v1/auth/near` body as it stands.

### Events

The events use NEP-297, `standard: "chair-brain"`, `version: "1.0.0"`:

`brain_created`, `login_key_installed`, `login_key_failed`, `key_removed`, `signature_requested`, `login_signed`, `signature_failed`, `binding_sealed`, `operator_retired`, `endowment_received`, `stake_started`, `endowment_staked`, `stake_failed`, `endowment_reported`, `sync_failed`, `retire_refused`, `position_retiring`, `position_retired`, `unstake_failed`, `withdrawn`, `withdraw_failed`.

### Interface the token must implement

`report_endowment(staked: U128)`, with 0 deposit and 10 TGas. The token must check `predecessor == brain`.

The brain sends NEAR to nobody. The token sends endowment either by plain transfer or with `deposit_endowment` attached.

### Tests

**54 unit tests** (`cargo test`). `.cargo/config.toml` sets `AWS_LC_SYS_PREBUILT_NASM=1` so the Windows build doesn't need NASM. They cover:

- the NEP-413 hash against cloud-api's fixtures;
- the tag and nonce layout;
- 17 binding-tampering cases;
- the operator, cooldown, in-flight and stale gates;
- the MPC request shape;
- signature acceptance and rejection (wrong key, wrong message, garbage, MPC failure);
- key install, removal and refusal;
- the stake batch and amounts;
- failure and success callbacks;
- reporting;
- the retire and withdraw paths;
- that `sign` is reachable from exactly two entry points.

### Mock farm

`mock-farm/` is a testnet stand-in with the same method names, arguments, 1-yocto rules and 300 TGas floors. It also has `set_price_status` for exercising retirement.

### Build

`cargo near build non-reproducible-wasm --no-abi` produces 215 KB. Use `reproducible-wasm` for mainnet.

---

## 6. `courier/` (WASI P2, own Cargo workspace)

### Steps

1. **Input:** stdin is the exact request bytes.
2. **Refused before any network call:** empty, larger than 64 KB, not a JSON object, no string `model`, or `"stream": true`.
3. **Chat:** `POST https://cloud-api.near.ai/v1/chat/completions`, with:
   - the body **byte for byte**;
   - headers `authorization: Bearer $NEARAI_API_KEY`, `content-type`/`accept: application/json` and `user-agent`.
4. **Response:** non-200 is an error. The body must be UTF-8, and it is kept **unchanged** as `response_text`. `id` must be a string.
5. **Signature:** `GET /v1/signature/{urlenc(id)}?model={urlenc(model)}&signing_algo=ecdsa` with the same bearer key. The route requires an API key.
   - Retries on 404, 429, 5xx and transport errors: 10 attempts, with backoff 250 ms rising to 3 s, about 17 s in total.
   - Other statuses stop at once.
   - `{error_code,…}` (the "unavailable" answer) is an error.
   - A non-ecdsa `signing_algo` is an error.

### Output

```json
{"response_text","signature_text","signature","signing_address","signing_algo","signature_kind","chat_id","model","request_sha256","response_sha256","hashes_match"}
```

`hashes_match` checks that `signature_text` ends with `:{sha256(request)}:{sha256(response_text)}`. The cloud-api gateway forwards `X-Request-Hash = sha256(original client body)` to the provider, so this should be true.

`signature_kind` is `provider_tee` (text `model:req:resp`) or `gateway` (text `req:resp`, no model). The token's check 1 assumes the first.

### Failure

The output is `{"error":{"code","message"}}`. The codes are:

`missing_api_key`, `empty_request`, `request_too_large`, `request_not_json`, `request_missing_model`, `request_streaming`, `upstream_transport`, `upstream_status`, `response_not_utf8`, `response_missing_id`, `signature_status`, `signature_unavailable`, `signature_malformed`, `signature_not_found`.

- **Exit code:** 0, so the error reaches the token, which records `unsigned` and runs the fallback.
- **No key:** returns `missing_api_key` naming `NEARAI_API_KEY`, and sends nothing.
- **Redaction:** the key is removed from every message, and the panic hook prints a fixed string.

### Manifest

Embedded in `outlayer.manifest` by `build.rs`:

```json
{"capabilities":{"network":["cloud-api.near.ai"]},"callers":{"contract":{"only":["<CHAIR_TOKEN>"]}}}
```

`CHAIR_TOKEN` defaults to `token.thechair.near`. The feature `scratch` drops the callers gate, for testnet only.

### Build and tests

- **Build:** `cargo build --target wasm32-wasip2 --release` produces `chair-courier.wasm`, 164 KB, a component (`0d000100`). sha256 `08b77db1…8469` for `token.thechair.near`.
- **Tests:** 16 native tests against a scripted HTTP mock (`cargo test`). They cover:
  - byte-for-byte forwarding and the returned body;
  - the URLs and headers;
  - no key;
  - 404 retries and the give-up budget;
  - transient errors;
  - key redaction;
  - a missing id;
  - non-UTF-8;
  - unavailable or malformed receipts;
  - bad requests;
  - `hashes_match`;
  - URL encoding.
- **Not yet run:** the WASI HTTP path compiles, and it is adapted from Blindbook's `wasi_host.rs`, which runs on OutLayer. It has not been run here; the first run will be on OutLayer.

---

## 7. Fallback (not needed: MPC is GO)

If the MPC path ever had to go, the fallback would be an OutLayer host signing key: `outlayer:signing-keys`, `caller: "predecessor"`, `signing_keys::sign_nep413(path, None, msg, "cloud.near.ai", &nonce, None)`, the same pattern as Blindbook's venue key (`spikes/outlayer/REPORT.md` item 7).

It would be added once as the brain's full-access key by a dedicated init-time method, which would replace `install_login_key`.

Its one real advantage: **the signature never becomes public.** The TEE module can `POST /v1/auth/near` itself over HTTPS, so there is nothing to front-run. It can even mint the API key inside the TEE and keep it in worker storage.

The costs:
- trust moves from the MPC network to OutLayer's TEE and its operators;
- the key is per project version, so an upgrade or `remove_version` must not lose it.

---

## 8. Security analysis

### Front-running a public login signature (legacy flow only)

**The exposure.** The MPC result is in a public receipt, and the login challenge isn't bound to anyone (§1). Anyone who reads the brain's `login_signed` event can post it to `/v1/auth/near` within 5 minutes. If they post first, they get the brain's session and the brain's own call fails with `401` (the nonce is already used).

**What such a session can do** (session-only management routes):
- create and revoke API keys in the brain's org, and so spend its credits or cut off the courier;
- add members;
- trigger sync;
- refresh for 7 days.

**What it cannot do:**
- **touch NEAR.** NEAR AI Cloud holds no NEAR keys. `stake.dao` `unstake`/`withdraw` only act for the predecessor, which is the brain.
- **redirect staking credits to another org.** Legacy sync can only use the logged-in NEAR user's own default org. Binding needs a fresh brain signature over a challenge naming that org, which only the operator can request.

**Mitigations built in:**
- only the operator can request a signature;
- one signature in flight;
- a cooldown (use 3600 s on mainnet);
- `retire_operator()` ends signing for good.

**Operational mitigations:**
- log in exactly once;
- do all the setup in that session;
- check `GET /v1/users/me/refresh-tokens` and the workspace key list for strangers;
- finish with `DELETE /v1/users/me/tokens`;
- if the login 401s on a used nonce, treat it as theft: log in again after the cooldown, revoke all tokens and delete unknown keys.

**How to avoid it entirely:**
- use the **binding flow**. The binding proof is scoped to the org, the actor and the challenge, and the brain never logs in.
- or use the TEE fallback (§7).

**After binding:** the brain's NEAR identity is an **Admin** of the bound org. Any later brain login would carry that admin right. So after binding, call `seal_binding()` and then `retire_operator()`.

### A leaked API key

API keys authenticate inference routes only, not management routes.

**What it can do:**
- spend the org's credits, up to the key's `spendLimit` if one is set;
- read any signature receipt (lookup doesn't check ownership);
- use other key-authenticated inference features (files, responses) in that workspace.

**What it cannot do:**
- touch NEAR or the stake;
- change the staking source;
- create keys or log in.

**Worst case:** credits run dry. The courier then gets 402/403, the token records `unsigned`, and the fallback rule runs until the key is rotated. Set a `spendLimit` sized to a few days of meetings.

### Other risks

- **MPC trust.** The login key is full access. A threshold of MPC nodes colluding could sign any transaction for the brain, including unstaking or withdrawing the endowment. That is the standard chain-signatures assumption. The contract itself can't produce such a signature:
  - it only ever sends the MPC network a NEP-413 hash that it computed itself;
  - the 2^31+413 tag can't start a borsh `Transaction`, and differs from NEP-366's 2^30+366;
  - `sign` is reachable from two methods only, and a test pins that.
- **Operator trust.** Until `retire_operator`, the operator can:
  - mint login sessions;
  - sign a binding challenge naming **any** org (binding is permanent, so check the org id before calling `request_binding`).

  It can't move NEAR.
- **Keys.** After `remove_key(deployer)`, the brain has exactly one key (the MPC key), and no code path can deploy, transfer or add a key other than the MPC-derived one.
- **Concurrency and failures.**
  - Farm operations and signatures each allow one in flight, with a 15-minute stale reset so a lost callback can't brick the brain.
  - A failed stake refunds the deposit, either from the failed receipt or from the farm's `refund_payable_pipeline`.
  - `on_staked` only marks the brain registered on success.
  - Reports come from the farm view (`staked_near_amount`), not from the brain's own bookkeeping.
- **Reserve.** 0.25 NEAR stays liquid for state growth and 1-yocto deposits. Callers pay all gas.

---

## 9. Mainnet runbook

**Assumed ids:** brain `brain.thechair.near`, operator `<ops>.near`, token `token.thechair.near`. Change them as needed, but the courier must be rebuilt with the token id. Every step below is a mainnet transaction, so none of it has been run yet.

### 1. Build reproducibly

```sh
cd contracts/brain && cargo near build reproducible-wasm
```

Record the sha256.

### 2. Create the brain

Fund it with **2.6 NEAR**: 2.15 for code storage, plus the 0.25 reserve, plus margin.

```sh
near account create-account fund-myself brain.thechair.near '2.6 NEAR' autogenerate-new-keypair save-to-keychain sign-as thechair.near network-config mainnet sign-with-keychain send
```

### 3. Deploy and initialize in one transaction

```sh
near contract deploy brain.thechair.near use-file target/near/chair_brain.wasm with-init-call new json-args '{"config":{"token":"token.thechair.near","farm":"stake.dao","product_id":"prod_33Kp14MGUJa2QA","validator_id":"nearai.pool.near","min_stake":"1000000000000000000000000","farm_storage_deposit":"15000000000000000000000","mpc":"v1.signer","mpc_domain_id":1,"key_path":"nearai-login","recipient":"cloud.near.ai","network_id":"mainnet","sign_cooldown_sec":3600},"operator":"<ops>.near","price_id":"price_QzmSvxbZqdbV0XbG6VD6KkbB"}' prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config mainnet sign-with-keychain send
```

### 4. Install the login key

1. Preview the key with the view `v1.signer derived_public_key {"path":"nearai-login","predecessor":"brain.thechair.near","domain_id":1}`.
2. Call `install_login_key` with 60 TGas, from anyone.
3. Check `view_access_key_list` for the brain: the derived key must be there as `FullAccess`.

### 5. Endow and stake

1. Get at least 1.015 NEAR above the reserve into the brain, from the token or by `deposit_endowment`.
2. Call `stake_endowment` with 450 TGas.
3. Check `stake.dao get_farm_position {"account_id":"brain.thechair.near","product_id":"prod_33Kp14MGUJa2QA"}`.
4. Check that the token received `report_endowment`.

### 6. Pick the flow

The lead signs in at cloud.near.ai with GitHub or Google, then reads `GET /v1/staking/farm/config` with that session's `Bearer`.

### 7A. Binding (`selected_org_binding_enabled: true`, preferred)

1. **Prepare.** The lead calls `POST /v1/organizations/{lead_org}/staking/farm/bind` with `{"phase":"prepare","near_account_id":"brain.thechair.near"}`. Check that the payload recipient is `cloud.near.ai` and that the message names `{lead_org}`.
2. **Sign.** Within 5 minutes, the operator calls `request_binding {"message": <payload.message>, "nonce": <hex of payload.nonce>}` with 150 TGas.
3. **Read** `brain.get_last_signature`.
4. **Confirm.** The lead calls `POST …/bind` with:

   ```json
   {"phase":"confirm","challenge_id":"…","signed_message":<signed_message>,"acknowledged_terms_version":"org-staking-binding-v1","idempotency_key":"<uuid>"}
   ```

5. **Sync.** The lead calls `POST /v1/organizations/{lead_org}/staking/farm/sync`, and checks that `active_positions` lists the brain's position and `farm_credit_nano_usd` is greater than 0 once rewards accrue.
6. **Close signing.** The operator calls `seal_binding` and then `retire_operator`.
7. **Create the API key.** The lead creates it in a workspace of `{lead_org}`, with a `spendLimit`.

### 7B. Legacy (flag off)

1. **Log in.** Run this immediately, one command:

   ```sh
   near contract call-function as-transaction brain.thechair.near request_login json-args '{}' prepaid-gas '150 Tgas' attached-deposit '0 NEAR' sign-as <ops>.near network-config mainnet sign-with-keychain send && node contracts/brain/scripts/verify-login.mjs brain.thechair.near --network mainnet --post
   ```

   This proves that NEAR AI Cloud accepts the account, and returns `access_token` and `refresh_token`.
2. **Set up** with `Bearer <access_token>`:
   1. `GET /v1/organizations`: this is the brain's default org.
   2. `POST /v1/organizations/{org}/staking/farm/sync`: this creates the source for `brain.thechair.near` and syncs.
   3. `GET /v1/organizations/{org}/workspaces`.
   4. `POST /v1/workspaces/{ws}/api-keys` with `{"name":"chair-courier","spendLimit":{"amount":<nano-USD>,"currency":"USD"}}`.
   5. Optional: invite the lead as admin with `POST /v1/organizations/{org}/members`.
3. **Check for strangers.** `GET /v1/users/me/refresh-tokens` should show exactly one session, and `GET /v1/workspaces/{ws}/api-keys` exactly one key.
4. **Close the session** with `DELETE /v1/users/me/tokens`.
5. **Optionally retire the operator** (`retire_operator`). If you do, a new key can later only come from an admin session such as the invited lead's.
6. **If the login 401s** (nonce already used, so it was front-run): wait for the cooldown, run `request_login` again, revoke all tokens, and delete foreign keys and members.

### 8. Strip the deployer key

Once 7A or 7B has succeeded:

```sh
near contract call-function as-transaction brain.thechair.near remove_key json-args '{"public_key":"<deployer key>"}' …
```

Then check that `view_access_key_list` shows only the MPC key. The code is final from then on.

### 9. Set up the courier

1. **Build:** `cd courier && CHAIR_TOKEN=token.thechair.near cargo build --target wasm32-wasip2 --release`.
2. **Publish:**
   1. `outlayer upload` to FastFS;
   2. **check that the URL's sha256 matches the build** (the CLI can report success for a dropped transaction);
   3. `create_project`;
   4. `add_version`.
3. **Set the secret:** store the API key as OutLayer secret `NEARAI_API_KEY` on the project, with access restricted to predecessor `token.thechair.near`.
4. **Pin the version:** the token pins `version_key`. Call `remove_version` on any superseded build.

### 10. Smoke test

1. Run the first `convene` and check the courier output: `hashes_match: true` and `signature_kind: provider_tee`.
2. Add `signing_address` to the token's `model_signers` through the 48-hour proposal.

### 11. Keep it running

- Anyone calls `sync` (50 TGas) before each meeting.
- Anyone calls `stake_endowment` (450 TGas) whenever `get_status.liquid` is at least 1 NEAR.
- If `stake.dao` archives the price, anyone calls `retire_position` (450 TGas). After 4 epochs, `withdraw_unstaked` (350 TGas), then `stake_endowment` again.

---

## 10. Open questions for mainnet

1. **Which flow is live?** That is, is `STAKING_FARM_SELECTED_ORG_BINDING_ENABLED` on in production? This decides 7A or 7B. Could not determine from source; read `GET /v1/staking/farm/config`.
2. **Does production AML pass a brand-new contract account** (`check_near_account`, provider score, unknown-account policy)? Could not determine.
3. **What is production's `credit_nano_usd_per_reward_unit`?** It sets credits per staked NEAR. Could not determine.
4. **Will the auth and staking endpoints move to `cloud-platform.near.ai`?** They are marked "moving to cloud-platform". The paths stay the same, but the host may change.
5. **Token side:**
   - `report_endowment(staked: U128)` must exist and check the predecessor;
   - check 1 in SPEC §5 must handle `signature_kind: gateway` (no model prefix) or reject it;
   - `model_id` in `signature_text` is the provider's id.

   The first live `hashes_match` / `signature_text` will settle all three.
6. **The courier's WASI HTTP path hasn't been run.** Compiled, not executed. Run it first with the `scratch` build on an OutLayer testnet project and a real key.
