"use client";

import type { ReactNode } from "react";

interface ConsentCheckboxProps {
  /** DOM id tying the visually hidden input to its label. */
  id: string;
  /** Controlled checked state; consent boxes start unchecked. */
  checked: boolean;
  /** Change handler receiving the next checked state. */
  onChange: (checked: boolean) => void;
  /** Label content, typically text with a link to the legal document. */
  children: ReactNode;
}

/**
 * Affirmative-consent checkbox in the auth visual language: visually hidden
 * native input driving a styled box, so keyboard and screen-reader behavior
 * stay native. Mirrors the signup Terms checkbox
 * (`components/auth/SignUpForm.tsx`); consent boxes are never pre-checked.
 *
 * @param props - Id, controlled state, change handler, and label content.
 * @returns Labeled checkbox row.
 */
export function ConsentCheckbox({
  id,
  checked,
  onChange,
  children,
}: ConsentCheckboxProps) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-start gap-2.5">
      <input
        id={id}
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
        {children}
      </span>
    </label>
  );
}
