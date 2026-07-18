"use client";

import { forwardRef, useState, type InputHTMLAttributes } from "react";
import { IconEye, IconEyeOff } from "@/components/shared/icons";

type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type">;

const TOGGLE_CLEARANCE_PX = 36;

/**
 * Password input with a reveal toggle.
 *
 * The caller's `className` and `style` pass through untouched so every
 * surface keeps its own field styling; the input reserves right padding
 * via inline style (deterministic against any utility class) for the eye
 * button pinned inside the right edge. The toggle is `type="button"` so
 * it can never submit the enclosing form, flips the input between
 * `password` and `text`, and mirrors the input's `disabled` state.
 * Reveal state lives only in component memory and resets on unmount;
 * `autoComplete` and password-manager semantics are untouched.
 *
 * @param props - Standard input props except `type`, which the component owns.
 * @returns Relative wrapper hosting the input and the reveal toggle.
 */
export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
  function PasswordInput({ style, disabled, ...rest }, ref) {
    const [revealed, setRevealed] = useState(false);

    return (
      <div className="relative">
        <input
          ref={ref}
          type={revealed ? "text" : "password"}
          disabled={disabled}
          style={{ ...style, paddingRight: TOGGLE_CLEARANCE_PX }}
          {...rest}
        />
        <button
          type="button"
          disabled={disabled}
          aria-label={revealed ? "Hide password" : "Show password"}
          aria-pressed={revealed}
          onClick={() => setRevealed((value) => !value)}
          className="absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-md text-text-muted transition-colors hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-text-muted"
        >
          {revealed ? <IconEyeOff size={15} /> : <IconEye size={15} />}
        </button>
      </div>
    );
  },
);
