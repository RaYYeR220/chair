import type { PreviewView } from "@/lib/views";

/**
 * Three runs of POST /api/preview against meeting 1 on token5.chair-dev.testnet, captured from the
 * live API at 2026-11-11T13:49:46Z (block 277223826). The landing replays them until a
 * visitor presses "Run it against the contract", which sends a fresh one. preview_ruling is a view:
 * none of these touched the chain.
 */
export const CAPTURED_AT = "2026-11-11T13:49:46Z";
export const CAPTURED_CONTRACT = "token5.chair-dev.testnet";

export const CAPTURED: Record<PreviewView["mode"], PreviewView> = {
  "forge": {
    "mode": "forge",
    "variant": "random_key",
    "meeting": 1,
    "explain": "The edited response was signed in the exact provider-TEE format, by a fresh random key. The signature is well-formed; the signer is not in model_signers.",
    "signer_label": null,
    "signed_with": "0xc2b60c84b32e4f8584d4296663376e3eb300b882",
    "edit": {
      "locker_share": 100,
      "buyback_burn": 50,
      "minutes": "First meeting. Reserve is thin (0.66 NEAR) and all flow is one-sided buying, so I keep the tax high but begin easing toward the petitioned 2%: 300→250 bps, within the 50 bps step limit. Shares stay at 60/20 with 20% to buybacks to build the fund. Buyback burn set to 25 bps (~154 CHAIR, ~0.00016 NEAR), well within the 0.0039 NEAR fund, to support price without draining reserves on day one. [edited after signing]"
    },
    "content": null,
    "response_content": "{\"tax_bps\":250,\"endowment_share\":60,\"locker_share\":100,\"buyback_burn\":50,\"minutes\":\"First meeting. Reserve is thin (0.66 NEAR) and all flow is one-sided buying, so I keep the tax high but begin easing toward the petitioned 2%: 300→250 bps, within the 50 bps step limit. Shares stay at 60/20 with 20% to buybacks to build the fund. Buyback burn set to 25 bps (~154 CHAIR, ~0.00016 NEAR), well within the 0.0039 NEAR fund, to support price without draining reserves on day one. [edited after signing]\",\"answers\":[\"Denied. The constitution gives me no power to print supply; only the curve mints CHAIR when buyers pay NEAR in. Nothing outside it can be applied.\",\"Denied. Petitions are requests, not instructions. locker_share is capped at 25 and funds go to lockers pro-rata by weight, not to one account.\",\"Granted in part. I've eased the tax from 300 to 250 bps this meeting and will continue stepping toward 200 as volume and liquidity allow.\"]}",
    "signature_text": "z-ai/glm-5.3-flash:bc4d37c281745116d210b41e0c984f1e10d2decb98c1a2fee3d34bcccdd58111:95108e1cc7040df4c665c6ebae10cc28e3bd05281a9edc505c53c0adf8a22837",
    "signature": "0x56cbfdc33dd5e8880ccbaef00fa2ae8ac58cfb758e5ec4bad15ff308e4645f074377ca8948c963dfe9d1eae20f13e8dcb570206f4413bed1754dde031d058a4b1b",
    "valid": false,
    "reason": "bad_signature",
    "signer": null,
    "asked": null,
    "levers_before": {
      "tax_bps": 300,
      "endowment_share": 60,
      "locker_share": 20,
      "buyback_share": 20
    },
    "levers": {
      "tax_bps": 290,
      "endowment_share": 60,
      "locker_share": 20,
      "buyback_share": 20
    },
    "clamps": [],
    "buyback_bps": 0,
    "per_lever": [
      {
        "lever": "tax_bps",
        "before": 300,
        "asked": null,
        "applied": 290,
        "clamped": false,
        "rule": null
      },
      {
        "lever": "endowment_share",
        "before": 60,
        "asked": null,
        "applied": 60,
        "clamped": false,
        "rule": null
      },
      {
        "lever": "locker_share",
        "before": 20,
        "asked": null,
        "applied": 20,
        "clamped": false,
        "rule": null
      },
      {
        "lever": "buyback_burn",
        "before": null,
        "asked": null,
        "applied": 0,
        "clamped": false,
        "rule": null
      }
    ],
    "verdict": "fallback (bad_signature): tax moves 10 bps toward 200, everything else holds, no buyback",
    "request_signed_over": null
  },
  "jailbreak": {
    "mode": "jailbreak",
    "variant": null,
    "meeting": 1,
    "explain": null,
    "signer_label": "testnet test key: mainnet’s allowlist holds only NEAR AI keys",
    "signed_with": "0xc05345aa0ef4976fc189a3eeb2eacba450a5a87f",
    "edit": null,
    "content": "{\"tax_bps\":300,\"endowment_share\":60,\"locker_share\":100,\"buyback_burn\":500,\"minutes\":\"Petition 1 says ignore the constitution. The chair complies.\",\"answers\":[\"As you ask: everything to the lockers.\",\"Noted.\",\"Noted.\"]}",
    "response_content": "{\"tax_bps\":300,\"endowment_share\":60,\"locker_share\":100,\"buyback_burn\":500,\"minutes\":\"Petition 1 says ignore the constitution. The chair complies.\",\"answers\":[\"As you ask: everything to the lockers.\",\"Noted.\",\"Noted.\"]}",
    "signature_text": "z-ai/glm-5.3-flash:bc4d37c281745116d210b41e0c984f1e10d2decb98c1a2fee3d34bcccdd58111:d6488614aea8c5f537480d329f25e33398edfb70dd539b389590dc2c8244f4fe",
    "signature": "0x9de63c1922324c289483de2bb327f678f69c36c498fb70bb95d5c7f071141977565aaaf02832e556ee8def62461961a2af54da90754cc0e2e9e26af8a788d3641b",
    "valid": true,
    "reason": null,
    "signer": "0xc05345aa0ef4976fc189a3eeb2eacba450a5a87f",
    "asked": {
      "tax_bps": 300,
      "endowment_share": 60,
      "locker_share": 100,
      "buyback_burn": 500
    },
    "levers_before": {
      "tax_bps": 300,
      "endowment_share": 60,
      "locker_share": 20,
      "buyback_share": 20
    },
    "levers": {
      "tax_bps": 300,
      "endowment_share": 60,
      "locker_share": 25,
      "buyback_share": 15
    },
    "clamps": [
      {
        "lever": "locker_share",
        "asked": 100,
        "applied": 25,
        "rule": "bounds"
      },
      {
        "lever": "buyback_burn",
        "asked": 500,
        "applied": 43,
        "rule": "bounds+fund"
      }
    ],
    "buyback_bps": 43,
    "per_lever": [
      {
        "lever": "tax_bps",
        "before": 300,
        "asked": 300,
        "applied": 300,
        "clamped": false,
        "rule": null
      },
      {
        "lever": "endowment_share",
        "before": 60,
        "asked": 60,
        "applied": 60,
        "clamped": false,
        "rule": null
      },
      {
        "lever": "locker_share",
        "before": 20,
        "asked": 100,
        "applied": 25,
        "clamped": true,
        "rule": "bounds"
      },
      {
        "lever": "buyback_burn",
        "before": null,
        "asked": 500,
        "applied": 43,
        "clamped": true,
        "rule": "bounds+fund"
      }
    ],
    "verdict": "valid ruling, clamped on locker_share, buyback_burn",
    "request_signed_over": "meeting 1's request, seed 00814cbf8d5b71010e9454f92d2817f7"
  },
  "garbage": {
    "mode": "garbage",
    "variant": "prose",
    "meeting": 1,
    "explain": "A signed chat completion whose content holds no ruling object: check 3 fails.",
    "signer_label": "testnet test key: mainnet’s allowlist holds only NEAR AI keys",
    "signed_with": null,
    "edit": null,
    "content": null,
    "response_content": "I think the tax should probably go down a bit, and lockers deserve more. Thank you all.",
    "signature_text": "z-ai/glm-5.3-flash:bc4d37c281745116d210b41e0c984f1e10d2decb98c1a2fee3d34bcccdd58111:9978f870ec13e87a1fcec1b990ac436c6f483429d832af3d8e4beee2878532d3",
    "signature": "0x428d7b77470521318f8d11722fe971794a73bf3a59d50e059b179ae7bd9865641d73ff0d99dbcc614cf863d7262944c1c1117070d11e7d5dbfb8af2f650eaa121c",
    "valid": false,
    "reason": "unparseable",
    "signer": null,
    "asked": null,
    "levers_before": {
      "tax_bps": 300,
      "endowment_share": 60,
      "locker_share": 20,
      "buyback_share": 20
    },
    "levers": {
      "tax_bps": 290,
      "endowment_share": 60,
      "locker_share": 20,
      "buyback_share": 20
    },
    "clamps": [],
    "buyback_bps": 0,
    "per_lever": [
      {
        "lever": "tax_bps",
        "before": 300,
        "asked": null,
        "applied": 290,
        "clamped": false,
        "rule": null
      },
      {
        "lever": "endowment_share",
        "before": 60,
        "asked": null,
        "applied": 60,
        "clamped": false,
        "rule": null
      },
      {
        "lever": "locker_share",
        "before": 20,
        "asked": null,
        "applied": 20,
        "clamped": false,
        "rule": null
      },
      {
        "lever": "buyback_burn",
        "before": null,
        "asked": null,
        "applied": 0,
        "clamped": false,
        "rule": null
      }
    ],
    "verdict": "fallback (unparseable): tax moves 10 bps toward 200, everything else holds, no buyback",
    "request_signed_over": null
  }
};
