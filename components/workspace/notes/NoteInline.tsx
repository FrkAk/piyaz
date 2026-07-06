"use client";

import { createContext, Fragment, useContext } from "react";
import { STATUS_META } from "@/components/shared/StatusGlyph";
import type { LinkedNoteSlim, NoteMention } from "@/lib/data/note";
import { type InlineToken, tokenizeInline } from "./note-blocks";
import { NOTE_TYPE_META, tint } from "./note-meta";

/**
 * Inline link resolution for the live editor: chip data and navigation,
 * resolved from the selected note's detail payload, never from global
 * maps. `mentionsBySeq` keys on the numeric suffix of `mention.taskRef`;
 * `notesByTitle` keys on the lowercased title (the extractor dedupes
 * titles case-insensitively).
 */
export interface NoteLinkContextValue {
  identifier: string;
  mentionsBySeq: ReadonlyMap<number, NoteMention>;
  notesByTitle: ReadonlyMap<string, LinkedNoteSlim>;
  onTask: (taskId: string) => void;
  onNote: (noteId: string) => void;
}

/** Link resolution + navigation, provided once by the editor body. */
export const NoteLinkContext = createContext<NoteLinkContextValue | null>(null);

const CHIP_CLASS =
  "inline-flex items-center rounded px-1.5 align-baseline font-mono text-[0.82em]";

interface InlineTextProps {
  /** @param text - A single block's text. */
  text: string;
}

/**
 * Render one block's text with inline task chips, doc links, inline code,
 * and bold runs resolved. React elements over sliced text only; without a
 * provider the text renders plain.
 *
 * @param props - The block text.
 * @returns The tokenized inline content.
 */
export function InlineText({ text }: InlineTextProps) {
  const ctx = useContext(NoteLinkContext);
  if (ctx === null) return <Fragment>{text}</Fragment>;
  return (
    <Fragment>
      {tokenizeInline(text, ctx.identifier).map((token, idx) => {
        const key = `${idx}-${token.text}`;
        if (token.kind === "task") return <TaskChip key={key} token={token} />;
        if (token.kind === "wiki") return <DocLink key={key} token={token} />;
        if (token.kind === "code") return <code key={key}>{token.text}</code>;
        if (token.kind === "bold")
          return (
            <strong
              key={key}
              style={{ color: "var(--color-text-primary)", fontWeight: 600 }}
            >
              {token.text}
            </strong>
          );
        return <Fragment key={key}>{token.text}</Fragment>;
      })}
    </Fragment>
  );
}

interface TaskChipProps {
  /** @param token - The matched task-ref token. */
  token: Extract<InlineToken, { kind: "task" }>;
}

/**
 * Inline task-ref chip, status conveyed by chip color and clickable to
 * open the task. An unknown ref renders a non-interactive danger chip.
 *
 * @param props - The task token.
 * @returns The chip button, or an inert danger chip for an unknown ref.
 */
function TaskChip({ token }: TaskChipProps) {
  const ctx = useContext(NoteLinkContext);
  const mention = ctx?.mentionsBySeq.get(token.seq);
  if (ctx === null || mention === undefined) {
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
        {token.text}
      </span>
    );
  }
  const color = STATUS_META[mention.status].cssVar;
  return (
    <button
      type="button"
      title={`${STATUS_META[mention.status].label} · ${mention.title}`}
      onClick={() => ctx.onTask(mention.taskId)}
      className={`${CHIP_CLASS} cursor-pointer`}
      style={{
        color,
        background: tint(color, 12),
        border: `1px solid ${tint(color, 30)}`,
      }}
    >
      {token.text}
    </button>
  );
}

interface DocLinkProps {
  /** @param token - The matched wiki-link token. */
  token: Extract<InlineToken, { kind: "wiki" }>;
}

/**
 * Inline `[[note]]` link, colored by the target note's type and clickable
 * to open it. An unresolved title renders danger text, never a crash.
 *
 * @param props - The wiki token.
 * @returns The link button, or danger text for an unresolved title.
 */
function DocLink({ token }: DocLinkProps) {
  const ctx = useContext(NoteLinkContext);
  const target = ctx?.notesByTitle.get(token.title.toLowerCase());
  if (ctx === null || target === undefined) {
    return (
      <span style={{ color: "var(--color-danger)" }} title="Unresolved link">
        [[{token.title}]]
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
      {token.title}
    </button>
  );
}
