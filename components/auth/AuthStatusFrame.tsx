import type { ReactNode } from "react";
import { AuthBrand } from "@/components/auth/AuthBrand";
import { AuthThemeToggle } from "@/components/auth/AuthThemeToggle";

interface AuthStatusFrameProps {
  /** Mono uppercase context label above the heading; omitted when unset. */
  eyebrow?: string;
  /** Status heading. Short statements, no trailing period. */
  heading: string;
  /** Panel content below the heading. */
  children: ReactNode;
}

/**
 * Centered frame for standalone auth status pages (verify-email,
 * account-deleted, invitation landing): brand mark, optional mono
 * eyebrow, and a heading at the auth-shell scale over the page content.
 * A floating theme toggle pins to the top-right corner, matching
 * `AuthShell`. Server-component safe: the toggle is the only client
 * island.
 *
 * @param props - Eyebrow, heading, and panel content.
 * @returns Full-height centered status layout.
 */
export function AuthStatusFrame({
  eyebrow,
  heading,
  children,
}: AuthStatusFrameProps) {
  return (
    <div className="relative flex min-h-dvh items-center justify-center px-4">
      <AuthThemeToggle />
      <div className="w-full max-w-md">
        <AuthBrand className="mb-7 justify-center" />
        <div className="space-y-4">
          <div className="text-center">
            {eyebrow ? (
              <span
                className="mb-2 block font-mono text-[10px] font-semibold uppercase"
                style={{
                  color: "var(--color-accent-light)",
                  letterSpacing: "0.14em",
                }}
              >
                {eyebrow}
              </span>
            ) : null}
            <h1
              className="text-[26px] font-semibold text-text-primary"
              style={{ letterSpacing: "-0.01em", lineHeight: 1.15 }}
            >
              {heading}
            </h1>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
