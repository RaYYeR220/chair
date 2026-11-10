import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { ChairApp } from "@/components/app/ChairApp";
import { Footer } from "@/components/site/Footer";
import { Nav } from "@/components/site/Nav";
import { Reveal } from "@/components/site/Reveal";
import { loadMeeting, loadMeetings, loadPetitions, loadState, writeModes } from "@/lib/server/live";
import "@/styles/app.css";

export const metadata: Metadata = {
  title: "App",
  description:
    "CHAIR on testnet, live: the four levers on their constitution rails, the petition queue and the brief, convene a meeting, every meeting's record, and a playground that runs forged, jailbroken and garbage rulings through the contract.",
};

const LINKS = [
  { href: "#state", label: "Live state" },
  { href: "#petition", label: "Petition" },
  { href: "#convene", label: "Convene" },
  { href: "#meetings", label: "Meetings" },
  { href: "#playground", label: "Try to fool it" },
];

/** The first render, read on the server: every value is live or null. */
async function LiveApp() {
  await connection();
  const [state, petitions, meetings] = await Promise.all([loadState(), loadPetitions(), loadMeetings()]);
  const newest = meetings?.[0]?.number ?? null;
  const latest = newest ? await loadMeeting(newest) : null;
  return <ChairApp initial={{ state, petitions, meetings, latest, writes: writeModes() }} />;
}

/** The shell before the live read lands; the server decides what a write does, so the buttons stay usable. */
const EMPTY = { writes: { relay: true, convene: true, dry_run: false } };

export default function AppPage() {
  return (
    <>
      <a className="skip" href="#app-main">
        Skip to the app
      </a>
      <Nav links={LINKS} cta={{ href: "/", label: "Home" }} solid />
      <main id="app-main" className="app">
        <Suspense fallback={<ChairApp initial={EMPTY} />}>
          <LiveApp />
        </Suspense>
      </main>
      <Footer />
      <Reveal />
    </>
  );
}
