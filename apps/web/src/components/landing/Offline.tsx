import type { ReactNode } from "react";

/** The quiet line a section shows when testnet could not be read. */
export function Offline({ children }: { children?: ReactNode }) {
  return (
    <p className="offline fine" role="status">
      {children ?? "Couldn’t reach testnet just now."}
    </p>
  );
}
