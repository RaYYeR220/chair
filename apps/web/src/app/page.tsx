import { connection } from "next/server";
import { Suspense } from "react";
import { Close } from "@/components/landing/Close";
import { Constitution } from "@/components/landing/Constitution";
import { FoolIt } from "@/components/landing/FoolIt";
import { FooledChair } from "@/components/landing/FooledChair";
import { Hero } from "@/components/landing/Hero";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { IqLadder } from "@/components/landing/IqLadder";
import { Limits } from "@/components/landing/Limits";
import { Mainnet } from "@/components/landing/Mainnet";
import { RealChair } from "@/components/landing/RealChair";
import { Simulation } from "@/components/landing/Simulation";
import { Verify } from "@/components/landing/Verify";
import { Footer } from "@/components/site/Footer";
import { Nav } from "@/components/site/Nav";
import { Reveal } from "@/components/site/Reveal";
import { MAINNET_MEETING, REAL_CHAIR_CONTRACT, REAL_MEETINGS, TEST_CHAIR_CONTRACT } from "@/lib/content/constitution";
import { loadMainnet, loadMeeting, loadMeetings, loadState } from "@/lib/server/live";
import { toReplay } from "@/lib/views";
import "@/styles/landing.css";

const LINKS = [
  { href: "#mainnet", label: "Mainnet" },
  { href: "#how", label: "How it works" },
  { href: "#constitution", label: "Constitution" },
  { href: "#real-chair", label: "Real meetings" },
  { href: "#fool", label: "Try to fool it" },
  { href: "#simulation", label: "Simulation" },
];

// Live sections: each reads the chain at request time and streams in behind a
// fallback that is the same section, still loading. A failed read renders the
// section with a quiet note instead of numbers. The mainnet strip reads the
// mainnet token; everything else reads testnet.

/** The mainnet token's first meeting, read-only. */
async function MainnetLive() {
  await connection();
  return <Mainnet data={await loadMainnet(MAINNET_MEETING)} />;
}

async function HowItWorksLive() {
  await connection();
  return <HowItWorks m1={await loadMeeting(1)} />;
}

async function ConstitutionLive() {
  await connection();
  const [state, list] = await Promise.all([loadState(), loadMeetings()]);
  return <Constitution state={state} meetings={list ? toReplay(list) : null} />;
}

/** token5's meetings, ruled by NEAR AI's model. A meeting that can't be read is left out; none at all is `null`. */
async function RealChairLive() {
  await connection();
  const [ms, state] = await Promise.all([Promise.all(REAL_MEETINGS.map((n) => loadMeeting(n, REAL_CHAIR_CONTRACT))), loadState()]);
  const got = ms.filter((m) => m !== null);
  const keys = state && state.contract === REAL_CHAIR_CONTRACT ? state.token_keys : undefined;
  return <RealChair meetings={got.length ? got : null} contract={REAL_CHAIR_CONTRACT} tokenKeys={keys} />;
}

/** token3's meeting 1: the test chair that obeys injections, and the clamp. */
async function FooledChairLive() {
  await connection();
  return <FooledChair m1={await loadMeeting(1, TEST_CHAIR_CONTRACT)} />;
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
        <Suspense fallback={<Mainnet data={undefined} />}>
          <MainnetLive />
        </Suspense>
        <Suspense fallback={<HowItWorks m1={undefined} />}>
          <HowItWorksLive />
        </Suspense>
        <Suspense fallback={<Constitution state={undefined} meetings={undefined} />}>
          <ConstitutionLive />
        </Suspense>
        <Suspense fallback={<RealChair meetings={undefined} contract={REAL_CHAIR_CONTRACT} />}>
          <RealChairLive />
        </Suspense>
        <Suspense fallback={<FooledChair m1={undefined} />}>
          <FooledChairLive />
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
