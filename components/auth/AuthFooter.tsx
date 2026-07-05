import Link from "next/link";

/** Public legal routes surfaced across the auth screens. */
export const LEGAL_LINKS = [
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "/impressum", label: "Impressum" },
] as const;

/**
 * Small legal footer for the auth screens. Renders links to the public
 * privacy, terms, and Impressum pages in muted auth typography.
 *
 * @returns Unobtrusive footer pinned to the bottom of the auth form column.
 */
export function AuthFooter() {
  return (
    <footer className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-3 px-6 py-4 text-[12px] text-text-muted">
      {LEGAL_LINKS.map((link) => (
        <Link key={link.href} href={link.href} className="hover:underline">
          {link.label}
        </Link>
      ))}
    </footer>
  );
}
