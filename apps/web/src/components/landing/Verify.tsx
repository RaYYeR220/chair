import { REPO } from "@/lib/format";
import { CopyButton } from "./CopyButton";

const SCRIPT = `# one helper: a read-only view on token3.chair-dev.testnet
RPC=https://test.rpc.fastnear.com
view() {  # view <method> <json args>
  curl -s "$RPC" -H 'content-type: application/json' -d "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":1,\\"method\\":\\"query\\",\\"params\\":{\\"request_type\\":\\"call_function\\",\\"finality\\":\\"final\\",\\"account_id\\":\\"token3.chair-dev.testnet\\",\\"method_name\\":\\"$1\\",\\"args_base64\\":\\"$(printf '%s' "$2" | base64 | tr -d '\\n')\\"}}" \\
  | node -p "JSON.stringify(JSON.parse(Buffer.from(JSON.parse(require('fs').readFileSync(0)).result.result)),null,1)"
}

# 1. the fooled ruling and its clamps
view get_meeting '{"meeting":1}'

# 2. valid: false, reason: bad_signature
view preview_ruling "$(cat samples/forged-random-key.json)"

# 3. valid: true, locker_share 100 -> 25
view preview_ruling "$(cat samples/jailbreak-signed-by-test-key.json)"`;

/** One line of the script, coloured: comments, the view calls, their arguments. */
function Line({ text }: { text: string }) {
  const hash = text.indexOf("# ");
  if (text.startsWith("#")) return <span className="c">{text}</span>;
  if (text.startsWith("view ")) {
    const sp = text.indexOf(" ", 5);
    return (
      <>
        <b>{text.slice(0, sp)}</b> <span className="s">{text.slice(sp + 1)}</span>
      </>
    );
  }
  if (hash > 0 && text.startsWith("view()")) {
    return (
      <>
        {text.slice(0, hash)}
        <span className="c">{text.slice(hash)}</span>
      </>
    );
  }
  return <>{text}</>;
}

/** 7. Verify it yourself: three read-only commands. */
export function Verify() {
  const lines = SCRIPT.split("\n");
  return (
    <section className="sec" id="verify" aria-labelledby="ver-h">
      <div className="wrap ver">
        <div className="ver-copy rv">
          <p className="eyebrow">Verify it yourself</p>
          <h2 id="ver-h">Three commands. No&nbsp;keys.</h2>
          <p className="lead">
            Every call is a free view on the testnet contract through FastNEAR’s public RPC. Run them from the repo root with bash, curl and Node&nbsp;24.
          </p>
          <ol className="expect">
            <li>
              <b>Meeting 1.</b>{" "}
              <span>
                <code>status held</code>, signer <code>0xc053…a87f</code> (the testnet test key), asked <code>locker_share 100</code> and{" "}
                <code>buyback_burn 10000</code>, clamps 100 → 25 and 10000 → 50, both <code>bounds</code>.
              </span>
            </li>
            <li>
              <b>A forged ruling.</b>{" "}
              <span>
                <code>valid false</code>, <code>reason bad_signature</code>, and the fallback: tax 290, shares unchanged, no buyback.
              </span>
            </li>
            <li>
              <b>A jailbroken ruling.</b>{" "}
              <span>
                <code>valid true</code>, locker share 100 → 25 (<code>bounds</code>). The burn is cut too, by the bound or by what the fund holds.
              </span>
            </li>
          </ol>
          <p className="ver-more">
            The full five-minute path, with the offline simulation replay and the tests, is in{" "}
            <a href={`${REPO}/blob/main/JUDGES.md`} target="_blank" rel="noopener">
              JUDGES.md&nbsp;↗
            </a>
            . Every public claim and its tier is in{" "}
            <a href={`${REPO}/blob/main/CLAIMS.md`} target="_blank" rel="noopener">
              CLAIMS.md&nbsp;↗
            </a>
            .
          </p>
        </div>
        <div className="code rv">
          <div className="code-top">
            <span className="code-file">bash · from the repo root</span>
            <CopyButton text={SCRIPT} />
          </div>
          <pre>
            <code>
              {lines.map((l, i) => (
                <span key={i}>
                  <Line text={l} />
                  {i < lines.length - 1 ? "\n" : null}
                </span>
              ))}
            </code>
          </pre>
        </div>
      </div>
    </section>
  );
}
