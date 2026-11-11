"use client";

import Link from "next/link";
import { createEnd } from "@/components/canvas/end";
import { useScene } from "@/components/canvas/useScene";

/** 9. The close: the fan, small, and the line the whole page argues. */
export function Close() {
  const ref = useScene<HTMLCanvasElement>((cv) => createEnd(cv), []);
  return (
    <section className="end" aria-labelledby="end-h">
      <div className="wrap end-in">
        <canvas className="end-cv rv" ref={ref} aria-hidden="true" />
        <h2 id="end-h" className="rv">
          The AI can be fooled. The contract&nbsp;can’t.
        </h2>
        <div className="ctas rv">
          <Link className="btn" href="/app#petition">
            Petition the Chair
          </Link>
          <a className="tlink" href="#real-chair">
            Read the minutes
          </a>
        </div>
      </div>
    </section>
  );
}
