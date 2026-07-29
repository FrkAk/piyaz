"use client";

import type { ReactNode } from "react";

interface AuthSubmitProps {
  /** Button label content. Replaced by loading dots when `isLoading`. */
  children: ReactNode;
  /** Disable the button and render the loading-dot indicator. */
  isLoading?: boolean;
  /** Text rendered beside the loading dots; states what the wait is for. */
  loadingLabel?: string;
  /** Disable without showing a loading indicator (e.g. coming-soon states). */
  disabled?: boolean;
  /** HTML button type — defaults to `submit` because every caller is a form submit. */
  type?: "button" | "submit";
  /** Click handler — only meaningful with `type="button"`. */
  onClick?: () => void;
}

/**
 * Auth-form primary submit — 38px gradient button matching the prototype.
 *
 * The shared `Button` primitive caps at 36px (`size="lg"`), which would
 * misalign the CTA with the 38px AuthInput rows. This component is the
 * thin wrapper that closes that 2px gap so the whole form column reads
 * as a single rhythm.
 *
 * @param props - Label, loading flag and label, disabled flag, button type,
 *   click handler.
 * @returns Full-width gradient button.
 */
export function AuthSubmit({
  children,
  isLoading,
  loadingLabel,
  disabled,
  type = "submit",
  onClick,
}: AuthSubmitProps) {
  const inactive = isLoading || disabled;
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={inactive}
      aria-busy={isLoading || undefined}
      aria-disabled={inactive || undefined}
      className={`relative inline-flex w-full items-center justify-center text-[13px] font-semibold transition-opacity outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${inactive ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:opacity-90"}`}
      style={{
        height: 38,
        borderRadius: 8,
        background: "var(--color-accent-grad)",
        color: "#0b0c10",
        border: "1px solid transparent",
        letterSpacing: "0.005em",
      }}
    >
      {isLoading ? (
        <span className="flex items-center gap-1">
          <span className="loading-dot h-1.5 w-1.5 rounded-full bg-current" />
          <span className="loading-dot h-1.5 w-1.5 rounded-full bg-current" />
          <span className="loading-dot h-1.5 w-1.5 rounded-full bg-current" />
          {loadingLabel ? <span className="ml-1">{loadingLabel}</span> : null}
        </span>
      ) : (
        children
      )}
    </button>
  );
}
