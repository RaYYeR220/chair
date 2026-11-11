import { REAL_CHAIR_CONTRACT, TEST_CHAIR_CONTRACT } from "@/lib/content/constitution";

/** 8. Honest limits: what the page's labels leave out. */
export function Limits() {
  return (
    <section className="sec" id="limits" aria-labelledby="lim-h">
      <div className="wrap">
        <header className="sec-head rv">
          <p className="eyebrow">Honest limits</p>
          <h2 id="lim-h">What isn’t real&nbsp;yet.</h2>
          <p className="lead">This page labels everything as testnet, simulation or illustrative. Here is what those labels leave out.</p>
        </header>
        <ul className="lim rv">
          <li>
            <h3>Testnet today. Mainnet is next.</h3>
            <p>
              Everything on chain runs on NEAR testnet: <span className="m">{REAL_CHAIR_CONTRACT}</span> with NEAR AI, and{" "}
              <span className="m">{TEST_CHAIR_CONTRACT}</span> with a test chair. The mainnet token, <span className="m">token.thechair.near</span>, is not
              deployed yet.
            </p>
          </li>
          <li>
            <h3>NEAR AI-signed, through a relay.</h3>
            <p>
              token5’s rulings come from GLM 5.3 Flash on NEAR AI Cloud, signed by its TEE key and checked by the contract. OutLayer’s workers can’t reach NEAR
              AI Cloud directly, so the courier goes through CHAIR’s relay, which holds the API key and forwards only the open meeting’s exact request. It
              can’t change a ruling without breaking the signature, but it could refuse to forward one, and then the fallback rule runs.
            </p>
          </li>
          <li>
            <h3>The test key stays on testnet.</h3>
            <p>
              token5’s allowlist also holds a test key, so the playground can sign rulings a real model never would. token3’s rulings, the fooled one included,
              came from that key. Mainnet’s allowlist will hold only NEAR AI’s verified keys.
            </p>
          </li>
          <li>
            <h3>The keys are attested, the quote chain isn’t.</h3>
            <p>
              Each NEAR AI model key is bound to a fresh nonce in its TDX quote, and NVIDIA’s GPU attestation passes. The Intel signature chain of the quotes is
              not checked. Kimi K3 has no per-response model key, so a Kimi meeting would be gateway-signed.
            </p>
          </li>
          <li>
            <h3>One owner key, slowed by 48&nbsp;h.</h3>
            <p>The owner can propose new signer allowlists or a courier version. The proposal waits 48&nbsp;h in public and nobody can veto it. Nothing else can change.</p>
          </li>
          <li>
            <h3>Someone could shop for a ruling.</h3>
            <p>
              The pinned courier asks the model once per meeting. Whoever runs the courier or the relay could ask several times and keep the ruling they like.
              The clamp holds any such pick to one step per lever.
            </p>
          </li>
          <li>
            <h3>The simulation ran on Venice.</h3>
            <p>
              Venice-hosted open models of the same families as the IQ ladder, one seed for the model chair, and invented holders who never read the minutes.
              Kimi K3 was never reached.
            </p>
          </li>
          <li>
            <h3>Steering is token-weighted.</h3>
            <p>By design, the heaviest locks are heard first. The cap limits what a whale gets. It doesn’t stop it from being heard.</p>
          </li>
          <li>
            <h3>The testnet farm is a stand-in.</h3>
            <p>
              The testnet brain stakes into a mock with the same interface as <span className="m">stake.dao</span>. No real inference credits have been earned.
            </p>
          </li>
        </ul>
      </div>
    </section>
  );
}
