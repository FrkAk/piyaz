import type { CSSProperties, ReactNode } from "react";

/**
 * Register of an auth notice, which decides its colour.
 *
 * `danger` is an obstruction the visitor can clear. `muted` is a dead end:
 * nothing they did caused it and nothing they do here fixes it, so it reads as
 * information rather than alarm. Painting both red spends the danger colour on
 * a state with no action attached, which drains it from the states that need
 * it.
 */
export type AuthNoticeTone = "danger" | "muted";

interface AuthNoticeProps {
  /** Colour register; defaults to the recoverable-obstruction treatment. */
  tone?: AuthNoticeTone;
  /** Explanation of what happened. */
  children: ReactNode;
  /** Inline recovery action. Omit for terminal states, which have none. */
  action?: { label: string; onClick: () => void };
}

const TONE_STYLE: Readonly<Record<AuthNoticeTone, CSSProperties>> = {
  danger: {
    background: "color-mix(in srgb, var(--color-danger) 10%, transparent)",
    borderColor: "color-mix(in srgb, var(--color-danger) 24%, transparent)",
  },
  muted: {
    background: "var(--color-surface)",
    borderColor: "var(--color-border-strong)",
  },
};

/**
 * Explanatory strip for the auth forms, with an optional inline recovery
 * action.
 *
 * Carries the same geometry as the forms' inline error paragraphs (rounded-md,
 * one-step border, 12.5px secondary text) so the auth column keeps a single
 * rhythm, and adds the one thing those cannot express: an action sitting on the
 * baseline beside the explanation. Enters on the shared `rise-in`, which the
 * global reduced-motion rule already neutralises.
 *
 * @param props - Tone, explanation, and optional recovery action.
 * @returns The notice strip.
 */
export function AuthNotice({
  tone = "danger",
  children,
  action,
}: AuthNoticeProps) {
  return (
    <div
      role="alert"
      className="rise-in flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-2.5 text-[12.5px] leading-relaxed text-text-secondary"
      style={TONE_STYLE[tone]}
    >
      <span>{children}</span>
      {action ? (
        <button
          type="button"
          onClick={action.onClick}
          className="shrink-0 cursor-pointer rounded-[3px] text-[11.5px] font-medium underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
          style={{ color: "var(--color-accent-light)" }}
        >
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Host name rendered inline in notice copy.
 *
 * Set a step below the surrounding sans text: a monospace face reads optically
 * larger at the same pixel size, and the auth surface already sets its mono
 * eyebrows smaller than their neighbours for the same reason.
 *
 * @param props.children - The host name.
 * @returns The inline mono span.
 */
export function NoticeHost({ children }: { children: ReactNode }) {
  return (
    <span className="font-mono text-[11.5px] text-text-primary">
      {children}
    </span>
  );
}
