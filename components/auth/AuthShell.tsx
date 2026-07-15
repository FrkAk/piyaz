import type { ReactNode } from "react";
import { AuthFooter } from "@/components/auth/AuthFooter";
import { AuthThemeToggle } from "@/components/auth/AuthThemeToggle";

interface AuthShellProps {
  /** Left column content — branding, headline, and the form stack. */
  form: ReactNode;
  /** Right column content — decorative animated graph hero. Hidden below `lg`. */
  hero: ReactNode;
}

/**
 * Two-column auth shell — form on the left, decorative hero on the right.
 *
 * Below `lg` (1024px) the hero collapses and the form fills the viewport
 * with comfortable side padding so the experience stays usable on
 * tablets and phones. At `lg+` the columns split 50/50 with a 1px hairline
 * divider between them. A floating theme toggle pins to the top-right
 * corner of the page.
 *
 * @param props - Form and hero slots.
 * @returns Full-bleed two-column layout.
 */
export function AuthShell({ form, hero }: AuthShellProps) {
  return (
    <div className="relative grid min-h-[100dvh] grid-cols-1 lg:grid-cols-2">
      <AuthThemeToggle />
      <section className="relative flex items-center justify-center px-6 py-10 sm:px-10 lg:px-12">
        <div className="w-full max-w-[360px]">{form}</div>
        <AuthFooter />
      </section>
      <aside
        aria-hidden="true"
        className="relative hidden overflow-hidden border-l border-[var(--color-border)] lg:flex"
        style={{ background: "var(--color-base-2)" }}
      >
        {hero}
      </aside>
    </div>
  );
}
