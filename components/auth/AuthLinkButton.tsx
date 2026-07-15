import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";

interface AuthLinkButtonProps {
  /** Navigation target. */
  href: string;
  /** Visual weight: gradient primary CTA or raised secondary. */
  variant?: "primary" | "secondary";
  /**
   * Render a plain anchor (full document load) instead of a soft `Link`.
   * Use for the post-auth hop into the app: a soft client nav to the app
   * root races the RSC fetch and can paint it blank, so that entry
   * hard-navigates.
   */
  hardNav?: boolean;
  /** Button label content. */
  children: ReactNode;
}

/**
 * Link-button matching `AuthSubmit`'s 38px CTA, for navigation targets
 * on auth status pages (verify-email Continue, reset-password follow-ups,
 * invitation sign-in/sign-up). `primary` is the accent-gradient CTA;
 * `secondary` is the raised-surface counterpart mirroring
 * `Button variant="secondary"`. Server-component safe: plain `Link`, no
 * client state.
 *
 * @param props - Target href, optional variant, and label.
 * @returns Full-width link styled as an auth CTA.
 */
export function AuthLinkButton({
  href,
  variant = "primary",
  hardNav = false,
  children,
}: AuthLinkButtonProps) {
  const className =
    variant === "secondary"
      ? "inline-flex w-full items-center justify-center text-[13px] font-medium text-text-primary transition-colors outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
      : "inline-flex w-full items-center justify-center text-[13px] font-semibold transition-opacity outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]";
  const style: CSSProperties =
    variant === "secondary"
      ? {
          height: 38,
          borderRadius: 8,
          background: "var(--color-surface-raised)",
          border: "1px solid var(--color-border-strong)",
          boxShadow: "var(--shadow-button)",
        }
      : {
          height: 38,
          borderRadius: 8,
          background: "var(--color-accent-grad)",
          color: "#0b0c10",
          border: "1px solid transparent",
          letterSpacing: "0.005em",
        };
  if (hardNav) {
    return (
      <a href={href} className={className} style={style}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={className} style={style}>
      {children}
    </Link>
  );
}
