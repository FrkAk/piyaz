import type { ReactNode } from "react";

/**
 * Mono uppercase context label rendered above an auth-page heading, in
 * the shared accent-light eyebrow treatment.
 *
 * @param props - Component props.
 * @param props.children - Eyebrow text.
 * @returns Block-level styled span.
 */
export function AuthEyebrow({ children }: { children: ReactNode }) {
  return (
    <span
      className="mb-2 block font-mono text-[10px] font-semibold uppercase"
      style={{
        color: "var(--color-accent-light)",
        letterSpacing: "0.14em",
      }}
    >
      {children}
    </span>
  );
}
