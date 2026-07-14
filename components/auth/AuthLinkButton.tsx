import Link from "next/link";
import type { ReactNode } from "react";

interface AuthLinkButtonProps {
  /** Navigation target. */
  href: string;
  /** Button label content. */
  children: ReactNode;
}

/**
 * Gradient link-button matching `AuthSubmit`'s 38px CTA, for navigation
 * targets on auth status pages (verify-email Continue, reset-password
 * follow-ups). Server-component safe: plain `Link`, no client state.
 *
 * @param props - Target href and label.
 * @returns Full-width gradient link styled as the primary auth CTA.
 */
export function AuthLinkButton({ href, children }: AuthLinkButtonProps) {
  return (
    <Link
      href={href}
      className="inline-flex w-full items-center justify-center text-[13px] font-semibold transition-opacity outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
      style={{
        height: 38,
        borderRadius: 8,
        background: "var(--color-accent-grad)",
        color: "#0b0c10",
        border: "1px solid transparent",
        letterSpacing: "0.005em",
      }}
    >
      {children}
    </Link>
  );
}
