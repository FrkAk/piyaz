"use client";

import { forwardRef } from "react";
import { Kbd } from "@/components/shared/Kbd";
import { IconSearch, IconX } from "@/components/shared/icons";

interface SearchInputProps {
  /** Current input value. */
  value: string;
  /** Update handler. */
  onChange: (next: string) => void;
}

/**
 * Borderless mono search input with a leading IconSearch, a clear button
 * (only when the input has content), and a trailing `<Kbd>/</Kbd>` hint.
 * The `/` hotkey is wired by the parent — this component only owns the
 * focusable `<input>` element via the forwarded ref.
 *
 * @param props - Value + onChange.
 * @param ref - Forwarded input ref the parent can focus.
 * @returns Inline-flex search row.
 */
export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(
  function SearchInput({ value, onChange }, ref) {
    return (
      <div className="flex h-9 items-center gap-2.5 px-3.5 text-text-muted">
        <IconSearch size={12} />
        <input
          ref={ref}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Search title, ID, project, tag…"
          aria-label="Search assigned tasks"
          className="min-w-0 flex-1 border-none bg-transparent font-mono text-[12px] text-text-primary outline-none placeholder:text-text-muted"
        />
        {value.length > 0 && (
          <button
            type="button"
            onClick={() => onChange("")}
            aria-label="Clear search"
            title="Clear search"
            className="inline-flex h-[18px] w-[18px] cursor-pointer items-center justify-center rounded text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary"
          >
            <IconX size={10} />
          </button>
        )}
        <span className="hidden md:inline-flex">
          <Kbd>/</Kbd>
        </span>
      </div>
    );
  },
);
