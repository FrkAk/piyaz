"use client";

import { useMemo, useState } from "react";
import { AutoGrowTextarea } from "@/components/shared/AutoGrowTextarea";
import { IconPlus } from "@/components/shared/icons";
import { type Block, parseBlocks, splitChunks } from "./note-blocks";
import { InlineText } from "./NoteInline";

interface LiveEditorProps {
  /** @param body - Raw markdown body, the single source of truth. */
  body: string;
  /** @param editable - When false (locked or placeholder), blocks render read-only. */
  editable: boolean;
  /** @param onCommitBody - Commits the rebuilt full body on block blur/Escape. */
  onCommitBody: (next: string) => void;
}

/**
 * Obsidian Live Preview-style editor: blocks render styled, and clicking
 * one turns it into a seamless inline field (no box) over its raw
 * markdown, matched to the block's typography, until blur or Escape. A
 * commit rebuilds the full body and hands it to the caller; a draft equal
 * to its original chunk commits nothing. The add-block affordance opens a
 * virtual trailing editor without writing an empty chunk to the body. A
 * body refetch while a block is open keeps the local draft and commits by
 * index into the recomputed chunk list; a cross-session mid-edit change
 * can shift indices, resolved by the conflict surface (PYZ-262).
 *
 * @param props - Body source, editability, and the commit sink.
 * @returns The block list with click-to-edit, or the read-only view.
 */
export function LiveEditor({ body, editable, onCommitBody }: LiveEditorProps) {
  const chunks = useMemo(() => splitChunks(body), [body]);
  const parsed = useMemo(() => chunks.map(parseBlocks), [chunks]);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [draft, setDraft] = useState("");

  /**
   * Enter edit mode for a block, seeding the draft from the current raw.
   *
   * @param i - Chunk index; `chunks.length` opens the virtual add slot.
   */
  function startEdit(i: number) {
    setDraft(chunks[i] ?? "");
    setEditingIdx(i);
  }

  /**
   * Commit the draft back into the body, skipping no-op edits. An empty
   * or whitespace draft removes the block.
   *
   * @param i - Chunk index being committed.
   */
  function commit(i: number) {
    setEditingIdx(null);
    if (draft === (chunks[i] ?? "")) return;
    const next = [...chunks];
    next[i] = draft;
    onCommitBody(next.filter((c) => c.trim() !== "").join("\n\n"));
  }

  if (!editable) {
    return (
      <div
        className="prose-spec"
        style={{ fontSize: 13.5, color: "var(--color-text-secondary)" }}
      >
        {parsed.map((blocks, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: stable block order
          <div key={i}>
            {blocks.map((b, bi) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: stable block order
              <BlockView key={bi} block={b} />
            ))}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div
      className="prose-spec"
      style={{ fontSize: 13.5, color: "var(--color-text-secondary)" }}
    >
      {parsed.map((blocks, i) => {
        if (editingIdx === i) {
          return (
            <BlockEditor
              // biome-ignore lint/suspicious/noArrayIndexKey: stable block order
              key={i}
              value={draft}
              heading={draft.trimStart().startsWith("## ")}
              onChange={setDraft}
              onCommit={() => commit(i)}
            />
          );
        }
        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: click-to-edit block; inner links stop propagation
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: stable block order
            key={i}
            tabIndex={0}
            onClick={() => startEdit(i)}
            onKeyDown={(e) => {
              if (e.key === "Enter") startEdit(i);
            }}
            className="block w-full cursor-text"
          >
            {blocks.map((b, bi) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: stable block order
              <BlockView key={bi} block={b} />
            ))}
          </div>
        );
      })}

      {editingIdx === chunks.length && (
        <BlockEditor
          value={draft}
          heading={draft.trimStart().startsWith("## ")}
          onChange={setDraft}
          onCommit={() => commit(chunks.length)}
        />
      )}

      <button
        type="button"
        onClick={() => startEdit(chunks.length)}
        className="mt-2 flex w-full cursor-text items-center gap-2 rounded-md py-1.5 text-left font-mono text-[11.5px] text-text-faint hover:text-text-muted"
      >
        <IconPlus size={12} />
        Add a block… <span className="text-text-muted">[[</span> links a note or
        task
      </button>
    </div>
  );
}

interface BlockEditorProps {
  /** @param value - Draft markdown for the block. */
  value: string;
  /** @param heading - Whether the block renders as a heading (drives type scale). */
  heading: boolean;
  /** @param onChange - Draft change handler. */
  onChange: (value: string) => void;
  /** @param onCommit - Commit on blur or Escape. */
  onCommit: () => void;
}

/**
 * Seamless inline block editor: a borderless textarea that wraps long
 * lines and auto-grows to fit its content, matched to the block's
 * typography.
 *
 * @param props - Draft value, heading flag, and change/commit handlers.
 * @returns The auto-growing borderless textarea.
 */
function BlockEditor({ value, heading, onChange, onCommit }: BlockEditorProps) {
  return (
    <AutoGrowTextarea
      autoFocus
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCommit();
      }}
      className="block w-full bg-transparent outline-none"
      style={{
        fontFamily: "inherit",
        border: "none",
        padding: 0,
        resize: "none",
        maxHeight: 1200,
        margin: heading ? "18px 0 6px" : "0 0 10px",
        fontSize: heading ? 15 : 13.5,
        fontWeight: heading ? 600 : 400,
        lineHeight: 1.62,
        color: heading
          ? "var(--color-text-primary)"
          : "var(--color-text-secondary)",
        caretColor: "var(--color-accent)",
      }}
    />
  );
}

interface BlockViewProps {
  /** @param block - The parsed block to render. */
  block: Block;
}

/**
 * Render one parsed markdown block with inline chips resolved. Code
 * blocks render raw text with no inline parsing, in lockstep with the
 * extractor skipping fenced content.
 *
 * @param props - The block.
 * @returns The styled block element.
 */
function BlockView({ block }: BlockViewProps) {
  if (block.kind === "h2")
    return (
      <h2
        style={{
          fontSize: 15,
          fontWeight: 600,
          color: "var(--color-text-primary)",
          margin: "18px 0 6px",
        }}
      >
        <InlineText text={block.text ?? ""} />
      </h2>
    );
  if (block.kind === "ul")
    return (
      <ul
        style={{ margin: "6px 0", paddingLeft: "1.3em", listStyleType: "disc" }}
      >
        {(block.items ?? []).map((it, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: stable item order
          <li key={i} style={{ margin: "3px 0", lineHeight: 1.6 }}>
            <InlineText text={it} />
          </li>
        ))}
      </ul>
    );
  if (block.kind === "callout")
    return (
      <blockquote
        style={{
          borderLeft: "2px solid var(--color-accent)",
          background: "var(--color-accent-grad-soft)",
          padding: "8px 12px",
          borderRadius: 6,
          margin: "10px 0",
          lineHeight: 1.6,
        }}
      >
        <InlineText text={block.text ?? ""} />
      </blockquote>
    );
  if (block.kind === "code")
    return (
      <pre
        style={{
          background: "rgba(0,0,0,0.35)",
          border: "1px solid var(--color-border)",
          borderRadius: 8,
          padding: "10px 12px",
          margin: "10px 0",
          overflowX: "auto",
        }}
      >
        <code
          className="font-mono text-[12px]"
          style={{ color: "var(--color-text-secondary)" }}
        >
          {block.text}
        </code>
      </pre>
    );
  return (
    <p style={{ margin: "0 0 10px", lineHeight: 1.62 }}>
      <InlineText text={block.text ?? ""} />
    </p>
  );
}
