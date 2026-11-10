/**
 * Which keys may sign a ruling? This script answers from NEAR AI Cloud's own
 * attestation reports, with nothing taken on trust from NEAR AI's API.
 *
 *   pnpm verify:signers                          # the IQ ladder from SPEC §7
 *   pnpm verify:signers --token token.thechair.near   # the ladder and allowlists of a live token
 *   node scripts/verify-signers.ts --models z-ai/glm-5.3-flash --samples 5
 *
 * For each model on the ladder it asks
 * `GET https://cloud-api.near.ai/v1/attestation/report?model=<m>&signing_algo=ecdsa&nonce=<fresh 32 bytes>`
 * a few times, each with a new nonce, and checks every `signing_address` in the report:
 *
 *   (a) TDX binding. The Intel TDX quote's `report_data` (bytes 568..632 of the
 *       quote) must be exactly `address ‖ 12 zero bytes ‖ our nonce`. A key that
 *       lives outside the enclave can't appear there, and an old quote can't
 *       carry a nonce we only just drew. For a model key, `signing_public_key`
 *       must also hash (keccak-256) to the address.
 *   (b) GPU. The model's NVIDIA evidence goes to NVIDIA's Remote Attestation
 *       Service. The answer is a JWT; we check its ES384 signature against
 *       NVIDIA's published keys, `x-nvidia-overall-att-result == true`, and that
 *       `eat_nonce` is our nonce. The gateway runs on CPU-only TDX and has no GPU
 *       evidence, so (b) does not apply to it.
 *   (c) Kind. A key under `model_attestations[]` whose `model_name` is the
 *       model we asked for is a model (provider TEE) signer: it signs
 *       `model:sha256(request):sha256(response)`, which the token checks against
 *       `model_signers`. The key under `gateway_attestation` is the cloud-api
 *       gateway's: it signs `sha256(request):sha256(response)`, checked against
 *       `gateway_signers`. The script reads this from the report's structure.
 *
 * A key is listed only if every check passed in every sample it appeared in.
 * Models served by a third party (Chutes) have no per-response key: NEAR AI's
 * gateway signs their responses. For those the script checks the provider's
 * own binding (report_data = sha256(nonce ‖ e2e_pubkey) ‖ sha256(SPKI)) and GPU.
 *
 * Not checked here: the Intel DCAP signature chain of each quote and the TCB
 * measurements (use `dcap-qvl` on the quote, and compare the compose hash with
 * NEAR AI's published images). NRAS is trusted for the GPU verdict.
 *
 * Output: `results/signers-<UTC date>.json` (or `--out`). Exit code 1 if a check
 * failed, a ladder model is not served, or `--token`'s allowlists differ from
 * the verified keys.
 */
import { createHash, createPublicKey, randomBytes, verify as verifySig, X509Certificate } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const API = "https://cloud-api.near.ai";
const NRAS = "https://nras.attestation.nvidia.com/v3/attest/gpu";
const NRAS_JWKS = "https://nras.attestation.nvidia.com/.well-known/jwks.json";
const RPC = { mainnet: "https://rpc.mainnet.fastnear.com", testnet: "https://test.rpc.fastnear.com" } as const;

/** SPEC §7 and docs/LAUNCH.md (mainnet `ladder`). `--token` reads it from chain instead. */
const LADDER = [
  { model: "z-ai/glm-5.3-flash", min_endowment_near: 1 },
  { model: "deepseek-ai/DeepSeek-V4.1-Flash-1017", min_endowment_near: 50 },
  { model: "moonshotai/kimi-k3", min_endowment_near: 500 },
];

// ------------------------------------------------------------------ arguments

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
if (argv.includes("--help") || argv.includes("-h")) {
  console.log("usage: node scripts/verify-signers.ts [--models a,b] [--samples 3] [--token <account>] [--network mainnet|testnet] [--out file]");
  process.exit(0);
}
const samples = Math.max(1, Number(flag("samples") ?? 3));
const network = (flag("network") ?? "mainnet") as keyof typeof RPC;
const tokenId = flag("token");
const today = new Date().toISOString().slice(0, 10);
const outFile = flag("out") ?? `results/signers-${today}.json`;

// ------------------------------------------------------------------ helpers

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();
const lower = (a: string) => a.toLowerCase();
const b64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** keccak-256 (the Ethereum one, not SHA3-256), enough for public key -> address. */
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n, 0x000000000000808bn,
  0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an, 0x0000000000000088n,
  0x0000000080008009n, 0x000000008000000an, 0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n,
  0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]];
const M64 = (1n << 64n) - 1n;
const rotl = (v: bigint, n: number) => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & M64);
function keccak256(data: Uint8Array): Buffer {
  const rate = 136;
  const msg = new Uint8Array(data.length + rate - (data.length % rate));
  msg.set(data);
  msg[data.length] ^= 0x01;
  msg[msg.length - 1] ^= 0x80;
  const A: bigint[] = new Array(25).fill(0n);
  for (let off = 0; off < msg.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let v = 0n;
      for (let b = 7; b >= 0; b--) v = (v << 8n) | BigInt(msg[off + i * 8 + b]);
      A[i] ^= v;
    }
    for (let round = 0; round < 24; round++) {
      const C = [0, 1, 2, 3, 4].map((x) => A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20]);
      for (let x = 0; x < 5; x++) {
        const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
        for (let y = 0; y < 5; y++) A[x + 5 * y] ^= D;
      }
      const B: bigint[] = new Array(25).fill(0n);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], ROT[x][y]);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x + 5 * y] = B[x + 5 * y] ^ (~B[((x + 1) % 5) + 5 * y] & M64 & B[((x + 2) % 5) + 5 * y]);
      A[0] ^= RC[round];
    }
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) for (let b = 0; b < 8; b++) out[i * 8 + b] = Number((A[i] >> BigInt(8 * b)) & 0xffn);
  return out;
}
if (keccak256(new Uint8Array()).toString("hex") !== "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470") {
  throw new Error("keccak-256 self-test failed");
}

async function getJson(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
      const text = await res.text();
      let body: any = text;
      try {
        body = JSON.parse(text);
      } catch {}
      if (res.status >= 500 && attempt < 2) continue;
      return { status: res.status, body };
    } catch (e) {
      if (attempt >= 2) return { status: 0, body: String(e) };
    }
  }
}

/** Intel TDX quote v4: 48-byte header, then the TD report; `report_data` is at 568..632. */
function tdxReportData(quote: Buffer) {
  const version = quote.readUInt16LE(0);
  const teeType = quote.readUInt32LE(4);
  return { version, teeType, ok: quote.length >= 632 && version === 4 && teeType === 0x81, reportData: quote.subarray(568, 632) };
}

type Check = { ok: boolean | null; detail: string };

/** (a) for dstack keys: report_data = address ‖ 0^12 ‖ nonce. */
function bindingCheck(quoteHex: string | undefined, address: string, nonce: string): Check & { report_data?: string; quote_sha256?: string } {
  if (!quoteHex) return { ok: false, detail: "no intel_quote in the report" };
  const quote = Buffer.from(quoteHex.replace(/^0x/, ""), "hex");
  const q = tdxReportData(quote);
  if (!q.ok) return { ok: false, detail: `not a TDX v4 quote (version ${q.version}, tee type 0x${q.teeType.toString(16)})` };
  const rd = q.reportData;
  const addr = Buffer.from(address.replace(/^0x/, ""), "hex");
  const okAddr = addr.length === 20 && rd.subarray(0, 20).equals(addr);
  const okPad = rd.subarray(20, 32).every((b) => b === 0);
  const okNonce = hex(rd.subarray(32, 64)) === nonce;
  return {
    ok: okAddr && okPad && okNonce,
    detail: okAddr && okPad && okNonce
      ? "TDX report_data = signing address ‖ 12 zero bytes ‖ our fresh nonce"
      : `report_data mismatch: address ${okAddr}, padding ${okPad}, nonce ${okNonce}`,
    report_data: hex(rd),
    quote_sha256: hex(sha256(quote)),
  };
}

let jwks: Map<string, ReturnType<typeof createPublicKey>> | null = null;
async function nrasKey(kid: string) {
  if (!jwks) {
    const r = await getJson(NRAS_JWKS);
    jwks = new Map();
    for (const k of r.body?.keys ?? []) {
      try {
        jwks.set(k.kid, createPublicKey({ key: { kty: k.kty, crv: k.crv, x: k.x, y: k.y }, format: "jwk" }));
      } catch {}
    }
  }
  return jwks.get(kid);
}

/** (b): NVIDIA NRAS on the GPU evidence, bound to `expectedNonce`. */
async function nrasCheck(payload: unknown, expectedNonce: string): Promise<Check & { gpus?: number; arch?: string; jwt_kid?: string }> {
  if (!payload) return { ok: false, detail: "no GPU evidence in the report" };
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, detail: "GPU evidence is not JSON" };
  }
  if (parsed.nonce !== expectedNonce) return { ok: false, detail: `GPU evidence carries nonce ${parsed.nonce}, expected ${expectedNonce}` };
  const r = await getJson(NRAS, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body });
  const token: string | undefined = Array.isArray(r.body) && Array.isArray(r.body[0]) ? r.body[0][1] : undefined;
  if (r.status !== 200 || !token) return { ok: false, detail: `NRAS answered ${r.status}` };
  const [h, p, s] = token.split(".");
  const header = JSON.parse(b64url(h).toString("utf8"));
  const claims = JSON.parse(b64url(p).toString("utf8"));
  const key = await nrasKey(header.kid);
  const sigOk = !!key && header.alg === "ES384" && verifySig("sha384", Buffer.from(`${h}.${p}`), { key, dsaEncoding: "ieee-p1363" }, b64url(s));
  const overall = claims["x-nvidia-overall-att-result"] === true;
  const nonceOk = claims.eat_nonce === expectedNonce;
  const gpus = Object.keys(claims.submods ?? {}).length;
  return {
    ok: sigOk && overall && nonceOk,
    detail: `NRAS JWT signature ${sigOk ? "valid (NVIDIA JWKS)" : "INVALID"}, x-nvidia-overall-att-result ${claims["x-nvidia-overall-att-result"]}, eat_nonce ${nonceOk ? "= our nonce" : "MISMATCH"}, ${gpus} GPUs`,
    gpus,
    arch: parsed.arch ?? parsed.evidence_list?.[0]?.arch,
    jwt_kid: header.kid,
  };
}

// ------------------------------------------------------------------ the ladder

async function view(account: string, method: string) {
  const r = await getJson(RPC[network], {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final", account_id: account, method_name: method, args_base64: "e30=" } }),
  });
  const bytes = r.body?.result?.result;
  if (!bytes) throw new Error(`${account}.${method}: ${JSON.stringify(r.body?.error ?? r.body).slice(0, 300)}`);
  return JSON.parse(Buffer.from(bytes).toString("utf8"));
}

let ladder = LADDER;
let onChain: { model_signers: string[]; gateway_signers: string[] } | null = null;
if (tokenId) {
  const c = await view(tokenId, "get_constitution");
  const g = await view(tokenId, "get_governance");
  ladder = c.ladder.map((t: any) => ({ model: t.model, min_endowment_near: Number(BigInt(t.min_endowment) / 10n ** 21n) / 1000 }));
  onChain = { model_signers: g.model_signers.map(lower), gateway_signers: g.gateway_signers.map(lower) };
}
const only = flag("models")?.split(",").map((m) => m.trim()).filter(Boolean);
if (only) ladder = only.map((model) => ladder.find((t) => t.model === model) ?? { model, min_endowment_near: NaN });

// ------------------------------------------------------------------ run

type KeyRecord = { address: string; kind: "model" | "gateway"; models: Set<string>; seen: number; passed: number; failures: string[] };
const keys = new Map<string, KeyRecord>();
const note = (address: string, kind: KeyRecord["kind"], model: string, ok: boolean, why: string) => {
  const a = lower(address);
  const k = keys.get(a) ?? { address: a, kind, models: new Set<string>(), seen: 0, passed: 0, failures: [] };
  if (k.kind !== kind) k.failures.push(`appears as both ${k.kind} and ${kind}`);
  k.models.add(model);
  k.seen++;
  if (ok) k.passed++;
  else k.failures.push(`${model}: ${why}`);
  keys.set(a, k);
};

const models: any[] = [];
let failed = false;
const log = (s: string) => console.error(s);

for (const tier of ladder) {
  const entry: any = { model: tier.model, min_endowment_near: tier.min_endowment_near, served: false, samples: [] };
  models.push(entry);
  log(`\n${tier.model}`);
  for (let i = 0; i < samples; i++) {
    const nonce = hex(randomBytes(32));
    const url = `${API}/v1/attestation/report?model=${encodeURIComponent(tier.model)}&signing_algo=ecdsa&nonce=${nonce}`;
    const r = await getJson(url);
    const sample: any = { nonce, http_status: r.status };
    entry.samples.push(sample);
    if (r.status !== 200 || typeof r.body !== "object") {
      sample.error = typeof r.body === "string" ? r.body.slice(0, 300) : JSON.stringify(r.body).slice(0, 300);
      log(`  sample ${i + 1}: HTTP ${r.status} ${sample.error}`);
      continue;
    }
    entry.served = true;

    // Gateway key: `gateway_attestation`.
    const gw = r.body.gateway_attestation;
    if (gw?.signing_address) {
      const a = bindingCheck(gw.intel_quote, gw.signing_address, nonce);
      const nonceEcho = gw.request_nonce === nonce;
      const ok = !!a.ok && nonceEcho;
      sample.gateway = {
        signing_address: lower(gw.signing_address),
        kind: "gateway",
        kind_evidence: "report.gateway_attestation",
        tdx_binding: a,
        gpu: { ok: null, detail: "not applicable: the gateway runs in CPU-only TDX and carries no GPU evidence" },
        app_name: gw.info?.app_name,
        compose_hash: gw.info?.compose_hash ?? gw.info?.tcb_info?.compose_hash,
        ok,
      };
      note(gw.signing_address, "gateway", tier.model, ok, a.detail);
      log(`  sample ${i + 1}: gateway ${lower(gw.signing_address)} TDX ${a.ok ? "PASS" : "FAIL"}`);
    } else {
      sample.gateway = { ok: false, detail: "no gateway_attestation.signing_address" };
    }

    // Model keys: `model_attestations[]`.
    sample.model_attestations = [];
    for (const m of r.body.model_attestations ?? []) {
      if (m.signing_address) {
        const kindOk = m.model_name === tier.model;
        const a = bindingCheck(m.intel_quote, m.signing_address, nonce);
        let pkOk = false;
        if (typeof m.signing_public_key === "string") {
          const pk = Buffer.from(m.signing_public_key.replace(/^0x/, "").replace(/^04(?=[0-9a-f]{128}$)/i, ""), "hex");
          pkOk = pk.length === 64 && "0x" + hex(keccak256(pk).subarray(12)) === lower(m.signing_address);
        }
        const b = await nrasCheck(m.nvidia_payload, nonce);
        const ok = kindOk && !!a.ok && pkOk && m.request_nonce === nonce && !!b.ok;
        sample.model_attestations.push({
          signing_address: lower(m.signing_address),
          kind: "model",
          kind_evidence: `report.model_attestations[].model_name = ${m.model_name}`,
          tdx_binding: { ...a, public_key_hashes_to_address: pkOk },
          gpu: b,
          instance_id: m.info?.instance_id,
          app_name: m.info?.app_name,
          compose_hash: m.info?.compose_hash ?? m.info?.tcb_info?.compose_hash,
          ok,
        });
        note(m.signing_address, "model", tier.model, ok, `${a.detail}; pubkey->address ${pkOk}; ${b.detail}; model_name ${m.model_name}`);
        log(`  sample ${i + 1}: model   ${lower(m.signing_address)} TDX ${a.ok && pkOk ? "PASS" : "FAIL"} GPU ${b.ok ? "PASS" : "FAIL"} (${b.detail})`);
      } else if (m.provider) {
        // A third-party provider without a per-response signing key.
        const quote = m.quote_b64 ? Buffer.from(m.quote_b64, "base64") : null;
        const q = quote ? tdxReportData(quote) : null;
        const fresh = sha256(Buffer.concat([Buffer.from(nonce), Buffer.from(m.e2e_pubkey ?? "")]));
        let spkiOk = false;
        try {
          const spki = new X509Certificate(Buffer.from(m.certificate_b64, "base64")).publicKey.export({ type: "spki", format: "der" });
          spkiOk = !!q && sha256(spki).equals(q.reportData.subarray(32, 64));
        } catch {}
        const freshOk = !!q?.ok && fresh.equals(q.reportData.subarray(0, 32)) && m.nonce === nonce;
        const gpuPayload = m.gpu_evidence?.length
          ? { arch: m.gpu_evidence[0].arch, evidence_list: m.gpu_evidence.map((g: any) => ({ certificate: g.certificate, evidence: g.evidence })), nonce: hex(fresh) }
          : null;
        const b = await nrasCheck(gpuPayload, hex(fresh));
        sample.model_attestations.push({
          provider: m.provider,
          signing_address: null,
          kind: "none",
          kind_evidence: `report.model_attestations[] from provider "${m.provider}" has no signing_address: its responses carry NEAR AI gateway signatures (signature_kind "gateway")`,
          provider_binding: {
            ok: freshOk && spkiOk,
            detail: `TDX report_data = sha256(nonce ‖ e2e_pubkey) ${freshOk ? "PASS" : "FAIL"}, ‖ sha256(SPKI(cert)) ${spkiOk ? "PASS" : "FAIL"}`,
          },
          gpu: b,
          provider_says: { verified: m.verified, tcb_status: m.tcb_status, gpu_verdict: m.gpu_verdict, measurement_config: m.measurement_config },
          instance_id: m.instance_id,
        });
        log(`  sample ${i + 1}: ${m.provider} instance ${m.instance_id}: no per-response key; binding ${freshOk && spkiOk ? "PASS" : "FAIL"}, GPU ${b.ok ? "PASS" : "FAIL"}`);
      } else {
        sample.model_attestations.push({ ok: false, detail: "model attestation without signing_address or provider", keys: Object.keys(m) });
      }
    }
    if (!sample.model_attestations.length) log(`  sample ${i + 1}: no model attestations`);
  }

  const signers = [...keys.values()].filter((k) => k.kind === "model" && k.models.has(tier.model)).map((k) => k.address);
  const thirdParty = entry.samples.flatMap((s: any) => s.model_attestations ?? []).filter((m: any) => m.provider);
  entry.model_signers = signers;
  entry.served_by = signers.length ? "near-ai (dstack TEE, per-response provider_tee signatures)" : thirdParty.length ? `${thirdParty[0].provider} (attested third party)` : null;
  entry.meetings_signed_by = signers.length ? "provider_tee (model_signers); gateway (gateway_signers) if NEAR AI falls back or rewrites the body" : thirdParty.length ? "gateway (gateway_signers) only" : null;
  if (!entry.served) {
    failed = true;
    log(`  NOT SERVED: no attestation report`);
  }
  if (thirdParty.some((m: any) => !m.provider_binding.ok || !m.gpu.ok)) failed = true;
}

const verified = (kind: KeyRecord["kind"]) =>
  [...keys.values()].filter((k) => k.kind === kind && k.seen > 0 && k.passed === k.seen && !k.failures.length).map((k) => k.address).sort();
const rejected = [...keys.values()].filter((k) => k.failures.length).map((k) => ({ address: k.address, kind: k.kind, failures: k.failures }));
if (rejected.length) failed = true;

const result: any = {
  generated_at: new Date().toISOString(),
  source: `${API}/v1/attestation/report`,
  samples_per_model: samples,
  ladder: ladder.map((t) => t.model),
  model_signers: verified("model"),
  gateway_signers: verified("gateway"),
  rejected,
  models,
  checks: {
    a: "TDX quote v4, report_data[0:20] = signing_address, [20:32] = 0, [32:64] = fresh nonce; model keys: keccak256(signing_public_key)[12:] = signing_address; request_nonce echoed",
    b: "NVIDIA NRAS v3 on the model's GPU evidence: JWT ES384 signature against NRAS JWKS, x-nvidia-overall-att-result = true, eat_nonce = our nonce (gateway: not applicable)",
    c: "model signer = model_attestations[] entry whose model_name is the requested model; gateway signer = gateway_attestation",
  },
  not_checked: [
    "Intel DCAP signature chain and TCB status of the TDX quotes (run dcap-qvl on quote bytes)",
    "the TDX measurements and compose hash against NEAR AI's published images",
    "completeness: a model may serve from more keys than these samples met",
  ],
};
if (tokenId && onChain) {
  const same = (x: string[], y: string[]) => x.length === y.length && x.every((v) => y.includes(v));
  result.token = {
    account: tokenId,
    network,
    on_chain: onChain,
    model_signers_match: same(onChain.model_signers, result.model_signers),
    gateway_signers_match: same(onChain.gateway_signers, result.gateway_signers),
  };
  if (!result.token.model_signers_match || !result.token.gateway_signers_match) failed = true;
}

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(result, null, 1) + "\n");
console.log(JSON.stringify({ model_signers: result.model_signers, gateway_signers: result.gateway_signers, rejected: rejected.length, token: result.token, written: outFile }, null, 1));
process.exit(failed ? 1 : 0);
