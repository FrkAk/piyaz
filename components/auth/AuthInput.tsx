"use client";

import { forwardRef, type InputHTMLAttributes, useId } from "react";
import { PasswordInput } from "@/components/shared/PasswordInput";

interface AuthInputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Visible label text rendered above the input. */
  label: string;
  /** Optional inline help/hint rendered under the input in muted tone. */
  hint?: string;
  /** Inline error message. Replaces `hint` when set; sets aria-invalid. */
  error?: string;
}

/**
 * Auth-form input — labelled 38px input matching the prototype.
 *
 * Surface bg with `border-strong`, focus ring snaps to the accent color.
 * `id` is auto-derived from `useId` when the caller doesn't supply one
 * so the `<label htmlFor>` association is always wired. Password fields
 * render through `PasswordInput`, which adds the reveal toggle while
 * keeping this component's styling contract intact.
 *
 * @param props - Standard input props plus `label`, `hint`, `error`.
 * @returns Vertical stack of label + input + (hint or error).
 */
export const AuthInput = forwardRef<HTMLInputElement, AuthInputProps>(
  function AuthInput(
    { label, hint, error, id, className = "", type, ...rest },
    ref,
  ) {
    const fallbackId = useId();
    const inputId = id ?? fallbackId;
    const messageId = hint || error ? `${inputId}-message` : undefined;
    const inputProps = {
      id: inputId,
      "aria-invalid": error ? true : undefined,
      "aria-describedby": messageId,
      className: `block w-full border bg-surface px-3.5 text-[13px] text-text-primary placeholder:text-text-muted outline-none transition-colors ${
        error ? "border-danger" : "border-border-strong focus:border-accent"
      } ${className}`,
      style: { height: 38, borderRadius: 8 },
      ...rest,
    };

    return (
      <div className="space-y-1.5">
        <label
          htmlFor={inputId}
          className="block text-[11px] font-medium uppercase text-text-secondary"
          style={{
            fontFamily: "var(--font-mono)",
            letterSpacing: "0.08em",
          }}
        >
          {label}
        </label>
        {type === "password" ? (
          <PasswordInput ref={ref} {...inputProps} />
        ) : (
          <input ref={ref} type={type} {...inputProps} />
        )}
        {error ? (
          <p id={messageId} role="alert" className="text-[11.5px] text-danger">
            {error}
          </p>
        ) : hint ? (
          <p id={messageId} className="text-[11.5px] text-text-muted">
            {hint}
          </p>
        ) : null}
      </div>
    );
  },
);
