"use client";

import { useCallback, useRef } from "react";
import type { ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { IconDoc, IconGraph, IconTasks } from "@/components/shared/icons";

/** Workspace view identifier — the `?view` query param value space. */
export type WorkspaceView = "structure" | "graph" | "notes";

/**
 * Resolve the active view from the URL — defaults to `structure` when the
 * key is missing or unrecognised.
 *
 * @param raw - Raw `view` query param.
 * @returns Workspace view identifier.
 */
export function readView(raw: string | null): WorkspaceView {
  if (raw === "graph" || raw === "notes") return raw;
  return "structure";
}

/** Tab definitions — fixed to the three workspace views. */
const TABS: ReadonlyArray<{
  id: WorkspaceView;
  label: string;
  icon: ReactNode;
}> = [
  { id: "structure", label: "Tasks", icon: <IconTasks size={13} /> },
  { id: "graph", label: "Graph", icon: <IconGraph size={13} /> },
  { id: "notes", label: "Notes", icon: <IconDoc size={13} /> },
];

interface ViewSwitcherProps {
  /** @param active - Currently active workspace view. */
  active: WorkspaceView;
  /** @param onChange - Called with the next view on selection. */
  onChange: (next: WorkspaceView) => void;
}

/**
 * Compact segmented workspace view switcher — Tasks / Graph / Notes. The
 * tasks view keeps its historical `structure` param value so existing
 * URLs stay valid. Pill styling with roving tabindex and arrow-key
 * navigation along the tablist.
 *
 * @param props - Controlled `active` view and change handler.
 * @returns A `<div role="tablist">` wrapping each view as a `<button role="tab">`.
 */
export function ViewSwitcher({ active, onChange }: ViewSwitcherProps) {
  const refs = useRef<Map<WorkspaceView, HTMLButtonElement>>(new Map());

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const idx = TABS.findIndex((t) => t.id === active);
      if (idx < 0) return;
      let next = -1;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        next = (idx + 1) % TABS.length;
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        next = (idx - 1 + TABS.length) % TABS.length;
      }
      if (next >= 0) {
        e.preventDefault();
        const target = TABS[next];
        onChange(target.id);
        refs.current.get(target.id)?.focus();
      }
    },
    [active, onChange],
  );

  return (
    <div
      role="tablist"
      aria-label="View"
      className="inline-flex items-center gap-0.5 rounded-md p-0.5"
      style={{
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
      }}
    >
      {TABS.map((t) => {
        const on = t.id === active;
        return (
          <button
            key={t.id}
            ref={(el) => {
              if (el) refs.current.set(t.id, el);
              else refs.current.delete(t.id);
            }}
            role="tab"
            type="button"
            aria-selected={on}
            aria-label={t.label}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(t.id)}
            onKeyDown={handleKeyDown}
            className="inline-flex h-6 cursor-pointer items-center gap-1.5 rounded px-2 text-[12px]"
            style={{
              fontWeight: on ? 600 : 500,
              color: on
                ? "var(--color-text-primary)"
                : "var(--color-text-muted)",
              background: on ? "var(--color-surface-hover)" : "transparent",
            }}
          >
            <span
              style={{
                display: "inline-flex",
                color: on ? "var(--color-accent-light)" : "currentColor",
              }}
            >
              {t.icon}
            </span>
            <span className="hidden sm:inline">{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * URL-wired workspace view switcher for the global TopBar. Reads the
 * active view from the `?view` query param and writes changes with
 * `router.replace` — `structure` is the default and clears the param.
 * Mount only on the project workspace route.
 *
 * @returns The controlled {@link ViewSwitcher}.
 */
export function WorkspaceViewSwitcher() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const view = readView(searchParams.get("view"));

  const handleChange = useCallback(
    (next: WorkspaceView) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === "structure") params.delete("view");
      else params.set("view", next);
      const nextQs = params.toString();
      if (nextQs === searchParams.toString()) return;
      router.replace(nextQs ? `${pathname}?${nextQs}` : pathname, {
        scroll: false,
      });
    },
    [router, pathname, searchParams],
  );

  return <ViewSwitcher active={view} onChange={handleChange} />;
}

export default ViewSwitcher;
