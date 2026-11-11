import { CONTRACT, EXPLORER, TEST_CHAIR_CONTRACT } from "@/lib/content/constitution";
import { BLINDBOOK, REPO } from "@/lib/format";
import { Brand } from "./Brand";

export function Footer() {
  return (
    <footer className="foot">
      <div className="wrap foot-in">
        <div className="foot-brand">
          <Brand size={18} />
          <p>A memecoin that runs its own central bank. Testnet today.</p>
        </div>
        <nav className="foot-links" aria-label="Footer">
          <a href={REPO} target="_blank" rel="noopener">
            github.com/RaYYeR220/chair
          </a>
          <a href={`${REPO}/blob/main/JUDGES.md`} target="_blank" rel="noopener">
            JUDGES.md
          </a>
          <a href={`${REPO}/blob/main/CLAIMS.md`} target="_blank" rel="noopener">
            CLAIMS.md
          </a>
          <a href={`${EXPLORER}/address/${CONTRACT}`} target="_blank" rel="noopener">
            {CONTRACT.split(".")[0]} on nearblocks
          </a>
        </nav>
        <div className="foot-fine">
          <p>Built on NEAR AI Cloud (TEE), OutLayer, Chain Signatures (MPC) and stake.dao.</p>
          <p>
            Also by us at NEAR HACKATHON:{" "}
            <a href={BLINDBOOK} target="_blank" rel="noopener">
              Blindbook
            </a>
            , a dark pool for NEAR Intents (github.com/RaYYeR220/blindbook).
          </p>
          <p>
            Testnet values are read live from {CONTRACT}, and the fooled test chair from {TEST_CHAIR_CONTRACT}; simulation values are unsigned; anything
            else drawn is labelled illustrative.
          </p>
        </div>
      </div>
    </footer>
  );
}
