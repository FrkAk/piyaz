"use client";

import { motion } from "motion/react";
import { useState, useRef, useEffect } from "react";
import { MonoId } from "@/components/shared/MonoId";
import {
  IconPanelLeft,
  IconPanelRight,
  IconSettings,
  IconX,
} from "@/components/shared/icons";
import { updateTask } from "@/lib/graph/mutations";
import { useInlineEdit } from "@/hooks/useInlineEdit";
import { isModalOpen } from "@/hooks/useModalChrome";
import type { TaskStatus } from "@/lib/types";

interface DetailHeaderProps {
  /** Task UUID. */
  taskId: string;
  /** Composed task identifier (e.g. `MYMR-104`). */
  taskRef: string;
  /** Display title. */
  title: string;
  /** Schema status — currently unused at the header level (lives in PropRail). */
  status: TaskStatus;
  /** Project name for the breadcrumb. */
  projectName: string;
  /** Whether the PropRail drawer is currently open (mobile / 1024–1279px). */
  drawerOpen: boolean;
  /** Toggle the PropRail drawer. */
  onToggleDrawer: () => void;
  /** Close the detail panel — bound to ✕ button and Esc. */
  onClose: () => void;
  /** Refresh the graph after a title update. */
  onGraphChange?: () => void;
  /**
   * @param navigatorClosed - Whether the structure navigator pane is hidden.
   *   Drives the panel-toggle's `aria-pressed`/tooltip state. Pass `undefined`
   *   to suppress the toggle entirely (e.g. graph mode or below-xl viewports
   *   where the navigator-fold affordance doesn't apply).
   */
  navigatorClosed?: boolean;
  /** @param onToggleNavigator - Flip the navigator open/closed. Renders the panel-toggle when provided. */
  onToggleNavigator?: () => void;
  /**
   * @param propRailOpen - Whether the right-side properties rail is currently
   *   visible. Drives the toggle's pressed state. Used in the graph workspace
   *   where the rail can be collapsed to give the canvas more room.
   */
  propRailOpen?: boolean;
  /** @param onTogglePropRail - Flip the properties rail open/closed. Renders the panel-right toggle when provided. */
  onTogglePropRail?: () => void;
}

/**
 * Detail-column header — terse top row with the mono ID + project name on
 * the left and a viewport-conditional drawer toggle on the right, then the
 * inline-editable H1 title below. Esc closes the panel.
 *
 * @param props - Header configuration.
 * @returns Header element above the scrollable detail body.
 */
export function DetailHeader({
  taskId,
  taskRef,
  title,
  projectName,
  drawerOpen,
  onToggleDrawer,
  onClose,
  onGraphChange,
  navigatorClosed,
  onToggleNavigator,
  propRailOpen,
  onTogglePropRail,
}: DetailHeaderProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [prevTitle, setPrevTitle] = useState(title);
  const cancelledRef = useRef(false);
  const titleEdit = useInlineEdit(() => setEditing(true), "point");

  if (title !== prevTitle) {
    setPrevTitle(title);
    setDraft(title);
  }

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (editing) return;
      // Yield to any open dialog (modal, palette, drawer). The modal
      // stack owns this Escape regardless of listener registration
      // order; without the check, dismissing a dialog would also
      // deselect the task behind it.
      if (isModalOpen()) return;
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;
      onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [editing, onClose]);

  /** Save the title if it changed; restore on Esc. */
  const handleSaveTitle = async () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (!trimmed) {
      setDraft(title);
      return;
    }
    if (trimmed !== title) {
      try {
        await updateTask(taskId, { title: trimmed });
        onGraphChange?.();
      } catch {
        // Server actions mask error details in production; reopen the editor
        // with the draft intact so the user's text is not silently dropped.
        setEditing(true);
      }
    }
  };

  return (
    <div className="shrink-0 bg-base">
      <div className="mx-auto max-w-[720px] px-4 pt-5 sm:px-6 lg:px-8">
        <div className="flex items-center gap-2.5">
          <MonoId id={taskRef} hintOnMount />
          <span className="text-text-faint">·</span>
          <span className="truncate text-[12px] text-text-muted">
            {projectName}
          </span>

          <span className="flex-1" />

          {onToggleNavigator !== undefined && (
            <button
              type="button"
              onClick={onToggleNavigator}
              aria-pressed={navigatorClosed}
              aria-label={navigatorClosed ? "Show structure" : "Hide structure"}
              title={
                navigatorClosed
                  ? "Show structure — slide back"
                  : "Hide structure — focus on task"
              }
              className={`hidden h-7 w-7 cursor-pointer items-center justify-center rounded-md border transition-colors xl:inline-flex ${
                navigatorClosed
                  ? "border-accent/30 bg-accent/10 text-accent-light"
                  : "border-border-strong text-text-muted hover:bg-surface-hover hover:text-text-secondary"
              }`}
            >
              <IconPanelLeft size={13} />
            </button>
          )}

          {onTogglePropRail !== undefined && (
            <button
              type="button"
              onClick={onTogglePropRail}
              aria-pressed={!propRailOpen}
              aria-label={propRailOpen ? "Hide properties" : "Show properties"}
              title={
                propRailOpen
                  ? "Hide properties — give the canvas more room"
                  : "Show properties"
              }
              className={`hidden h-7 w-7 cursor-pointer items-center justify-center rounded-md border transition-colors xl:inline-flex ${
                !propRailOpen
                  ? "border-accent/30 bg-accent/10 text-accent-light"
                  : "border-border-strong text-text-muted hover:bg-surface-hover hover:text-text-secondary"
              }`}
            >
              <IconPanelRight size={13} />
            </button>
          )}

          <button
            type="button"
            onClick={onToggleDrawer}
            aria-pressed={drawerOpen}
            aria-label={drawerOpen ? "Hide properties" : "Show properties"}
            title={drawerOpen ? "Hide properties" : "Show properties"}
            className={`inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border transition-colors xl:hidden ${
              drawerOpen
                ? "border-accent/30 bg-accent/10 text-accent-light"
                : "border-border-strong text-text-muted hover:bg-surface-hover hover:text-text-secondary"
            }`}
          >
            <IconSettings size={13} />
          </button>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close task"
            title="Close task (Esc)"
            className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-border-strong text-text-muted transition-colors hover:bg-surface-hover hover:text-text-secondary"
          >
            <IconX size={12} />
          </button>
        </div>

        <div className="pt-2">
          {editing ? (
            <input
              type="text"
              value={draft}
              autoFocus
              onFocus={titleEdit.onEditorFocus}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => {
                if (cancelledRef.current) {
                  cancelledRef.current = false;
                  setDraft(title);
                  setEditing(false);
                } else {
                  void handleSaveTitle();
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.currentTarget.blur();
                }
                if (e.key === "Escape") {
                  cancelledRef.current = true;
                  e.currentTarget.blur();
                }
              }}
              className="-mx-1 w-[calc(100%+0.5rem)] rounded bg-transparent px-1 text-[22px] font-semibold leading-[1.25] text-text-primary outline-none ring-1 ring-accent/40 transition focus:ring-accent/70"
              style={{ letterSpacing: "-0.005em" }}
            />
          ) : (
            <motion.h1
              onDoubleClick={titleEdit.onDoubleClick}
              title="Double-click to edit"
              initial={false}
              className="-mx-1 cursor-text rounded px-1 text-[22px] font-semibold leading-[1.25] text-text-primary transition-colors hover:bg-surface-raised/40"
              style={{ letterSpacing: "-0.005em" }}
            >
              {title}
            </motion.h1>
          )}
        </div>
      </div>
    </div>
  );
}

export default DetailHeader;
