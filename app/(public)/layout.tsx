import Link from "next/link";
import type { ReactNode } from "react";
import { MARKETING_URL } from "@/lib/config/urls";

/** Legal documents linked from the shell footer, in reading order. */
const LEGAL_NAV = [
  { href: "/terms", label: "Terms" },
  { href: "/privacy", label: "Privacy" },
  { href: "/impressum", label: "Legal Notice" },
  { href: "/dpa", label: "DPA" },
  { href: "/subprocessors", label: "Sub-processors" },
];

/**
 * Shell for the unauthenticated legal pages: a header whose brand links out
 * to the marketing site and whose action opens the app at `/`, a centered
 * readable column with the document-scale `legal-doc` prose treatment, and a
 * footer cross-linking every legal document so a visitor can move between
 * them without the app chrome.
 *
 * @param props - Route children.
 * @returns Header, content column, and legal footer.
 */
export default function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <div className="legal-doc flex min-h-dvh flex-col">
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 -z-10"
        style={{
          background:
            "radial-gradient(80% 60% at 85% 5%, rgba(151, 107, 104, 0.12), transparent 70%), radial-gradient(50% 40% at 15% 95%, rgba(118, 137, 137, 0.09), transparent 70%)",
        }}
      />
      <header className="border-b border-border">
        <div className="mx-auto flex w-full max-w-[720px] items-center justify-between px-6 py-4">
          <a href={MARKETING_URL} className="flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element -- brand mark is a 22px static asset; next/image optimization is overkill and unconfigured on the Cloudflare build */}
            <img
              src="/piyaz-mark.png"
              alt=""
              aria-hidden="true"
              width={22}
              height={22}
              className="h-[22px] w-[22px] object-contain"
            />
            <span
              className="text-[14px] font-semibold text-text-primary"
              style={{ letterSpacing: "-0.005em" }}
            >
              piyaz
            </span>
          </a>
          <Link
            href="/"
            className="text-[12.5px] text-text-muted transition-colors hover:text-text-primary"
          >
            Open app
          </Link>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[720px] flex-1 px-6 py-12">
        <p className="mb-6 font-mono text-[10px] font-semibold uppercase tracking-wider text-text-muted">
          Legal
        </p>
        {children}
      </main>
      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-[720px] flex-wrap items-center justify-between gap-x-6 gap-y-2 px-6 py-5 text-[12px] text-text-muted">
          <nav className="flex flex-wrap gap-x-4 gap-y-1">
            {LEGAL_NAV.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="transition-colors hover:text-text-primary"
              >
                {link.label}
              </Link>
            ))}
          </nav>
          <a
            href="mailto:legal@piyaz.ai"
            className="transition-colors hover:text-text-primary"
          >
            legal@piyaz.ai
          </a>
        </div>
      </footer>
    </div>
  );
}
