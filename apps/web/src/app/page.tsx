import Link from "next/link";

export default function Home() {
  return (
    <main>
      <h1>CHAIR</h1>
      <p>A memecoin that runs its own central bank. The AI can be fooled. The contract can&apos;t.</p>
      <p>
        <Link href="/dev">API console</Link>
      </p>
    </main>
  );
}
