"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useTransition,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { motion, AnimatePresence } from "motion/react";
import { useRouter } from "next/navigation";
import { IconDoc, IconSearch } from "@/components/shared/icons";
import { Kbd } from "@/components/shared/Kbd";
import { MonoId, type MonoIdTone } from "@/components/shared/MonoId";
import { StatusGlyph } from "@/components/shared/StatusGlyph";
import { useModalChrome } from "@/hooks/useModalChrome";
import { projectColor } from "@/lib/ui/project-color";
import type { SidebarProject } from "@/components/layout/Sidebar";
import {
  searchPaletteAcrossProjects,
  type CrossProjectNoteSearchResult,
  type CrossProjectSearchResult,
} from "@/lib/graph/queries";

/** Group label rendered above each result section. */
type OptionGroup = "projects" | "tasks" | "notes" | "settings";

/** Flat option used by the keyboard model + click handlers. */
type Option =
  | {
      group: "projects";
      id: string;
      label: string;
      identifier: string;
      color: string;
      href: string;
    }
  | {
      group: "tasks";
      id: string;
      label: string;
      status: string;
      taskRef: string;
      projectTitle: string;
      projectIdentifier: string;
      href: string;
    }
  | {
      group: "notes";
      id: string;
      label: string;
      noteRef: string;
      projectTitle: string;
      href: string;
    }
  | {
      group: "settings";
      id: string;
      label: string;
      href: string;
    };

interface CommandPaletteProps {
  /** Whether the palette is open. */
  open: boolean;
  /** Close handler — wired into `useModalChrome` for Esc + focus restore. */
  onClose: () => void;
  /** Sidebar project list, supplied by the provider (avoids a refetch). */
  projects: SidebarProject[];
}

/** Result-cap per group (kept in lockstep with the server-side limit). */
const PER_GROUP_LIMIT = 10;
/** Debounce window for the server task search (ms). */
const SEARCH_DEBOUNCE_MS = 300;

/** Static settings group source — single entry today; future routes append. */
const SETTINGS_ENTRIES: { id: string; label: string; href: string }[] = [
  { id: "settings-root", label: "Settings", href: "/settings" },
];

/** Case-insensitive substring match helper. */
function matches(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * Global ⌘K command palette — projects across the user's teams, tasks
 * and notes across every project the user belongs to, and the `/settings`
 * route.
 * Built from scratch (no `cmdk` dependency) on top of `motion` and
 * `useModalChrome` so the visual shell matches every other modal in the
 * codebase. Implements the WAI-ARIA combobox + listbox pattern with full
 * Up/Down/Home/End/Enter keyboard navigation and `aria-activedescendant`.
 *
 * @param props - Palette state + project source.
 * @returns Floating dialog rendered into the AppShell tree.
 */
export function CommandPalette({
  open,
  onClose,
  projects,
}: CommandPaletteProps) {
  const router = useRouter();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const listboxId = useId();
  const optionIdPrefix = useId();
  useModalChrome(open, onClose, panelRef);

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [taskResults, setTaskResults] = useState<CrossProjectSearchResult[]>(
    [],
  );
  const [noteResults, setNoteResults] = useState<
    CrossProjectNoteSearchResult[]
  >([]);
  const [searchLoading, setSearchLoading] = useState(false);
  /** Search failure code; `null` when no error. Maps to `ERROR_MESSAGES`. */
  const [searchError, setSearchError] = useState<
    "rate_limited" | "unauthorized" | "unknown" | null
  >(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [, startTransition] = useTransition();

  // Render-phase reset on open transition. Mirrors the prev-tracker pattern
  // used in `WorkspaceClient` so we keep the project's "no setState in
  // effect" invariant. Touch only the fields that need to clear; the
  // debounce + fetch effects below converge naturally from there.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setQuery("");
      setDebouncedQuery("");
      setTaskResults([]);
      setNoteResults([]);
      setSearchError(null);
      setSearchLoading(false);
      setActiveIndex(0);
    }
  }

  // Debounce the search input — 300 ms keeps single-keystroke noise off
  // the server while still feeling immediate when the user stops typing.
  // Also fires when `query` is cleared (empty string is the natural reset).
  useEffect(() => {
    if (!open) return;
    const id = setTimeout(
      () => setDebouncedQuery(query.trim()),
      SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(id);
  }, [open, query]);

  // Render-phase reset whenever the debounced query changes: clear stale
  // results / error, and flip `searchLoading` on for the upcoming fetch (when
  // the new query is non-empty). Keeps the fetch effect below free of
  // synchronous setState calls — the effect only writes via the async
  // transition callback after the network round-trip resolves.
  const [prevDebouncedQuery, setPrevDebouncedQuery] = useState(debouncedQuery);
  if (debouncedQuery !== prevDebouncedQuery) {
    setPrevDebouncedQuery(debouncedQuery);
    setSearchError(null);
    if (debouncedQuery.length === 0) {
      setTaskResults([]);
      setNoteResults([]);
      setSearchLoading(false);
    } else {
      setSearchLoading(true);
    }
  }

  // Fetch tasks + notes via the combined cross-project server action when the
  // debounced query is non-empty. One round-trip returns both groups under a
  // single rate-limit charge. All synchronous state writes happen in the
  // render phase reset above; this effect only triggers the transition and
  // writes via its async callback. The `cancelled` flag handles
  // latest-write-wins when rapid typing produces overlapping requests.
  useEffect(() => {
    if (!open) return;
    if (debouncedQuery.length === 0) return;
    let cancelled = false;
    startTransition(async () => {
      try {
        const payload = await searchPaletteAcrossProjects(debouncedQuery);
        if (cancelled) return;
        if (payload.ok) {
          setTaskResults(payload.tasks);
          setNoteResults(payload.notes);
        } else {
          setTaskResults([]);
          setNoteResults([]);
          setSearchError(payload.code);
        }
      } catch (err) {
        if (cancelled) return;
        console.error("CommandPalette search failed", err);
        setSearchError("unknown");
        setTaskResults([]);
        setNoteResults([]);
      } finally {
        if (!cancelled) setSearchLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [open, debouncedQuery]);

  // Build the projects/tasks/notes/settings options in the order they're read.
  const options = useMemo<Option[]>(() => {
    if (debouncedQuery.length === 0) return [];
    const out: Option[] = [];

    const projectMatches = projects
      .filter(
        (p) =>
          matches(p.title, debouncedQuery) ||
          matches(p.identifier, debouncedQuery),
      )
      .slice(0, PER_GROUP_LIMIT);
    for (const p of projectMatches) {
      out.push({
        group: "projects",
        id: p.id,
        label: p.title,
        identifier: p.identifier,
        color: projectColor(p.identifier),
        href: `/project/${p.id}`,
      });
    }

    for (const row of taskResults.slice(0, PER_GROUP_LIMIT)) {
      out.push({
        group: "tasks",
        id: row.id,
        label: row.title,
        status: row.status,
        taskRef: row.taskRef,
        projectTitle: row.projectTitle,
        projectIdentifier: row.projectIdentifier,
        // `WorkspaceClient` consumes `?task=<id>` once and strips it.
        href: `/project/${row.projectId}?task=${row.id}`,
      });
    }

    for (const row of noteResults.slice(0, PER_GROUP_LIMIT)) {
      out.push({
        group: "notes",
        id: row.id,
        label: row.title,
        noteRef: row.noteRef,
        projectTitle: row.projectTitle,
        // Opens the note on the Notes surface; `WorkspaceClient` reads both.
        href: `/project/${row.projectId}?view=notes&note=${row.id}`,
      });
    }

    for (const s of SETTINGS_ENTRIES) {
      // Match both the visible label and the route — the row hints the
      // href on the right, so power users typing `/settings` directly
      // should land on it.
      if (matches(s.label, debouncedQuery) || matches(s.href, debouncedQuery)) {
        out.push({
          group: "settings",
          id: s.id,
          label: s.label,
          href: s.href,
        });
      }
    }

    return out;
  }, [projects, taskResults, noteResults, debouncedQuery]);

  // Reset the highlight whenever the option list shape changes (new
  // results landed). Render-phase prev-tracker pattern, same as above.
  const [prevOptionsLen, setPrevOptionsLen] = useState(options.length);
  if (options.length !== prevOptionsLen) {
    setPrevOptionsLen(options.length);
    setActiveIndex(0);
  }

  const optionRefs = useRef(new Map<number, HTMLLIElement>());
  const setOptionRef = useCallback(
    (idx: number) => (el: HTMLLIElement | null) => {
      if (el) optionRefs.current.set(idx, el);
      else optionRefs.current.delete(idx);
    },
    [],
  );

  // Keep the active row in view as the user arrows past the scroll window.
  useEffect(() => {
    const el = optionRefs.current.get(activeIndex);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const activate = useCallback(
    (idx: number) => {
      const opt = options[idx];
      if (!opt) return;
      // Close first so the modal teardown doesn't race the route change.
      onClose();
      router.push(opt.href);
    },
    [options, onClose, router],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (options.length === 0) {
        if (e.key === "Enter") e.preventDefault();
        return;
      }
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setActiveIndex((i) => Math.min(i + 1, options.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setActiveIndex((i) => Math.max(i - 1, 0));
          break;
        case "Home":
          e.preventDefault();
          setActiveIndex(0);
          break;
        case "End":
          e.preventDefault();
          setActiveIndex(options.length - 1);
          break;
        case "Enter":
          e.preventDefault();
          activate(activeIndex);
          break;
        default:
          break;
      }
    },
    [options.length, activeIndex, activate],
  );

  const onRowMouseDown = useCallback((e: MouseEvent<HTMLLIElement>) => {
    // Don't steal focus from the input so the keyboard model stays consistent.
    e.preventDefault();
  }, []);

  // Group rendering — derive boundaries from the flat option list so the
  // highlight index always matches what the user sees on screen.
  const groups = useMemo(() => {
    const result: { group: OptionGroup; startIdx: number; items: Option[] }[] =
      [];
    let cursor = 0;
    for (const opt of options) {
      const last = result[result.length - 1];
      if (last && last.group === opt.group) {
        last.items.push(opt);
      } else {
        result.push({ group: opt.group, startIdx: cursor, items: [opt] });
      }
      cursor++;
    }
    return result;
  }, [options]);

  const hasQuery = debouncedQuery.length > 0;
  const showZeroResults =
    hasQuery && options.length === 0 && !searchLoading && searchError === null;
  const errorMessage = searchError ? ERROR_MESSAGES[searchError] : null;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="cmdk-backdrop"
          className="fixed inset-0 z-[60] flex items-start justify-center bg-base/70 px-4 pt-[15vh] backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
        >
          <motion.div
            key="cmdk-panel"
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.18, ease: [0.25, 0.46, 0.45, 0.94] }}
            className="relative flex max-h-[70vh] w-full max-w-xl flex-col rounded-[10px] border border-border bg-surface shadow-[var(--shadow-float)]"
          >
            <div className="flex flex-shrink-0 items-center gap-2 px-4 py-3">
              <IconSearch
                size={14}
                className="text-text-muted"
                aria-hidden="true"
              />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Search projects, tasks, notes, settings…"
                aria-label="Search projects, tasks, notes, and settings"
                role="combobox"
                aria-controls={listboxId}
                // The combobox popup is visible the moment the user has
                // typed a query — even while showing the "No results" or
                // "Searching…" placeholder. Tying `aria-expanded` to
                // `hasQuery` rather than `options.length > 0` keeps the
                // ARIA state in sync with what's actually on screen.
                aria-expanded={hasQuery}
                aria-activedescendant={
                  options.length > 0
                    ? `${optionIdPrefix}-${activeIndex}`
                    : undefined
                }
                autoComplete="off"
                spellCheck={false}
                className="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-muted outline-none"
              />
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto py-2">
              {!hasQuery && (
                <p className="px-4 py-6 text-center text-[12px] text-text-muted">
                  Type to search projects, tasks, notes, and settings…
                </p>
              )}
              {hasQuery && errorMessage !== null && (
                <p
                  role="alert"
                  className={`mx-4 mb-2 flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[11px] ${
                    searchError === "rate_limited"
                      ? "border-progress/30 bg-progress/10 text-progress"
                      : "border-border bg-base/40 text-text-secondary"
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${
                      searchError === "rate_limited"
                        ? "bg-progress"
                        : "bg-text-muted"
                    }`}
                  />
                  {errorMessage}
                </p>
              )}
              {showZeroResults && (
                <p className="px-4 py-6 text-center text-[12px] text-text-muted">
                  No results for &ldquo;{debouncedQuery}&rdquo;
                </p>
              )}
              {hasQuery && options.length > 0 && (
                <ul
                  id={listboxId}
                  role="listbox"
                  aria-label="Search results"
                  className="flex flex-col gap-px"
                >
                  {groups.map((g) => (
                    <ResultGroup
                      key={g.group}
                      group={g.group}
                      items={g.items}
                      startIdx={g.startIdx}
                      activeIndex={activeIndex}
                      optionIdPrefix={optionIdPrefix}
                      setOptionRef={setOptionRef}
                      onMouseMove={setActiveIndex}
                      onMouseDown={onRowMouseDown}
                      onClick={activate}
                      searchLoading={
                        searchLoading &&
                        (g.group === "tasks" || g.group === "notes")
                      }
                    />
                  ))}
                </ul>
              )}
              {hasQuery && options.length === 0 && searchLoading && (
                <p className="px-4 py-6 text-center text-[12px] text-text-muted">
                  Searching…
                </p>
              )}
            </div>

            <div className="flex flex-shrink-0 items-center justify-end gap-3 px-4 py-2 text-[11px] text-text-muted">
              <span className="inline-flex items-center gap-1.5">
                <Kbd dim>↑↓</Kbd> navigate
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Kbd dim>↵</Kbd> select
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Kbd dim>Esc</Kbd> close
              </span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

interface ResultGroupProps {
  group: OptionGroup;
  items: Option[];
  startIdx: number;
  activeIndex: number;
  optionIdPrefix: string;
  setOptionRef: (idx: number) => (el: HTMLLIElement | null) => void;
  onMouseMove: (idx: number) => void;
  onMouseDown: (e: MouseEvent<HTMLLIElement>) => void;
  onClick: (idx: number) => void;
  searchLoading: boolean;
}

/** Section header + option rows for one group (projects / tasks / settings). */
function ResultGroup({
  group,
  items,
  startIdx,
  activeIndex,
  optionIdPrefix,
  setOptionRef,
  onMouseMove,
  onMouseDown,
  onClick,
  searchLoading,
}: ResultGroupProps) {
  return (
    <>
      <li
        role="presentation"
        aria-hidden="true"
        className="flex items-center gap-1.5 px-4 pt-2 pb-1 font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted"
      >
        <span>{GROUP_LABELS[group]}</span>
        {searchLoading && (
          <span className="font-sans normal-case tracking-normal text-text-faint">
            searching…
          </span>
        )}
      </li>
      {items.map((opt, i) => {
        const idx = startIdx + i;
        const active = idx === activeIndex;
        return (
          <li
            key={`${opt.group}-${opt.id}`}
            ref={setOptionRef(idx)}
            id={`${optionIdPrefix}-${idx}`}
            role="option"
            aria-selected={active}
            data-index={idx}
            onMouseMove={() => onMouseMove(idx)}
            onMouseDown={onMouseDown}
            onClick={() => onClick(idx)}
            className={`relative mx-2 flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-[12px] transition-colors ${
              active
                ? "bg-surface-hover text-text-primary"
                : "text-text-secondary hover:bg-surface-hover/60"
            }`}
          >
            {/* 2px accent-gradient strip on the active row's leading edge —
                mirrors TaskRow's selected state so the palette feels like
                a continuation of the workspace list. */}
            {active && (
              <span
                aria-hidden="true"
                className="absolute inset-y-1 left-0 w-[2px] rounded-r-[2px]"
                style={{ background: "var(--color-accent-grad)" }}
              />
            )}
            <ResultRow option={opt} />
          </li>
        );
      })}
    </>
  );
}

/** Per-group label dictionary kept next to the rendering. */
const GROUP_LABELS: Record<OptionGroup, string> = {
  projects: "Projects",
  tasks: "Tasks",
  notes: "Notes",
  settings: "Navigation",
};

/** Human copy for each search failure code. */
const ERROR_MESSAGES: Record<
  "rate_limited" | "unauthorized" | "unknown",
  string
> = {
  rate_limited: "Slow down: too many searches. Try again in a moment.",
  unauthorized: "Sign in to search across your projects.",
  unknown: "Couldn't load results. Try again.",
};

/** Visual content of one result row — varies by group. */
function ResultRow({ option }: { option: Option }) {
  if (option.group === "projects") {
    return (
      <>
        <span
          aria-hidden="true"
          className="h-2 w-2 flex-shrink-0 rounded-[2px]"
          style={{ background: option.color }}
        />
        <span className="flex-1 truncate">{option.label}</span>
        <span className="font-mono text-[10px] text-text-faint">
          {option.identifier}
        </span>
      </>
    );
  }
  if (option.group === "tasks") {
    return (
      <>
        {/* Sole leading affordance, matches workspace TaskRow. */}
        <StatusGlyph
          status={option.status}
          size={11}
          className="flex-shrink-0"
        />
        {/* Fixed-width column so titles vertically align across rows
            regardless of identifier length. 96px fits a 10-char project
            prefix + dash + 4-digit sequence at 11px Geist Mono. */}
        <span className="inline-flex w-24 flex-shrink-0 items-center">
          <MonoId
            id={option.taskRef}
            tone={option.status as MonoIdTone}
            dim={option.status === "done" || option.status === "cancelled"}
            copyable={false}
          />
        </span>
        <span className="flex-1 truncate">{option.label}</span>
        <span className="truncate text-[11px] text-text-faint">
          {option.projectTitle}
        </span>
      </>
    );
  }
  if (option.group === "notes") {
    return (
      <>
        <IconDoc
          size={13}
          className="flex-shrink-0 text-text-muted"
          aria-hidden="true"
        />
        <span className="inline-flex w-24 flex-shrink-0 items-center">
          <MonoId id={option.noteRef} copyable={false} />
        </span>
        <span className="flex-1 truncate">{option.label || "Untitled"}</span>
        <span className="truncate text-[11px] text-text-faint">
          {option.projectTitle}
        </span>
      </>
    );
  }
  // settings
  return (
    <>
      <span
        aria-hidden="true"
        className="h-2 w-2 flex-shrink-0 rounded-[2px] bg-border"
      />
      <span className="flex-1 truncate">{option.label}</span>
      <span className="font-mono text-[10px] text-text-faint">
        {option.href}
      </span>
    </>
  );
}

export default CommandPalette;
