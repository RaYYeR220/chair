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
            <h3>Testnet today.</h3>
            <p>
              Everything on chain runs as <span className="m">token3.chair-dev.testnet</span>. The mainnet token, <span className="m">token.thechair.near</span>,
              is not deployed.
            </p>
          </li>
          <li>
            <h3>A test signer, not NEAR AI.</h3>
            <p>
              Every ruling so far was signed by a test key that obeys injections on purpose. The real courier passes 16 tests against a mock and has not yet
              run against NEAR AI.
            </p>
          </li>
          <li>
            <h3>One owner key, slowed by 48&nbsp;h.</h3>
            <p>The owner can propose new signer allowlists or a courier version. The proposal waits 48&nbsp;h in public and nobody can veto it. Nothing else can change.</p>
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
