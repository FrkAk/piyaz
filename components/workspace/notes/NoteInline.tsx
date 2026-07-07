"use client";

import { createContext, useContext } from "react";
import { STATUS_META } from "@/components/shared/StatusGlyph";
import type { NoteType, TaskStatus } from "@/lib/types";
import { NOTE_TYPE_META, tint } from "./note-meta";

/** Resolved inline task-chip target. */
export type NoteTaskTarget = {
  taskId: string;
  title: string;
  status: TaskStatus;
};

/** Resolved inline `[[wiki]]` link target. */
export type NoteLinkTarget = { id: string; title: string; type: NoteType };

/**
 * Inline link resolution for the live editor: chip data and navigation.
 * Resolved from data already loaded in the workspace, not the note's
 * server-derived payload, so a just-typed ref renders live without a
 * refetch. `tasksBySeq` keys on the numeric ref suffix (from the workspace
 * task map); `notesByTitle` keys on the lowercased title (from the note
 * tree list), deduped case-insensitively like the extractor.
 */
export interface NoteLinkContextValue {
  identifier: string;
  tasksBySeq: ReadonlyMap<number, NoteTaskTarget>;
  notesByTitle: ReadonlyMap<string, NoteLinkTarget>;
  onTask: (taskId: string) => void;
  onNote: (noteId: string) => void;
}

/** Link resolution + navigation, provided once by the editor body. */
export const NoteLinkContext = createContext<NoteLinkContextValue | null>(null);

const CHIP_CLASS =
  "inline-flex items-center rounded px-1.5 align-baseline font-mono text-[0.82em]";

interface TaskChipProps {
  /** @param seq - The task sequence number from the ref (e.g. 3 in `RSC-3`). */
  seq: number;
}

/**
 * Inline task-ref chip, status conveyed by chip color and clickable to
 * open the task. An unknown ref renders a non-interactive danger chip.
 * Resolution and navigation come from the surrounding {@link NoteLinkContext}.
 *
 * @param props - The task sequence number.
 * @returns The chip button, or an inert danger chip for an unknown ref.
 */
export function TaskChip({ seq }: TaskChipProps) {
  const ctx = useContext(NoteLinkContext);
  const task = ctx?.tasksBySeq.get(seq);
  const label = ctx === null ? `-${seq}` : `${ctx.identifier}-${seq}`;
  if (ctx === null || task === undefined) {
    return (
      <span
        title="Unknown task"
        className={CHIP_CLASS}
        style={{
          color: "var(--color-danger)",
          background: tint("var(--color-danger)", 12),
          border: `1px solid ${tint("var(--color-danger)", 30)}`,
        }}
      >
        {label}
      </span>
    );
  }
  const color = STATUS_META[task.status].cssVar;
  return (
    <button
      type="button"
      title={`${STATUS_META[task.status].label} · ${task.title}`}
      onClick={() => ctx.onTask(task.taskId)}
      className={`${CHIP_CLASS} cursor-pointer`}
      style={{
        color,
        background: tint(color, 12),
        border: `1px solid ${tint(color, 30)}`,
      }}
    >
      {label}
    </button>
  );
}

interface DocLinkProps {
  /** @param title - The `[[wiki]]` link title. */
  title: string;
}

/**
 * Inline `[[note]]` link, colored by the target note's type and clickable
 * to open it. An unresolved title renders danger text, never a crash.
 * Resolution and navigation come from the surrounding {@link NoteLinkContext}.
 *
 * @param props - The wiki-link title.
 * @returns The link button, or danger text for an unresolved title.
 */
export function DocLink({ title }: DocLinkProps) {
  const ctx = useContext(NoteLinkContext);
  const target = ctx?.notesByTitle.get(title.toLowerCase());
  if (ctx === null || target === undefined) {
    return (
      <span style={{ color: "var(--color-danger)" }} title="Unresolved link">
        [[{title}]]
      </span>
    );
  }
  const meta = NOTE_TYPE_META[target.type];
  return (
    <button
      type="button"
      title={`${meta.label} · ${target.title}`}
      onClick={() => ctx.onNote(target.id)}
      className="cursor-pointer bg-transparent p-0 align-baseline"
      style={{
        color: meta.color,
        borderBottom: `1px solid ${tint(meta.color, 42)}`,
      }}
    >
      {title}
    </button>
  );
}
