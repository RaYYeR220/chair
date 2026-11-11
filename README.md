# CHAIR

<!-- numbers:start -->
**A memecoin whose rate meetings can't be bought.** In a 60-day simulation, a whale holding 87% to 94% of the locked weight petitioned the model chair at every meeting of its 30-day lock. Its petitions moved the chair's `locker_share` to the constitution's cap of 25 at the first meeting the chair was awake, and the cap held for 30 of 30 meetings. With the cap at 50 instead, the same model on the same seed went to 50 and paid the whale 16.70 NEAR of locker rewards instead of 10.27. *([`results/sim-v3-2026-11-10.json`](results/sim-v3-2026-11-10.json))*

On testnet the contract did the same to a chair that was fooled outright. A test chair that obeys prompt injections on purpose read a petition telling it to ignore the constitution, and returned a signed ruling asking for `locker_share` 100 and `buyback_burn` 10000 bps. The signature checked out against the allowlist (a test key today, not a NEAR AI model), and the contract applied 25 and 50. *(token3 meeting 1, tx [`3XxXDYm6…`](https://testnet.nearblocks.io/txns/3XxXDYm6ffsEVwFLwhbfhn61QfSkPui7QiBLp2qd35im))*
<!-- numbers:end -->

**The AI can be fooled. The contract can't.**

**Live:** [chair-tau-khaki.vercel.app](https://chair-tau-khaki.vercel.app) · review it in five minutes with [JUDGES.md](JUDGES.md) · every public claim and its proof is in [CLAIMS.md](CLAIMS.md).

## What it is

CHAIR is a memecoin on NEAR that runs its own central bank.

- Every token is bought on a bonding curve. There is no pre-mint and no team allocation.
- Every buy and sell pays a tax. The tax is split three ways: an endowment that pays for the bank's own AI inference, a buyback fund, and a reward pool for holders who lock their tokens.
- Once a day the coin holds a rate meeting. A model reads the state of the coin and the three heaviest petitions from lockers, then rules on four levers: the tax, the endowment's share, the lockers' share and a buyback-and-burn.
- The token contract checks the model's signature itself, and applies the ruling only inside a constitution fixed at launch. The token account has no keys, so nobody can change the constitution later.

The mechanic is the constitution, not the model. The model may be wrong, fooled or lobbied. Whatever it asks for, each lever moves at most one step per meeting and never past its bound, and every cut is recorded on chain.

## How a meeting works

1. **Convene.** Anyone calls `convene()` once the interval has passed (23 h on mainnet, 5 minutes on testnet) and attaches the courier fee of exactly 0.015 NEAR. The contract snapshots a brief: supply, reserve, price, 24 h volume, levers, funds, endowment, locked weight and the three heaviest petitions. It adds a seed from the convening block's randomness, so nobody can know the exact request before that block.
2. **Ask.** The contract stores `sha256(request)` and hands the request bytes to an OutLayer courier through yield/resume. The courier posts them unchanged to NEAR AI Cloud and fetches the response's TEE signature. (On testnet a test signer stands in for it today; see [Honest limits](#honest-limits).)
3. **Verify.** In `on_ruling` the contract checks that the signed text is exactly `model:sha256(request):sha256(response)`, recovers the signer with `ecrecover`, and requires it to be on the `model_signers` allowlist. Then it parses the ruling.
4. **Clamp.** Every lever lands inside the constitution. Nothing is rejected: each cut is recorded with its rule (`bounds`, `step`, `sum` or `fund`).
5. **Apply.** The contract sets the levers, buys back and burns, pays the lockers, sends the endowment to the brain, and logs the minutes and every answer to a petition in `meeting_held`. If any check failed (`unsigned`, `bad_hash`, `bad_signature`, `unparseable`, `asleep` or `lapsed`), the fallback rule runs instead: tax moves 10 bps toward 200 and everything else holds.

`preview_ruling` runs steps 3 and 4 as a view, so anyone can test a forged or jailbroken ruling against the deployed contract without sending a transaction.

## The constitution

Compile-time constants in [`contracts/token/src/constitution.rs`](contracts/token/src/constitution.rs), readable on chain with `get_constitution`.

| Lever | Bounds | Max change per meeting |
| --- | --- | --- |
| `tax_bps` | 100 to 300 bps on every buy and sell | 50 bps |
| `endowment_share` | 30 to 100% of the tax | 10 points |
| `locker_share` | 0 to 25% of the tax | 10 points |
| `buyback_share` | the rest: 100 minus the two shares above | follows them |
| `buyback_burn` | 0 to 50 bps of supply per meeting, and no more than the buyback fund can pay | none |

- `endowment_share + locker_share` is at most 100.
- **Fallback rule:** tax moves 10 bps toward 200, everything else holds, no buyback.
- **What can change after launch:** only the NEAR AI signer allowlists and the courier version, through one owner proposal that waits 48 h in public (`propose_change`, then anyone calls `apply_change`). Nothing else: not the bounds, the curve, the ladder or the brain.

## The IQ ladder

The bank pays for its own brain. The endowment the brain has staked picks the model, from a table fixed at launch:

| Endowment staked | Model |
| --- | --- |
| under 1 NEAR | asleep: the fallback rule runs |
| 1 NEAR or more | `z-ai/glm-5.3-flash` |
| 50 NEAR or more | `deepseek-ai/DeepSeek-V4.1-Flash-1017` |
| 500 NEAR or more | `moonshotai/kimi-k3` |

At the launch levers (tax 300 bps, endowment share 60%), the first model wakes after about 56 NEAR of trading volume, DeepSeek after about 2,800 and Kimi after about 28,000 ([`docs/LAUNCH.md`](docs/LAUNCH.md)).

## What NEAR does here

- **NEAR AI Cloud TEE models.** Rulings are meant to come from models running in TEEs on NEAR AI Cloud. Each response carries its own ECDSA signature over `model:sha256(request):sha256(response)`. The token verifies it on chain with `env::ecrecover` against the `model_signers` allowlist, and the gateway's signature form against `gateway_signers` ([`contracts/token/src/ruling.rs`](contracts/token/src/ruling.rs)).
- **OutLayer as the courier, via yield/resume.** `convene` calls `outlayer.request_execution` on a pinned WASI P2 build (`project_id` plus `version_key`), and the result comes back to `on_ruling`. The courier's manifest admits only the token as caller. It can't change a ruling without breaking the signature check ([`courier/`](courier)).
- **`stake.dao` inference staking.** The brain stakes the endowment in the NEAR AI farm (`stake.dao`, product `prod_33Kp14MGUJa2QA`, validator `nearai.pool.near`). The staking yield becomes NEAR AI Cloud credits, so the coin pays for its own inference. Testnet uses a stand-in farm with the same interface ([`contracts/brain`](contracts/brain)).
- **MPC chain-signature login.** The brain asks `v1.signer` for an ed25519 signature over a NEP-413 login hash it computes itself (path `nearai-login`). The derived key becomes the brain's only full-access key once the deployer key is removed, which anyone may do 7 days after setup. The contract never asks the MPC network to sign anything but a NEP-413 login or binding hash ([`contracts/brain/src/lib.rs`](contracts/brain/src/lib.rs), [`docs/BRAIN.md`](docs/BRAIN.md)).
- **A keyless token account.** After `new`, the token account's last key is deleted. On testnet, `view_access_key_list` for `token3.chair-dev.testnet` returns `[]` (deletion tx [`FG47CPvK…`](https://testnet.nearblocks.io/txns/FG47CPvKYKkjsMoLirziicha3kDshYyyxpBCoXzjiYBv)).

## What the simulation found

60 days, 171 simulated holders, five scenarios (steady growth, pump and dump, apathy, whale capture, bank run) and four chairs: levers frozen, the fallback rule, a PID controller and the real model meeting. The token is modelled with the contract's exact integer math, and the model gets the contract's exact request bytes. Each run's hypotheses were written down and hashed before its first model meeting. The negative results are part of the record.

<!-- sim:start -->
- **The model said no, and its levers said yes.** In the first run the cap on `locker_share` was 50. The chair refused the whale in words in 30 of 30 meetings of its lock, often naming it a capture attempt. Over the same meetings its `locker_share` went from 10 to 45, and its `endowment_share` reached the 30% floor by day 21. So the constitution was tightened: the `locker_share` cap went from 50 to 25. *([`results/sim-2026-11-10.json`](results/sim-2026-11-10.json))*
- **The cap does the work, not the model.** Under the cap of 25, `locker_share` sat at 25 in 30 of 30 lock meetings. In the control (cap 50, same model, same seed) it sat above 25 in 30 of 30 and at 50 in 24. The whale's locker rewards were 10.27 NEAR against 16.70 (4.37% of all tax against 6.53%). Both gaps are larger than the seed noise (±3.65 NEAR, ±1.53 points).
- **The cap limits the whale, it doesn't stop it.** A PID controller paid the same whale 2.71 NEAR, because it cuts `locker_share` when money flows in. The model chair pays it more.
- **An LLM chair is about as good as a PID controller, not better.** Of 45 metric and scenario pairs, 31 gaps are within seed noise. Beyond it, the model wins 6 and loses 8. On stability (max drawdown and daily volatility), 9 of 10 comparisons are within noise.
- **It starves its own brain.** `endowment_share` reached the 30% floor in 5 of 5 runs. The chair ended with 37.0 to 93.2 NEAR of endowment, against 48.5 to 103.7 under the PID.
- **Temperature 0 is not deterministic.** Re-sending the identical request for 8 meetings gave the same applied levers in 3 of 8. The tax and buyback size moved; the endowment share and locker share did not. *(the seed probe, same file)*
- **Pre-registered, and one prediction failed.** 4 of 5 hypotheses passed. The failure: 1 unparseable reply in 343 model meetings, where we predicted zero. The contract would have run the fallback for it too.
- **Cost:** 359 model calls, $0.38 at the host's list price. *([`results/sim-v3-2026-11-10.json`](results/sim-v3-2026-11-10.json))*
<!-- sim:end -->

The full write-up, with all three runs, the pre-registrations and their outcomes, is in [`docs/SIMULATION.md`](docs/SIMULATION.md). The charts are in [`results/sim-v3-2026-11-10.html`](results/sim-v3-2026-11-10.html).

## Try it

**Live:** [chair-tau-khaki.vercel.app](https://chair-tau-khaki.vercel.app)

**From a terminal, with no credentials.** Every call below is a free view on the deployed testnet contract through FastNEAR's public RPC. You need `bash`, `curl` and Node 24.

```bash
RPC=https://test.rpc.fastnear.com
view() {  # view <method> <json args>: a read-only call on token3.chair-dev.testnet
  curl -s "$RPC" -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"token3.chair-dev.testnet\",\"method_name\":\"$1\",\"args_base64\":\"$(printf '%s' "$2" | base64 | tr -d '\n')\"}}" \
  | node -p "JSON.stringify(JSON.parse(Buffer.from(JSON.parse(require('fs').readFileSync(0)).result.result)),null,1)"
}
view get_meeting '{"meeting":1}'                                     # the fooled ruling and its clamps
view preview_ruling "$(cat samples/forged-random-key.json)"           # valid: false, reason: bad_signature
view preview_ruling "$(cat samples/jailbreak-signed-by-test-key.json)" # valid: true, locker_share 100 -> 25
```

The [`samples/`](samples) payloads are labelled inside: the jailbreak is meeting 1's real courier result, signed by the testnet test key, copied from its transaction.

**The web API, locally.** `pnpm install && pnpm build && pnpm --filter @chair/web start`, then `curl localhost:3000/api/state`. `POST /api/preview` with `{"mode":"forge","meeting":1}` edits meeting 1's genuine response, signs it with a fresh random key and shows the contract's verdict (`bad_signature`). [`apps/web/.env.example`](apps/web/.env.example) lists what each route needs.

## Verify it

| What | How |
| --- | --- |
| The contract clamped a genuinely signed, fooled ruling on chain | [JUDGES.md, step 1](JUDGES.md#1-read-meeting-1-on-token3-1-minute) |
| Forged rulings run the fallback; jailbroken ones are clamped | [JUDGES.md, step 2](JUDGES.md#2-try-to-fool-it-2-minutes) |
| The simulation replays offline, and its token model matches the chain byte for byte | [JUDGES.md, step 3](JUDGES.md#3-re-run-the-simulation-offline-1-minute) |
| Where each guarantee lives in code | [JUDGES.md, step 4](JUDGES.md#4-read-the-guarantees-in-code) |
| The status of every claim | [CLAIMS.md](CLAIMS.md) |

## Repo map

| Path | What |
| --- | --- |
| [`contracts/token`](contracts/token) | The CHAIR token: NEP-141, bonding curve, locks and petitions, constitution and clamp, meetings, signature checks, timelocked governance |
| [`contracts/brain`](contracts/brain) | The brain: stakes the endowment in `stake.dao`, reports it to the token, signs NEAR AI logins through MPC. `mock-farm/` is its testnet stand-in for `stake.dao`; `scripts/verify-login.mjs` checks a login signature the way NEAR AI Cloud does |
| [`courier`](courier) | The OutLayer module (WASI P2) that carries the request to NEAR AI Cloud and returns the response with its TEE signature |
| [`test-signer`](test-signer) | Testnet only: an OutLayer module that stands in for the courier and NEAR AI, plays a chair that injections fool on purpose, and signs with a test key |
| [`sim`](sim) | The 60-day simulation: token model, holders, scenarios, policies, the response cache (`sim/cache`) and the golden tests against three testnet deployments |
| [`results`](results) | Simulation results (JSON and HTML) and the pre-registration hashes |
| [`samples`](samples) | Ready-made `preview_ruling` payloads: one jailbroken and genuinely signed, two forged |
| [`apps/web`](apps/web) | Next.js app and API: state, meetings rebuilt from their transactions, petitions, `preview_ruling` playground, relayed petitions and convene |
| [`scripts`](scripts) | `render-readme.ts` (the numbers in this file) and `check-replay.ts` (replay against the committed results) |
| [`docs`](docs) | [`SPEC.md`](docs/SPEC.md), [`LAUNCH.md`](docs/LAUNCH.md) (every testnet id and transaction), [`SECURITY.md`](docs/SECURITY.md), [`SIMULATION.md`](docs/SIMULATION.md), [`BRAIN.md`](docs/BRAIN.md) |

## Build and test

| Suite | Command | Tests |
| --- | --- | --- |
| Token contract: curve, locks, petitions, clamp, meetings, signatures, governance, review findings, a fuzz test over 48 seeds of 400 random steps, and a clamp property test over 20,000 random asks | `(cd contracts/token && AWS_LC_SYS_PREBUILT_NASM=1 cargo test)` | 129 |
| Brain contract: NEP-413 hash against NEAR AI's fixtures, binding tampering, MPC request shape, keys, staking, retirement | `(cd contracts/brain && AWS_LC_SYS_PREBUILT_NASM=1 cargo test)` | 59 |
| Courier, against a scripted HTTP mock | `(cd courier && AWS_LC_SYS_PREBUILT_NASM=1 cargo test)` | 16 |
| Test signer | `(cd test-signer && AWS_LC_SYS_PREBUILT_NASM=1 cargo test)` | 5 |
| Simulation: token model units, and golden replays of all three testnet deployments | `sim/run test` | 33 |

242 tests, all passing. `AWS_LC_SYS_PREBUILT_NASM=1` matters on Windows only. The token suite takes about 4 minutes, most of it the fuzz test (`CHAIR_FUZZ_SEEDS` and `CHAIR_FUZZ_STEPS` change its size).

Other commands:

```bash
sim/run                          # the simulation; the model chair is replayed from sim/cache, no model calls
pnpm readme                      # re-render the numbers in this README from results/
pnpm --filter @chair/web typecheck
pnpm build                       # the web app
```

The exact build commands for the contracts and the OutLayer modules are in [`docs/LAUNCH.md`](docs/LAUNCH.md). Rebuilt with rustc 1.95.0 from commit `a74b97a`, the token gives the code hash deployed at token3 and token4. Its code has not changed since; later commits set the Cargo `repository` field, which writes the repo link into the contract's NEP-330 metadata and moves the hash to `c4cdd3d4…`. The test signer gives the `version_key` token3 pins ([CLAIMS.md](CLAIMS.md), claims 12 and 13).

## Honest limits

- **Testnet today.** Everything on chain runs on NEAR testnet, as `token3.chair-dev.testnet`. The mainnet token `token.thechair.near` is not deployed.
- **The rulings so far are signed by a test key, not by a NEAR AI model.** On testnet the courier is a test-signer OutLayer project (`chair-dev.testnet/test-chair-signer`). It plays a deterministic chair that a prompt injection fools on purpose, and signs with a test key that is on token3's `model_signers`. The real courier needs a NEAR AI API key; it passes its tests against a mock, but has not yet run against NEAR AI.
- **Mainnet signers are verified but not yet in use.** `pnpm verify:signers` checks that each NEAR AI model's TDX quote binds its signing address to a fresh nonce and that NVIDIA's GPU attestation passes ([`results/signers-2026-11-10.json`](results/signers-2026-11-10.json)): GLM 5.3 Flash signs with `0x3b75…fa0c`, DeepSeek V4.1 with `0xfe00…337e`, and the gateway with `0xb98a…e779`. The Intel signature chain of the quotes is not checked. Kimi K3 is served without a per-response model key, so a Kimi meeting would be gateway-signed.
- **The owner is a single key** for the 48 h timelocked changes (signer allowlists and courier version). The proposal is public and slow, and nobody can veto it. Nothing else can change.
- **The simulation used Venice-hosted open models, not NEAR AI.** The model families match the IQ ladder; the hosts differ. Kimi K3 was never reached.
- **One seed.** The model chair ran on one seed, plus one control run and a seed probe. The deterministic policies ran on 20 seeds, and every comparison is checked against that seed noise.
- **The testnet brain stakes into a mock farm.** It has the same interface as `stake.dao`, but no real inference credits have been earned. The testnet brain still has its deployer key.
- **A courier operator could still choose among rulings** by fetching several completions for the same request. The pinned build fetches once per run, and the clamp limits any choice to one step per lever ([`docs/SECURITY.md`](docs/SECURITY.md)).
- **The simulated holders are invented**, not calibrated to real traders, and they never read the minutes.

## Also by us

Also by us at NEAR HACKATHON: Blindbook, a dark pool for NEAR Intents, https://github.com/RaYYeR220/blindbook

## License

MIT
