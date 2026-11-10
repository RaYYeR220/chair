import Link from "next/link";

/** The mark: a hairline ring with a violet quarter (the 25% cap) and the Chair at its centre. */
export function Mark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="8.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M10 1.8 A8.2 8.2 0 0 1 18.2 10" fill="none" stroke="#5e45d8" strokeWidth="2.4" />
      <circle cx="10" cy="10" r="2.2" fill="#5e45d8" />
    </svg>
  );
}

export function Brand({ href = "/", size = 20 }: { href?: string; size?: number }) {
  return (
    <Link className="brand" href={href} aria-label="CHAIR, home">
      <Mark size={size} />
      CHAIR
    </Link>
  );
}
