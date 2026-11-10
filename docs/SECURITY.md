# CHAIR security notes

CHAIR's promise is narrow: the AI can be fooled, the contract can't. Before mainnet the token and brain contracts went through a security review. It found five issues and three places worth hardening. All of them are fixed in token v3 and the current brain, each with a regression test (`contracts/token/src/tests/audit_findings.rs`, `contracts/brain/src/tests.rs`). Token v3 runs on testnet as `token3.chair-dev.testnet` (`docs/LAUNCH.md`).

## Findings and fixes

| # | What could happen | Fix |
| --- | --- | --- |
| 1 | **Stale petition weight.** A petition kept the weight it had when filed. Tokens whose lock had expired could be relocked by another account, and the same tokens filled two of the brief's three slots. | Filing needs a lock that runs past the next possible meeting. At `convene`, every queued petitioner's weight is recomputed from the locks still active then; anyone at zero is dropped, and the three heaviest go into the brief. The queue holds up to 8, one per account. |
| 2 | **The brief could be ground.** The exact request was public before `convene`, so anyone could try it against NEAR AI, nudge the state with a dust buy, and convene once they liked the ruling. | The brief carries a `seed`: 16 bytes of the convening block's randomness, right after `meeting`. Nobody knows the request before that block. The preview shows a placeholder instead of the seed and has no hash. The system prompt is unchanged (sha256 `ea189faf…377c`). |
| 3 | **Uncapped refund.** On a failed courier call, the token refunded the convener's whole deposit, whatever its size, from its own balance. | `convene` takes exactly the configured OutLayer deposit (0.015 NEAR), and a failure refunds at most that. |
| 4 | **A lapsed meeting ran nothing.** If a ruling never arrived, the meeting lapsed without applying the fallback rule the constitution promises. | The next `convene` first runs the fallback for the lapsed meeting, records reason `lapsed`, and only then convenes. It asks for 20 TGas more when it has a lapse to settle. |
| 5 | **The brain's deployer key could be stripped too early.** `remove_key` was open to anyone the moment the login key was installed, before the setup was checked. | For 7 days after `install_login_key`, only the brain account itself may remove keys. After that anyone may, so a forgotten deployer key can always go and the brain still ends up trustless. |

## Hardening

- **`ft_resolve_transfer` gas** rose from 5 to 15 TGas; `ft_transfer_call` now keeps 40 TGas back for itself and the resolve.
- **Courier result size.** A `response_text` over 64 KiB is `unparseable` and runs the fallback before it is hashed or parsed, so `on_ruling` can always finish.
- **Storage margin.** At worst, contract-level state (64 meeting records, root state, the last request, the petition queue) reaches about 77 KB, 0.77 NEAR. The token account is funded with the code plus at least 2 NEAR (`docs/LAUNCH.md`), so storage never eats into the reserve or the funds.

## Residual risks

- **A courier worker can still choose among rulings.** The request is fixed at `convene`, but whoever runs the courier could fetch several completions for it from NEAR AI and return the one it prefers. `temperature: 0` does not prevent this: in the simulation, asking the identical request again kept the same levers in only 3 of 8 meetings, though the shares never moved (see `docs/SIMULATION.md`). What limits it: the pinned courier build fetches once per run inside OutLayer's TDX enclave, so picking means running the job again; the model runs in a TEE that signs only what it produced; and the clamp bounds whatever comes back to one step per lever per meeting.
- **The block producer sees the seed first.** The seed is the convening block's randomness. Its producer could know it before anyone else, though it still can't choose the brief, and it would have to collude with the courier to gain anything.
- **A failed courier call can cost the token one deposit.** If OutLayer refunds the convener and also reports failure, the token's refund is a second one: at most 0.015 NEAR per meeting, from the storage margin.
- **Petition queue crowding.** A light petition can be pushed out of the 8-slot queue by heavier ones filed after it. That is the token-weighted design, and pushing it out takes 8 locks heavier than it.
- **Token-weighted steering.** Petitions are weighted by locked tokens by design. The constitution, not the model, holds the line: `locker_share` can never pass 25%, and every lever moves at most one step per meeting.
