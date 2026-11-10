import "server-only";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { createHash, randomBytes } from "node:crypto";

/**
 * EIP-191 signing, as NEAR AI's TEE keys sign and as the token checks
 * (contracts/token/src/ruling.rs): `keccak256("\x19Ethereum Signed
 * Message:\n" + len + text)`, signature `0x r ‖ s ‖ v` with v ∈ {27, 28}.
 */

export const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function eip191(text: string): Uint8Array {
  const body = Buffer.from(text, "utf8");
  const prefix = Buffer.from(`\x19Ethereum Signed Message:\n${body.length}`, "utf8");
  return keccak_256(Buffer.concat([prefix, body]));
}

function keyBytes(hexKey: string): Uint8Array {
  const h = hexKey.startsWith("0x") ? hexKey.slice(2) : hexKey;
  return Uint8Array.from(Buffer.from(h, "hex"));
}

export function addressOf(hexKey: string): string {
  const pub = secp256k1.getPublicKey(keyBytes(hexKey), false);
  return `0x${toHex(keccak_256(pub.slice(1)).slice(12))}`;
}

export function eip191Sign(hexKey: string, text: string): string {
  const sig = secp256k1.sign(eip191(text), keyBytes(hexKey));
  return `0x${toHex(sig.toCompactRawBytes())}${(27 + sig.recovery).toString(16)}`;
}

/** A key nobody has ever registered anywhere: what a forger has. */
export function randomKey(): string {
  for (;;) {
    const k = randomBytes(32);
    if (secp256k1.utils.isValidPrivateKey(k)) return k.toString("hex");
  }
}

/** The provider-TEE text: `model:sha256(request):sha256(response_text)`. */
export function providerText(model: string, requestSha256: string, responseText: string) {
  return `${model}:${requestSha256}:${sha256Hex(responseText)}`;
}

/** A chat-completions response body around `content`, compact. */
export function chatCompletion(opts: { id: string; model: string; content: string; created: number; fingerprint: string }) {
  return JSON.stringify({
    id: opts.id,
    object: "chat.completion",
    created: opts.created,
    model: opts.model,
    system_fingerprint: opts.fingerprint,
    choices: [{ index: 0, message: { role: "assistant", content: opts.content }, finish_reason: "stop" }],
  });
}
