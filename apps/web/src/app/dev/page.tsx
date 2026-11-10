import type { Metadata } from "next";
import { Console } from "./console";

export const metadata: Metadata = { title: "CHAIR API console" };

/** Unstyled page that exercises every API route against the live contract. */
export default function DevPage() {
  return (
    <main>
      <h1>CHAIR API console</h1>
      <p>Each button calls one route and prints its JSON. Relay and convene send real testnet transactions.</p>
      <Console />
    </main>
  );
}
