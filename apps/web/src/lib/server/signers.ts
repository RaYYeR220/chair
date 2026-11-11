import "server-only";
import older from "@results/signers-2026-11-10.json";
import latest from "@results/signers-2026-11-11.json";
import type { SignerInfo } from "@/lib/chair-types";
import { TEST_GATEWAY_SIGNER, TEST_SIGNER } from "@/lib/content/constitution";

/**
 * Who a ruling's signer is: NEAR AI's model and gateway keys come from
 * `pnpm verify:signers` (results/signers-*.json), each bound to a fresh nonce
 * in its TDX quote; the testnet test keys are the ones docs/LAUNCH.md lists.
 * A newer file wins over an older one.
 */

interface SignersFile {
  generated_at: string;
  models: {
    model: string;
    samples: { gateway?: { signing_address?: string | null } | null; model_attestations?: { signing_address?: string | null }[] | null }[];
  }[];
}

const FILES: { name: string; body: SignersFile }[] = [
  { name: "results/signers-2026-11-10.json", body: older as unknown as SignersFile },
  { name: "results/signers-2026-11-11.json", body: latest as unknown as SignersFile },
];

const KNOWN = new Map<string, SignerInfo>();
for (const f of FILES) {
  for (const m of f.body.models) {
    for (const s of m.samples) {
      for (const a of s.model_attestations ?? []) {
        if (a.signing_address) {
          const address = a.signing_address.toLowerCase();
          KNOWN.set(address, { address, kind: "model", model: m.model, source: f.name, verified_at: f.body.generated_at });
        }
      }
      const g = s.gateway?.signing_address?.toLowerCase();
      if (g) KNOWN.set(g, { address: g, kind: "gateway", model: null, source: f.name, verified_at: f.body.generated_at });
    }
  }
}
KNOWN.set(TEST_SIGNER, { address: TEST_SIGNER, kind: "test_key", model: null, source: "docs/LAUNCH.md", verified_at: null });
KNOWN.set(TEST_GATEWAY_SIGNER, { address: TEST_GATEWAY_SIGNER, kind: "test_key", model: null, source: "docs/LAUNCH.md", verified_at: null });

/** What is known about a recovered signer address; `unknown` when it is in none of the files. */
export function signerInfo(address: string | null | undefined): SignerInfo | null {
  if (!address) return null;
  const a = address.toLowerCase();
  return KNOWN.get(a) ?? { address: a, kind: "unknown", model: null, source: null, verified_at: null };
}
