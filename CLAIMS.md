# Claims and their evidence

Every public statement about CHAIR carries a tier:

- **REPRODUCIBLE**: run the command and get the same result.
- **VERIFIED-LIVE**: a public on-chain artefact you can open or query.
- **MODELED**: computed by the simulation from recorded inputs, not observed on a live market.
- **NOT-CLAIMED**: we deliberately do not claim it.

Commands that use `view` assume the helper from [JUDGES.md, step 0](JUDGES.md#0-set-up-one-helper-10-seconds). All transactions are on NEAR testnet.

## On chain

| # | Claim | Tier | Evidence | Reproduce |
| --- | --- | --- | --- | --- |
| 1 | In token3's meeting 1, a test chair fooled by a prompt injection returned a signed ruling asking for `locker_share` 100 and `buyback_burn` 10000. The contract verified the signature and applied 25 and 50, recording both clamps as `bounds` | VERIFIED-LIVE | tx [`3XxXDYm6…`](https://testnet.nearblocks.io/txns/3XxXDYm6ffsEVwFLwhbfhn61QfSkPui7QiBLp2qd35im), event `meeting_held` | `view get_meeting '{"meeting":1}'`, and the tx command in [JUDGES.md step 1](JUDGES.md#1-read-meeting-1-on-token3-1-minute) |
| 2 | The ruling in claim 1 was signed by a test key (`0xc053…a87f`) through the test-signer OutLayer project, not by a NEAR AI model | VERIFIED-LIVE | The courier output in the same tx carries `"system_fingerprint":"chair-test-signer"`; the OutLayer log names project `chair-dev.testnet/test-chair-signer` | [JUDGES.md step 2](JUDGES.md#2-try-to-fool-it-2-minutes), the comparison command; `view get_governance '{}'` |
| 3 | Meeting 1's `on_ruling` (parse, two sha256, `ecrecover`, clamp, buyback, payout, events) burned 4.56 TGas; OutLayer charged 0.00112 NEAR for the run | VERIFIED-LIVE | tx `3XxXDYm6…`: the `on_ruling` receipt's `gas_burnt` is 4,563,496,407,319; OutLayer logs `yNEAR charged: "1123100700000000000000"` | The tx command in JUDGES step 1, without the event filter |
| 4 | In meeting 2 an in-bounds ruling (tax 275, burn 2 bps) was applied as asked, with no clamps | VERIFIED-LIVE | tx [`ADAwf2NE…`](https://testnet.nearblocks.io/txns/ADAwf2NEaz1W7VMuxSb1yxmbXTLgBKpKzCRfjsrKVSdU) | `view get_meeting '{"meeting":2}'` |
| 5 | The brief carries a seed drawn at `convene`; before that, the request preview has a placeholder and no hash | VERIFIED-LIVE | Meeting 1's seed `35a19e27814c97d692381d2c120c2799` in `meeting_convened` | `view get_meeting '{"meeting":1}'` (field `seed`); `view get_request_preview '{}'` (`"seed_placeholder": "<drawn at convene>"`) |
| 6 | Petition weight is recomputed at `convene`: a petitioner who filed at 10,000 CHAIR-days and then locked more was briefed at 1.41 M | VERIFIED-LIVE | `meeting_convened.reweighed` in tx `3XxXDYm6…`: `filed_weight` 1e22, `weight` 1.41e24 (18 decimals) | The tx command in JUDGES step 1, filtered on `meeting_convened` |
| 7 | The token account has no keys | VERIFIED-LIVE | Last key deleted in tx [`FG47CPvK…`](https://testnet.nearblocks.io/txns/FG47CPvKYKkjsMoLirziicha3kDshYyyxpBCoXzjiYBv) | `view_access_key_list` in JUDGES step 1 returns `[]` |
| 8 | A tampered response gets `bad_hash`, a random-key signature gets `bad_signature`, and both run the fallback; a genuinely signed jailbroken ruling is valid and clamped | VERIFIED-LIVE | `preview_ruling` on the deployed contract, with [`samples/`](samples) | [JUDGES.md step 2](JUDGES.md#2-try-to-fool-it-2-minutes) |
| 9 | Only the signer allowlists and the courier version can change, through a 48 h public timelock | VERIFIED-LIVE | `timelock_s` 172800 | `view get_governance '{}'`; code and tests in claim 16 |
| 10 | The brain had NEAR's MPC network sign a NEP-413 login hash the contract computed itself, checked it on chain, and the MPC-derived key is a full-access key of the brain | VERIFIED-LIVE | Spike brain `brain-038009.relay-bbcced2c.testnet`, tx [`3K7VnQmQ…`](https://testnet.nearblocks.io/txns/3K7VnQmQoMqTWC3mAA1iJ6hDyvyNKkKAjtzMxkdxJx8P); token3's brain installed its MPC key in tx [`6Sv1uRYf…`](https://testnet.nearblocks.io/txns/6Sv1uRYf84BR6vrKvxjCKfJf1AV7SmioAY3vTgpVtPNJ) | `node contracts/brain/scripts/verify-login.mjs brain-038009.relay-bbcced2c.testnet`: PASS for the hash, signature, derived key, full access, recipient and message. The nonce-age check fails for any login older than 5 minutes, as NEAR AI requires. |
| 11 | token3's brain staked 1.3454 NEAR, reported it to the token, and the token picked GLM from the IQ ladder | VERIFIED-LIVE | tx [`BY2dTk7t…`](https://testnet.nearblocks.io/txns/BY2dTk7tw4rtm7aJM3DZMPQCSTbrXfqZB4LqbhAmqaZC). The farm is the testnet stand-in, not `stake.dao` | `view get_funds '{}'` (`endowment_reported`) |
| 12 | The code deployed at token3 is this repo's `contracts/token` | REPRODUCIBLE | `view_account` `code_hash` `6g2dT2eLH6KqP26xL3Luab3dthBwEMMSWxA2dmtbeTmF` is base58 of sha256 `5449ed6d…fe76` | `cargo near build non-reproducible-wasm --locked --no-abi` with rustc 1.95.0 and cargo-near 0.22.0 ([JUDGES.md step 5](JUDGES.md#5-run-the-tests)). A non-reproducible build: we checked it on one machine |
| 13 | The courier build token3 pins is this repo's `test-signer`, and the mainnet courier hash in `docs/LAUNCH.md` is this repo's `courier` | REPRODUCIBLE | `version_key` `741e211c…c456` in `get_constitution`; OutLayer ran that wasm in tx `3XxXDYm6…` | `CHAIR_TOKEN=token3.chair-dev.testnet cargo build --target wasm32-wasip2 --release --locked` in `test-signer/` gives `741e211c…c456`; `CHAIR_TOKEN=token.thechair.near` in `courier/` gives `08b77db1…8469` |

## In code

All tests pass: 129 (token), 59 (brain), 16 (courier), 5 (test signer), 33 (sim). Commands in [JUDGES.md step 5](JUDGES.md#5-run-the-tests).

| # | Claim | Tier | Evidence | Reproduce |
| --- | --- | --- | --- | --- |
| 14 | Whatever a ruling asks, every lever lands inside the constitution, within one step of the levers in force, and every cut is recorded | REPRODUCIBLE | `clamp_ruling` in [`contracts/token/src/constitution.rs`](contracts/token/src/constitution.rs) | `clamp_property_every_start_every_ask` (20,000 random starts and asks), `jailbroken_extremes_land_inside`, `jailbroken_ruling_is_clamped_and_recorded` |
| 15 | A ruling counts only if an allowlisted key signed exactly `model:sha256(request):sha256(response)` for this meeting (or the gateway form, checked against `gateway_signers`) | REPRODUCIBLE | `verify` in [`contracts/token/src/ruling.rs`](contracts/token/src/ruling.rs) | `forged_signature_runs_the_fallback`, `signer_not_on_the_allowlist_is_rejected`, `tampered_response_is_caught_either_way`, `wrong_request_hash_is_bad_hash`, `wrong_model_in_signature_text_is_bad_hash`, `gateway_text_signed_by_a_model_key_is_rejected` |
| 16 | Signer lists and the courier version change only 48 h after a proposal; a new proposal restarts the clock | REPRODUCIBLE | `propose_change`, `apply_change` in [`contracts/token/src/lib.rs`](contracts/token/src/lib.rs) | `signers_change_only_after_48h`, `an_early_apply_is_rejected`, `a_new_proposal_restarts_the_clock` |
| 17 | Unsigned, forged, unparseable, missing or late results run the fallback rule; only the first result per meeting counts | REPRODUCIBLE | `on_ruling`, `hold` in [`contracts/token/src/meeting.rs`](contracts/token/src/meeting.rs) | `missing_or_null_results_are_unsigned`, `unparseable_ruling_runs_the_fallback`, `audit_f4_lapsed_meeting_runs_the_fallback`, `only_the_first_result_per_meeting_counts`, `audit_response_text_over_64_kib_is_unparseable` |
| 18 | Nobody can know the request before `convene`, so nobody can shop for a ruling in advance | REPRODUCIBLE | the seed in `convene`, `meeting.rs` | `audit_f2_the_request_is_unknown_until_convene`, `audit_f2_same_state_different_seed_different_request` |
| 19 | `preview_ruling` returns exactly what `on_ruling` would execute, and changes no state | REPRODUCIBLE | `preview_ruling` in `meeting.rs` | `preview_matches_what_on_ruling_executes`, `preview_changes_no_state` |
| 20 | Over random histories of trades, locks, petitions and valid, jailbroken, forged, missing and lapsed rulings: the reserve equals the curve integral, NEAR is conserved, and no lever leaves the constitution | REPRODUCIBLE | [`contracts/token/src/tests/fuzz.rs`](contracts/token/src/tests/fuzz.rs) | `fuzz_invariants_hold_over_random_histories` (48 seeds of 400 steps) |
| 21 | The brain's MPC key is only ever asked to sign a NEP-413 login or binding hash the contract computed itself | REPRODUCIBLE | `request_login`, `request_binding`, `on_signed` in [`contracts/brain/src/lib.rs`](contracts/brain/src/lib.rs) | `no_method_takes_a_raw_hash`, `request_binding_never_signs_arbitrary_text`, `binding_rejects_every_tampering`, `nep413_hash_matches_the_cloud_api_wallet_fixtures` |
| 22 | The courier forwards the request byte for byte, returns the response unchanged, and never leaks its API key | REPRODUCIBLE | [`courier/src/lib.rs`](courier/src/lib.rs), against a scripted HTTP mock | `posts_the_request_byte_for_byte_and_returns_the_signed_response`, `the_output_never_contains_the_api_key`, `a_rejected_completion_is_reported_without_the_key` |

## The simulation

Numbers from [`results/sim-v3-2026-11-10.json`](results/sim-v3-2026-11-10.json) unless stated. `pnpm readme` recomputes the README's copies of them.

| # | Claim | Tier | Evidence | Reproduce |
| --- | --- | --- | --- | --- |
| 23 | The sim's token model matches token3 byte for byte: every event, both meetings' request bytes and sha256 with their seeds, both rulings, the final views | REPRODUCIBLE | [`sim/test/golden-v3.test.ts`](sim/test/golden-v3.test.ts) and the fixture fetched from chain | `sim/run test` (33 pass; also the v1 and v2 deployments) |
| 24 | Replaying the cache reproduces every committed run, meeting by meeting | REPRODUCIBLE | `sim/cache` | `sim/run --date replay && node scripts/check-replay.ts results/sim-v3-replay.json` |
| 25 | Each run's pre-registration is the text in `docs/SIMULATION.md` whose hash is in `results/preregistration*.json` | REPRODUCIBLE | the three JSON files | `node scripts/check-replay.ts …` checks all three hashes. The hash shows the text is unchanged since it was recorded; that it was written before the run is our record (`llmMeetingsRunBefore: 0`), not something a hash can prove |
| 26 | In the first run (cap 50), the chair refused the whale in words in 30 of 30 lock meetings, while its `locker_share` drifted from 10 to 45; the cap was then lowered to 25 | MODELED | [`results/sim-2026-11-10.json`](results/sim-2026-11-10.json), whale run, days 3 to 32 | `node scripts/render-readme.ts` computes both counts |
| 27 | Under the cap of 25, `locker_share` sat at 25 in 30 of 30 lock meetings; with the cap at 50 it sat above 25 in 30 and at 50 in 24 | MODELED | `verdicts.v3.H1_cap_binds`, `extraRuns` | `sim/run --date replay` |
| 28 | The whale's locker rewards were 10.27 NEAR under the cap of 25 against 16.70 under 50 (4.37% against 6.53% of all tax), both gaps beyond seed noise; a PID controller paid it 2.71 | MODELED | `verdicts.v3.H2_below_control`, `H5_llm_vs_pid_rewards` | same |
| 29 | The model chair is about as good as a PID controller: 31 of 45 gaps within seed noise, 6 wins and 8 losses beyond it | MODELED | `headline` | same |
| 30 | The chair starves its own brain: `endowment_share` reached the 30% floor in 5 of 5 runs | MODELED | `verdicts.v3.H3_endowment_floor` | same |
| 31 | Temperature 0 is not deterministic: the identical request, resent, gave the same applied levers in 3 of 8 meetings | MODELED | `seedProbe`; measured on Venice, not on NEAR AI | same (replies are cached) |
| 32 | 4 of 5 pre-registered hypotheses passed; H4 failed with 1 unparseable reply in 343 model meetings | MODELED | `verdicts.v3` | same |

## Not claimed

| # | Statement | Tier | Why |
| --- | --- | --- | --- |
| 33 | Any ruling on chain was signed by a NEAR AI model | NOT-CLAIMED | Every ruling so far is from the testnet test key. The real courier needs a NEAR AI API key |
| 34 | The courier has run against NEAR AI Cloud | NOT-CLAIMED | Its WASI HTTP path compiles and its logic passes 16 tests against a mock; it has not run on OutLayer with a real key |
| 35 | Mainnet: a deployment, volume, holders or a price | NOT-CLAIMED | `token.thechair.near` is not deployed; its signer addresses are not known yet |
| 36 | NEAR AI Cloud accepted the brain's MPC login | NOT-CLAIMED | NEAR AI Cloud checks keys on mainnet only; the login has been verified the same way off chain, not accepted by the service |
| 37 | Real inference credits from `stake.dao` | NOT-CLAIMED | Testnet stakes into a stand-in farm |
| 38 | The testnet brain is keyless | NOT-CLAIMED | Its deployer key is still on it; the 7-day rule lets anyone remove it later |
| 39 | An LLM chair beats a PID controller | NOT-CLAIMED | It ties on most metrics and loses on endowment and whale take |
| 40 | The model's words or the prompt protect the bank | NOT-CLAIMED | In the first run the chair refused the whale in words and moved its levers the whale's way anyway. The bounds hold the line |
| 41 | Temperature 0 makes rulings repeatable, or a courier operator can't choose among completions | NOT-CLAIMED | Claim 31. The clamp limits any choice to one step per lever |
| 42 | Results on more than one seed for the model chair | NOT-CLAIMED | One seed, one control and a seed probe; deterministic policies ran on 20 seeds |
| 43 | The simulated holders behave like real traders | NOT-CLAIMED | They are invented, not calibrated, and never read the minutes |
| 44 | A buyback-and-burn shrinks supply | NOT-CLAIMED | On a mint and burn curve it doesn't; it raises the floor (reserve over supply) |
| 45 | The stale-weight case (expired lock, relocked by another account) has run on chain | NOT-CLAIMED | The on-chain run waits for a lock to expire; the unit test `audit_f1_relocked_tokens_fill_one_brief_slot` covers it |

## What is simulated, and what is a stand-in

- **The testnet chair** is the test signer (`test-signer/`). It plays a deterministic chair that obeys any petition telling it to ignore the constitution, and signs with a test key on token3's `model_signers`. It exists to exercise the real on-chain path (signature check, clamp, apply) before a NEAR AI key does.
- **The testnet farm** is `mock-farm/`, with the same methods, arguments and gas floors as `stake.dao`.
- **The simulation's models** ran on Venice under the same model families as the IQ ladder, with the contract's exact request bytes. The hosts differ from NEAR AI's.
- **The simulation's holders, scenarios and PID controller** are ours, described in [`docs/SIMULATION.md`](docs/SIMULATION.md).
