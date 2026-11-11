/**
 * One real meeting request through the courier and the contract, off chain.
 *
 *   NEARAI_API_KEY=sk-... pnpm courier:live [--signers results/signers-<date>.json] [--dir results/courier-live-<date>] [--allow-gateway]
 *
 * Through CHAIR's NEAR AI relay instead (the relay holds the key; the courier
 * gets none):
 *
 *   CHAIR_API_BASE=http://localhost:3000/api/nearai CHAIR_TOKEN=token5.chair-dev.testnet pnpm courier:live --dir results/courier-relay-<date>
 *
 * 1. The token's unit-test harness launches a token with the mainnet launch
 *    parameters and the verified signers, files three petitions (one an
 *    injection) and convenes meeting 1. It writes the exact request bytes.
 * 2. The courier's own logic (`courier/examples/live.rs`, natively, not on
 *    OutLayer) sends those bytes to NEAR AI Cloud: one chat completion, then
 *    the signature lookup. Its stdout is what the OutLayer module would return.
 * 3. The harness rebuilds the same state and feeds that output to `on_ruling`.
 *    It passes only if the contract holds the meeting as a ruling signed by an
 *    allowlisted key (`provider_tee` unless `--allow-gateway`).
 *
 * Costs one GLM-5.3-flash completion (about 2k tokens) on the key's credits.
 * Without NEARAI_API_KEY it stops after step 1, with the request ready.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const flag = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const root = resolve(import.meta.dirname, "..");
const today = new Date().toISOString().slice(0, 10);
const latestSigners = () => {
  const f = readdirSync(resolve(root, "results")).filter((n) => /^signers-\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort().at(-1);
  if (!f) throw new Error("no results/signers-*.json: run pnpm verify:signers first");
  return resolve(root, "results", f);
};
const signers = resolve(flag("signers") ?? latestSigners());
const dir = resolve(flag("dir") ?? `results/courier-live-${today}`);
const env = { ...process.env, CHAIR_LIVE_DIR: dir, CHAIR_LIVE_SIGNERS: signers, AWS_LC_SYS_PREBUILT_NASM: "1", ...(argv.includes("--allow-gateway") ? { CHAIR_LIVE_ALLOW_GATEWAY: "1" } : {}) };
/** `CHAIR_API_BASE` other than NEAR AI Cloud: the courier is built for a relay, which holds the key. */
const relayBase = (process.env.CHAIR_API_BASE ?? "").trim().replace(/\/+$/, "");
const viaRelay = relayBase !== "" && relayBase !== "https://cloud-api.near.ai";

function contractStep(label: string) {
  console.error(`\n== ${label}`);
  const r = spawnSync("cargo", ["test", "--quiet", "live_courier", "--", "--ignored", "--nocapture"], { cwd: resolve(root, "contracts/token"), env, encoding: "utf8" });
  const lines = (r.stdout + r.stderr).split("\n").filter((l) => l.startsWith("live_courier:") || /panicked|test result|assertion/.test(l));
  console.error(lines.join("\n"));
  if (r.status !== 0) {
    console.error(`FAIL (${label})`);
    process.exit(1);
  }
}

console.error(`signers: ${signers}\ndir:     ${dir}`);
console.error(`via:     ${viaRelay ? `relay ${relayBase} (token ${process.env.CHAIR_TOKEN || "token.thechair.near"}), no key in the courier` : "NEAR AI Cloud, direct"}`);
rmSync(resolve(dir, "courier-output.json"), { force: true });
rmSync(resolve(dir, "contract-verdict.json"), { force: true });
contractStep("1. launch, petitions, convene: the exact request bytes");

if (!viaRelay && !process.env.NEARAI_API_KEY) {
  console.error(`\nNEARAI_API_KEY is not set. The request is ready at ${dir}/request.json; set the key and run again.`);
  process.exit(2);
}

console.error(`\n== 2. the courier's logic against ${viaRelay ? "the relay" : "NEAR AI Cloud"}`);
const courierEnv: NodeJS.ProcessEnv = { ...env };
if (viaRelay) delete courierEnv.NEARAI_API_KEY;
const c = spawnSync("cargo", ["run", "--quiet", "--example", "live", "--", resolve(dir, "request.json")], { cwd: resolve(root, "courier"), env: courierEnv, encoding: "utf8" });
console.error(c.stderr.trim());
writeFileSync(resolve(dir, "courier-output.json"), c.stdout);
let out: any;
try {
  out = JSON.parse(c.stdout);
} catch {
  console.error(`courier printed no JSON: ${c.stdout.slice(0, 300)}`);
  process.exit(1);
}
if (out.error) {
  console.error(`courier error ${out.error.code}: ${out.error.message}`);
  rmSync(resolve(dir, "courier-output.json"), { force: true });
  process.exit(1);
}
console.error(`signature_kind ${out.signature_kind}, signing_address ${out.signing_address}, hashes_match ${out.hashes_match}`);
console.error(`signature_text ${out.signature_text}`);

contractStep("3. on_ruling with the real courier output");
if (existsSync(resolve(dir, "contract-verdict.json"))) {
  const v = JSON.parse(readFileSync(resolve(dir, "contract-verdict.json"), "utf8"));
  console.log(JSON.stringify({ courier: { signature_kind: out.signature_kind, signing_address: out.signing_address, hashes_match: out.hashes_match, model: out.model }, contract: v }, null, 1));
}
