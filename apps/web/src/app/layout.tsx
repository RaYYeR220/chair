import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Instrument_Sans, JetBrains_Mono } from "next/font/google";
import type { ReactNode } from "react";
import "@/styles/globals.css";

const display = Bricolage_Grotesque({ subsets: ["latin"], axes: ["opsz"], variable: "--font-display", display: "swap" });
const sans = Instrument_Sans({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

const site =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000");

const title = "CHAIR · Petition the Chair";
const description =
  "A memecoin that runs its own central bank. Lockers petition the Chair, a model rules on four levers, and the contract checks the signature and clamps the ruling to a constitution fixed at launch.";

export const metadata: Metadata = {
  metadataBase: new URL(site),
  title: { default: title, template: "%s · CHAIR" },
  description,
  applicationName: "CHAIR",
  openGraph: { type: "website", siteName: "CHAIR", title, description },
  twitter: { card: "summary_large_image", title, description },
};

export const viewport: Viewport = {
  themeColor: "#fbfaf7",
  colorScheme: "light",
};

/*
  Runs before first paint: `js` arms the scroll reveal, and `ready` is the
  failsafe that shows the hero's entrance even if its animation never runs.
*/
const BOOT = `(function(){var d=document.documentElement;d.classList.add("js");setTimeout(function(){d.classList.add("ready")},1600)})()`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: BOOT }} />
        <noscript>
          <style>{".reveal,.rv{animation:none!important;opacity:1!important;transform:none!important}"}</style>
        </noscript>
      </head>
      <body>{children}</body>
    </html>
  );
}
