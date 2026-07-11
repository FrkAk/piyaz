"use client";

/** Props for {@link DpaConsentCheckbox}. */
interface DpaConsentCheckboxProps {
  /** Controlled checked state; consent boxes are never pre-checked. */
  checked: boolean;
  /** Change handler receiving the next checked state. */
  onChange: (checked: boolean) => void;
}

/**
 * Affirmative DPA-consent checkbox shared by both team-creation surfaces
 * (onboarding and settings), in the auth visual language: a visually
 * hidden native input driving a styled box, so keyboard and screen-reader
 * behavior stay native. The label wraps the input, so no id wiring is
 * needed.
 *
 * @param props - Controlled state and change handler.
 * @returns Labeled checkbox row with the DPA acceptance text.
 */
export function DpaConsentCheckbox({
  checked,
  onChange,
}: DpaConsentCheckboxProps) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border-[1.5px] border-border-strong transition-colors peer-checked:border-transparent peer-checked:[background:var(--color-accent-grad)] peer-checked:[&>svg]:opacity-100 peer-focus-visible:ring-2 peer-focus-visible:ring-accent"
      >
        <svg
          viewBox="0 0 12 12"
          width={11}
          height={11}
          aria-hidden="true"
          className="opacity-0 transition-opacity"
        >
          <path
            d="M2 6l3 3 5-5"
            fill="none"
            stroke="#0b0c10"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <span className="text-[12.5px] leading-snug text-text-secondary">
        I accept the{" "}
        <a
          href="/dpa"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:underline"
          style={{ color: "var(--color-accent-light)" }}
        >
          data processing agreement
        </a>{" "}
        on behalf of this team.
      </span>
    </label>
  );
}
