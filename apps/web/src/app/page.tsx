import { connection } from "next/server";
import { Suspense } from "react";
import { Close } from "@/components/landing/Close";
import { Constitution } from "@/components/landing/Constitution";
import { FoolIt } from "@/components/landing/FoolIt";
import { Hero } from "@/components/landing/Hero";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { IqLadder } from "@/components/landing/IqLadder";
import { Limits } from "@/components/landing/Limits";
import { MeetingOne } from "@/components/landing/MeetingOne";
import { Simulation } from "@/components/landing/Simulation";
import { Verify } from "@/components/landing/Verify";
import { Footer } from "@/components/site/Footer";
import { Nav } from "@/components/site/Nav";
import { Reveal } from "@/components/site/Reveal";
import { loadMeeting, loadMeetings, loadState } from "@/lib/server/live";
import { toReplay } from "@/lib/views";
import "@/styles/landing.css";

const LINKS = [
  { href: "#how", label: "How it works" },
  { href: "#constitution", label: "Constitution" },
  { href: "#meeting-1", label: "Meeting 1" },
  { href: "#fool", label: "Try to fool it" },
  { href: "#simulation", label: "Simulation" },
];

// Live sections: each reads testnet at request time and streams in behind a
// fallback that is the same section, still loading. A failed read renders the
// section with a quiet note instead of numbers.

async function HowItWorksLive() {
  await connection();
  return <HowItWorks m1={await loadMeeting(1)} />;
}

async function ConstitutionLive() {
  await connection();
  const [state, list] = await Promise.all([loadState(), loadMeetings()]);
  return <Constitution state={state} meetings={list ? toReplay(list) : null} />;
}

async function MeetingOneLive() {
  await connection();
  const [m1, state] = await Promise.all([loadMeeting(1), loadState()]);
  return <MeetingOne m1={m1} tokenKeys={state ? state.token_keys : null} />;
}

async function IqLadderLive() {
  await connection();
  return <IqLadder state={await loadState()} />;
}

export default function Home() {
  return (
    <>
      <a className="skip" href="#top">
        Skip to content
      </a>
      <Nav links={LINKS} cta={{ href: "/app", label: "Open app" }} />
      <main id="top">
        <Hero />
        <Suspense fallback={<HowItWorks m1={undefined} />}>
          <HowItWorksLive />
        </Suspense>
        <Suspense fallback={<Constitution state={undefined} meetings={undefined} />}>
          <ConstitutionLive />
        </Suspense>
        <Suspense fallback={<MeetingOne m1={undefined} tokenKeys={undefined} />}>
          <MeetingOneLive />
        </Suspense>
        <FoolIt />
        <Simulation />
        <Suspense fallback={<IqLadder state={undefined} />}>
          <IqLadderLive />
        </Suspense>
        <Verify />
        <Limits />
        <Close />
      </main>
      <Footer />
      <Reveal />
    </>
  );
}
