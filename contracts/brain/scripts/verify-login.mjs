#!/usr/bin/env node
// Check the brain's last MPC signature exactly the way NEAR AI Cloud does
// (near-kit 0.18.3 `nep413::verify` with `require_full_access: true`, plus the
// login checks in cloud-api `crates/services/src/auth/near.rs`):
//
//   1. recompute sha256(u32_le(2^31+413) || borsh{message, nonce, recipient, callbackUrl})
//      from the payload, independently of the contract;
//   2. ed25519-verify the signature over that hash with `publicKey`;
//   3. view_access_key(accountId, publicKey) over RPC must be FullAccess;
//   4. login only: message == "Sign in to NEAR AI Cloud", recipient as expected,
//      nonce = 8-byte big-endian ms timestamp, not older than 5 minutes, not in the future.
//
// It prints the `POST /v1/auth/near` body. With --post it also sends it
// (mainnet only, https://cloud-api.near.ai) and prints the session response.
//
// Usage: node verify-login.mjs <brain-account> [--network testnet|mainnet] [--recipient cloud.near.ai] [--post]

import crypto from "node:crypto";

const args = process.argv.slice(2);
const brain = args.find((a) => !a.startsWith("--"));
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
if (!brain) {
  console.error("usage: node verify-login.mjs <brain-account> [--network testnet|mainnet] [--recipient cloud.near.ai] [--post]");
  process.exit(2);
}
const network = flag("network", brain.endsWith(".near") ? "mainnet" : "testnet");
const recipient = flag("recipient", "cloud.near.ai");
const post = args.includes("--post");
const RPC = network === "mainnet" ? "https://rpc.mainnet.fastnear.com" : "https://test.rpc.fastnear.com";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(s) {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error("bad base58");
    n = n * 58n + BigInt(i);
  }
  const out = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== "1") break;
    out.unshift(0);
  }
  return Buffer.from(out);
}

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}

async function view(account, method, a) {
  const res = await rpc("query", {
    request_type: "call_function",
    finality: "optimistic",
    account_id: account,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(a)).toString("base64"),
  });
  return JSON.parse(Buffer.from(res.result).toString());
}

function borshString(s) {
  const b = Buffer.from(s, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length);
  return Buffer.concat([len, b]);
}

function nep413Hash({ message, nonce, recipient, callbackUrl }) {
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(2 ** 31 + 413);
  const parts = [tag, borshString(message), Buffer.from(nonce), borshString(recipient)];
  parts.push(callbackUrl == null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), borshString(callbackUrl)]));
  return crypto.createHash("sha256").update(Buffer.concat(parts)).digest();
}

function ed25519Verify(pubB58, sigB64, msg) {
  const raw = b58decode(pubB58.replace(/^ed25519:/, ""));
  if (raw.length !== 32) throw new Error("public key must be 32 bytes");
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]);
  const key = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
  return crypto.verify(null, msg, key, Buffer.from(sigB64, "base64"));
}

const last = await view(brain, "get_last_signature", {});
if (!last) {
  console.error("no signature yet: call request_login first");
  process.exit(1);
}
const { signed_message: sm, payload, kind } = last;
const checks = [];
const check = (name, ok, detail = "") => {
  checks.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const hash = nep413Hash(payload);
check("nep413 hash recomputed off-chain matches the contract's", hash.toString("hex") === last.nep413_hash, hash.toString("hex"));
check("ed25519 signature verifies with publicKey over the hash", ed25519Verify(sm.publicKey, sm.signature, hash));
check("account is the brain", sm.accountId === brain);
const derived = await view(network === "mainnet" ? "v1.signer" : "v1.signer-prod.testnet", "derived_public_key", {
  path: "nearai-login",
  predecessor: brain,
  domain_id: 1,
});
check("publicKey is the MPC-derived key for (brain, nearai-login, domain 1)", derived === sm.publicKey, derived);
let perm = "missing";
try {
  const ak = await rpc("query", { request_type: "view_access_key", finality: "optimistic", account_id: brain, public_key: sm.publicKey });
  perm = typeof ak.permission === "string" ? ak.permission : "FunctionCall";
} catch (e) {
  perm = `missing (${e.message.slice(0, 80)})`;
}
check("publicKey is a FullAccess key of the brain", perm === "FullAccess", perm);
check("recipient", payload.recipient === recipient, payload.recipient);
if (kind === "login") {
  check("message", payload.message === "Sign in to NEAR AI Cloud");
  const ts = Number(Buffer.from(payload.nonce.slice(0, 8)).readBigUInt64BE());
  const age = Date.now() - ts;
  check("nonce timestamp within NEAR AI's 5-minute window", ts > 0 && age >= 0 && age <= 5 * 60 * 1000, `${Math.round(age / 1000)} s old`);
}

const body = { signed_message: sm, payload };
console.log("\nPOST /v1/auth/near body:\n" + JSON.stringify(body));

if (post) {
  if (network !== "mainnet") {
    console.error("\n--post needs a mainnet brain: NEAR AI Cloud verifies keys on mainnet RPC");
    process.exit(1);
  }
  const r = await fetch("https://cloud-api.near.ai/v1/auth/near", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "chair-brain-operator/0.1" },
    body: JSON.stringify(body),
  });
  console.log(`\n/v1/auth/near -> ${r.status}`);
  console.log(await r.text());
}
process.exit(checks.every(Boolean) ? 0 : 1);
