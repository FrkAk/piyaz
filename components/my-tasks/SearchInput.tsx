"use client";

import { forwardRef } from "react";
import { Kbd } from "@/components/shared/Kbd";
import { IconSearch, IconX } from "@/components/shared/icons";

interface SearchInputProps {
  value: string;
  onChange: (next: string) => void;
}

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
