"use client";

import { Fragment, useContext, useMemo, useRef, useState } from "react";
import type { FocusEvent, KeyboardEvent } from "react";
import { AutoGrowTextarea } from "@/components/shared/AutoGrowTextarea";
import { CodeBlock } from "@/components/shared/CodeBlock";
import { EditHint } from "@/components/shared/EditHint";
import { IconPlus } from "@/components/shared/icons";
import { STATUS_META } from "@/components/shared/StatusGlyph";
import { useInlineEdit } from "@/hooks/useInlineEdit";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { type Block, parseBlocks, splitChunks } from "./note-blocks";
import { NOTE_TYPE_META, tint } from "./note-meta";
import { InlineText, NoteLinkContext } from "./NoteInline";

interface LiveEditorProps {
  /** @param body - Raw markdown body, the single source of truth. */
  body: string;
  /** @param editable - When false (locked or placeholder), blocks render read-only. */
  editable: boolean;
  /** @param onCommitBody - Commits the rebuilt full body on block blur/Escape. */
  onCommitBody: (next: string) => void;
}

/** Caret seed when a block editor opens: an edge, an offset, or the end. */
type BlockCaret = "start" | "end" | number | null;

/**
 * Obsidian Live Preview-style editor: blocks render styled, and
 * double-click, Enter/Space, or the touch-only edit button turns one into
 * a seamless inline field (no box) over its raw markdown, matched to the
 * block's typography, until blur or Escape. Single click only selects
 * text; opening a block seeds the caret at the end, the inline-edit
 * convention for markdown fields. Editing flows across blocks without the
 * mouse (Notion-style): Down at a block's last line moves into the next
 * (a fresh trailing block past the end), Up at the first line moves into
 * the previous, and Backspace at the start merges into the previous. A
 * commit rebuilds the full body and hands it to the caller; a draft equal
 * to its original chunk commits nothing. The add-block affordance opens a virtual trailing editor
 * without writing an empty chunk to the body. A body refetch while a
 * block is open keeps the local draft and commits by index into the
 * recomputed chunk list; a cross-session mid-edit change can shift
 * indices, resolved by the conflict surface (PYZ-262).
 *
 * @param props - Body source, editability, and the commit sink.
 * @returns The block list with inline-edit blocks, or the read-only view.
 */
export function LiveEditor({ body, editable, onCommitBody }: LiveEditorProps) {
  const chunks = useMemo(() => splitChunks(body), [body]);
  const parsed = useMemo(() => chunks.map(parseBlocks), [chunks]);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [openCaret, setOpenCaret] = useState<BlockCaret>(null);
  const [pendingFocus, setPendingFocus] = useState<{
    index: number;
    caret: BlockCaret;
    body: string;
  } | null>(null);
  // A new block being typed at a position, before it exists in the body.
  // A truly empty block cannot be represented between two paragraphs in
  // markdown, so it lives as this transient editing state until committed.
  const [insertAt, setInsertAt] = useState<number | null>(null);
  // A cross-block move already rebuilt the body, so the departing editor's
  // unmount-blur must not re-commit its stale (pre-move) draft over it.
  const flowingRef = useRef(false);
  const coarse = useMediaQuery("(pointer: coarse)");

  // Resolve a cross-block move once its committed body has propagated back
  // through the note detail: open the target block and seed its caret. Gated
  // on `body` matching so a stale intermediate render never opens the wrong
  // index (React Query pushes the new body in a separate render).
  if (
    pendingFocus !== null &&
    editingIdx === null &&
    body === pendingFocus.body
  ) {
    setDraft(chunks[pendingFocus.index] ?? "");
    setOpenCaret(pendingFocus.caret);
    setEditingIdx(pendingFocus.index);
    setPendingFocus(null);
  }

  /**
   * Enter edit mode for a block, seeding the draft from the current raw.
   * Double-click / tap / add-block opens seed the caret at the end.
   *
   * @param i - Chunk index; `chunks.length` opens the virtual add slot.
   */
  function startEdit(i: number) {
    flowingRef.current = false;
    setInsertAt(null);
    setDraft(chunks[i] ?? "");
    setOpenCaret(null);
    setEditingIdx(i);
  }

  /**
   * Open a fresh empty block editor at an insertion position (the add-block
   * affordance and Enter-created blocks). Nothing is written until commit.
   *
   * @param at - Insertion index; `chunks.length` appends.
   * @param caret - Caret seed for the new editor.
   */
  function startInsert(at: number, caret: BlockCaret = null) {
    flowingRef.current = false;
    setEditingIdx(null);
    setDraft("");
    setOpenCaret(caret);
    setInsertAt(at);
  }

  /**
   * Commit a virtual insert block: splice its draft into the body at the
   * insertion index. An empty draft writes nothing (the block vanishes).
   *
   * @param at - Insertion index.
   */
  function commitInsert(at: number) {
    if (flowingRef.current) {
      flowingRef.current = false;
      return;
    }
    setInsertAt(null);
    if (draft.trim() === "") return;
    const next = [...chunks];
    next.splice(at, 0, draft);
    onCommitBody(next.filter((c) => c.trim() !== "").join("\n\n"));
  }

  /**
   * Split block `i` at the caret into a new block (Enter). Content after
   * the caret becomes the next block; an empty tail opens a fresh virtual
   * block so continuous typing keeps producing separate, individually
   * editable blocks.
   *
   * @param i - Source chunk index.
   * @param before - Text up to the caret (stays in block `i`).
   * @param after - Text from the caret (becomes the next block).
   */
  function splitBlock(i: number, before: string, after: string) {
    if (after.trim() === "") {
      if (before !== (chunks[i] ?? "")) {
        const next = [...chunks];
        next[i] = before;
        onCommitBody(next.filter((c) => c.trim() !== "").join("\n\n"));
      }
      if (i + 1 >= chunks.length) startEdit(chunks.length);
      else startInsert(i + 1, "start");
      // Set after startEdit/startInsert (which clear it): suppress the
      // departing block's unmount-blur so it does not commit the reset
      // (empty) draft over block `i`.
      flowingRef.current = true;
      return;
    }
    flowingRef.current = true;
    const next = [...chunks];
    next[i] = before;
    next.splice(i + 1, 0, after);
    const nextBody = next.filter((c) => c.trim() !== "").join("\n\n");
    const target = i + splitChunks(before).length;
    setEditingIdx(null);
    setInsertAt(null);
    setPendingFocus({ index: target, caret: "start", body: nextBody });
    if (nextBody !== body) onCommitBody(nextBody);
  }

  /**
   * Commit the draft back into the body, skipping no-op edits. An empty
   * or whitespace draft removes the block.
   *
   * @param i - Chunk index being committed.
   */
  function commit(i: number) {
    if (flowingRef.current) {
      flowingRef.current = false;
      return;
    }
    setEditingIdx(null);
    if (draft === (chunks[i] ?? "")) return;
    const next = [...chunks];
    next[i] = draft;
    onCommitBody(next.filter((c) => c.trim() !== "").join("\n\n"));
  }

  /**
   * Commit the current block and move the caret into an adjacent one
   * (Notion-style keyboard flow). `chunks[0..i-1]` are each one chunk, so
   * the next block lands at `i + splitChunks(draft).length` and the
   * previous at `i - 1`; committing `chunks.length` as the down target
   * opens a fresh trailing block.
   *
   * @param i - Source chunk index.
   * @param direction - `"down"` to the next block, `"up"` to the previous.
   */
  function flow(i: number, direction: "up" | "down") {
    if (direction === "up" && i === 0) return;
    flowingRef.current = true;
    const next = [...chunks];
    next[i] = draft;
    const nextBody = next.filter((c) => c.trim() !== "").join("\n\n");
    const index = direction === "down" ? i + splitChunks(draft).length : i - 1;
    setEditingIdx(null);
    setPendingFocus({
      index,
      caret: direction === "down" ? "start" : "end",
      body: nextBody,
    });
    if (nextBody !== body) onCommitBody(nextBody);
  }

  /**
   * Merge the current block into the previous one (Backspace at block
   * start), placing the caret at the join. An empty block is just dropped.
   *
   * @param i - Chunk index being merged upward.
   */
  function mergeUp(i: number) {
    if (i === 0) return;
    flowingRef.current = true;
    const prev = chunks[i - 1] ?? "";
    const merged = draft.trim() === "" ? prev : `${prev}\n${draft}`;
    const next = [...chunks];
    next[i - 1] = merged;
    next.splice(i, 1);
    const nextBody = next.filter((c) => c.trim() !== "").join("\n\n");
    setEditingIdx(null);
    setPendingFocus({ index: i - 1, caret: prev.length, body: nextBody });
    if (nextBody !== body) onCommitBody(nextBody);
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
      {parsed.map((blocks, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: stable block order
        <Fragment key={i}>
          {insertAt === i && (
            <BlockEditor
              value={draft}
              heading={draft.trimStart().startsWith("## ")}
              openCaret={openCaret}
              onChange={setDraft}
              onCommit={() => commitInsert(i)}
            />
          )}
          <EditableBlock
            blocks={blocks}
            editing={editingIdx === i}
            draft={draft}
            coarse={coarse}
            openCaret={editingIdx === i ? openCaret : null}
            onDraftChange={setDraft}
            onStartEdit={() => startEdit(i)}
            onCommit={() => commit(i)}
            onLeaveUp={() => flow(i, "up")}
            onLeaveDown={() => flow(i, "down")}
            onMergeUp={() => mergeUp(i)}
            onNewBlock={(before, after) => splitBlock(i, before, after)}
          />
        </Fragment>
      ))}

      {editingIdx === chunks.length && (
        <BlockEditor
          value={draft}
          heading={draft.trimStart().startsWith("## ")}
          openCaret={openCaret}
          onChange={setDraft}
          onCommit={() => commit(chunks.length)}
          onLeaveUp={() => flow(chunks.length, "up")}
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

interface EditableBlockProps {
  /** @param blocks - Parsed blocks of this chunk for the display state. */
  blocks: Block[];
  /** @param editing - Whether this chunk currently owns the inline editor. */
  editing: boolean;
  /** @param draft - Shared draft value, meaningful only while editing. */
  draft: string;
  /** @param coarse - Whether the pointer is coarse (touch): tap-to-edit. */
  coarse: boolean;
  /** @param openCaret - Caret seed when this block opens, or null for the end. */
  openCaret: BlockCaret;
  /** @param onDraftChange - Draft change handler. */
  onDraftChange: (value: string) => void;
  /** @param onStartEdit - Enters edit mode for this chunk. */
  onStartEdit: () => void;
  /** @param onCommit - Commits the draft on blur or Escape. */
  onCommit: () => void;
  /** @param onLeaveUp - Cross into the previous block (Up at first line). */
  onLeaveUp: () => void;
  /** @param onLeaveDown - Cross into the next block (Down at last line). */
  onLeaveDown: () => void;
  /** @param onMergeUp - Merge into the previous block (Backspace at start). */
  onMergeUp: () => void;
  /** @param onNewBlock - Split into a new block at the caret (Enter). */
  onNewBlock: (before: string, after: string) => void;
}

/**
 * One editable chunk: the styled display with the shared inline-edit
 * trigger, swapped for the seamless block editor while editing. Fine
 * pointers open on double-click (with a hover hint); coarse pointers open
 * on a single tap, so there is no per-block pencil, and a tap on an inline
 * chip or link still navigates instead of editing. The block renders
 * rendered markdown, not the raw source, so the editor opens with the
 * caret at the end per the inline-edit convention for markdown fields.
 *
 * @param props - Chunk display data and edit-lifecycle wiring.
 * @returns The display block or its inline editor.
 */
function EditableBlock({
  blocks,
  editing,
  draft,
  coarse,
  openCaret,
  onDraftChange,
  onStartEdit,
  onCommit,
  onLeaveUp,
  onLeaveDown,
  onMergeUp,
  onNewBlock,
}: EditableBlockProps) {
  const edit = useInlineEdit(onStartEdit);
  if (editing) {
    return (
      <BlockEditor
        value={draft}
        heading={draft.trimStart().startsWith("## ")}
        openCaret={openCaret}
        onChange={onDraftChange}
        onCommit={onCommit}
        onFocus={edit.onEditorFocus}
        onLeaveUp={onLeaveUp}
        onLeaveDown={onLeaveDown}
        onMergeUp={onMergeUp}
        onNewBlock={onNewBlock}
      />
    );
  }
  return (
    <div className="group/edit relative">
      {!coarse && <EditHint />}
      <div
        {...edit.triggerProps}
        onClick={
          coarse
            ? (e) => {
                if ((e.target as HTMLElement).closest("a, button")) return;
                onStartEdit();
              }
            : undefined
        }
        className="block w-full cursor-text select-text rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
      >
        {blocks.map((b, bi) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: stable block order
          <BlockView key={bi} block={b} />
        ))}
      </div>
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
  /** @param onFocus - Caret placement on the autofocus, from `useInlineEdit`. */
  onFocus?: (event: FocusEvent<HTMLTextAreaElement>) => void;
  /** @param openCaret - Explicit caret seed on open; overrides `onFocus`. */
  openCaret?: BlockCaret;
  /** @param onLeaveUp - Up pressed at the first line (cross to previous). */
  onLeaveUp?: () => void;
  /** @param onLeaveDown - Down pressed at the last line (cross to next). */
  onLeaveDown?: () => void;
  /** @param onMergeUp - Backspace at offset 0 (merge into previous). */
  onMergeUp?: () => void;
  /** @param onNewBlock - Enter in a plain block: split at the caret. */
  onNewBlock?: (before: string, after: string) => void;
}

/** Max `[[` autocomplete suggestions rendered at once. */
const WIKI_SUGGESTION_CAP = 8;

/** One `[[` link-picker suggestion (a note or a task). */
type LinkSuggestion = {
  id: string;
  title: string;
  insert: string;
  color: string;
  hint: string;
};

/**
 * Active `[[wiki` query at the caret: the text after the nearest unclosed
 * `[[` on the current line, or `null` when the caret is not inside one.
 *
 * @param value - Full textarea value.
 * @param caret - Caret offset.
 * @returns The partial title query, or `null`.
 */
function wikiQuery(value: string, caret: number): string | null {
  const before = value.slice(0, caret);
  const open = before.lastIndexOf("[[");
  if (open === -1) return null;
  const between = before.slice(open + 2);
  if (
    between.includes("]]") ||
    between.includes("[[") ||
    between.includes("\n")
  ) {
    return null;
  }
  return between;
}

/**
 * Seamless inline block editor: a borderless textarea that wraps long
 * lines and auto-grows to fit its content, matched to the block's
 * typography. Typing `[[` opens a note-and-task picker resolved from data
 * already loaded in the workspace (the note tree list and project task
 * map); Arrow keys move, Enter/Tab inserts the pick (a note's `[[Title]]`
 * or a task's ref), Escape dismisses the popover (a second Escape commits
 * the block).
 *
 * @param props - Draft value, heading flag, and change/commit/focus handlers.
 * @returns The auto-growing borderless textarea with the `[[` popover.
 */
function BlockEditor({
  value,
  heading,
  onChange,
  onCommit,
  onFocus,
  openCaret,
  onLeaveUp,
  onLeaveDown,
  onMergeUp,
  onNewBlock,
}: BlockEditorProps) {
  const ctx = useContext(NoteLinkContext);
  const containerRef = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const [flipUp, setFlipUp] = useState(false);

  const query = ctx === null ? null : wikiQuery(value, caret);

  const matches = useMemo<LinkSuggestion[]>(() => {
    if (ctx === null || query === null || dismissed) return [];
    const q = query.trim().toLowerCase();
    const hit = (title: string) => q === "" || title.toLowerCase().includes(q);
    const out: LinkSuggestion[] = [];
    for (const note of ctx.notesByTitle.values()) {
      if (out.length >= WIKI_SUGGESTION_CAP) break;
      if (hit(note.title)) {
        out.push({
          id: `note-${note.id}`,
          title: note.title,
          insert: `[[${note.title}]]`,
          color: NOTE_TYPE_META[note.type].color,
          hint: NOTE_TYPE_META[note.type].label,
        });
      }
    }
    for (const [seq, task] of ctx.tasksBySeq) {
      if (out.length >= WIKI_SUGGESTION_CAP) break;
      if (hit(task.title)) {
        out.push({
          id: `task-${task.taskId}`,
          title: task.title,
          insert: `${ctx.identifier}-${seq}`,
          color: STATUS_META[task.status].cssVar,
          hint: `${ctx.identifier}-${seq}`,
        });
      }
    }
    return out;
  }, [ctx, query, dismissed]);
  const open = matches.length > 0;

  const [prevQuery, setPrevQuery] = useState(query);
  if (query !== prevQuery) {
    setPrevQuery(query);
    setActive(0);
    setDismissed(false);
  }

  /**
   * Replace the active `[[query` with a picked suggestion's link text (a
   * note's `[[Title]]` or a task's ref), then re-place the caret after it.
   *
   * @param text - The suggestion's insertion text.
   */
  function insert(text: string) {
    const openIdx = value.slice(0, caret).lastIndexOf("[[");
    if (openIdx === -1) return;
    const next = `${value.slice(0, openIdx)}${text}${value.slice(caret)}`;
    const pos = openIdx + text.length;
    onChange(next);
    setDismissed(true);
    const textarea = containerRef.current?.querySelector("textarea");
    if (textarea) {
      requestAnimationFrame(() => {
        textarea.focus();
        textarea.setSelectionRange(pos, pos);
        setCaret(pos);
      });
    }
  }

  /**
   * Track the caret offset from a textarea event.
   *
   * @param event - Any textarea event carrying the current selection.
   */
  function syncCaret(event: { currentTarget: HTMLTextAreaElement }) {
    const el = event.currentTarget;
    setCaret(el.selectionStart ?? 0);
    const rect = el.getBoundingClientRect();
    setFlipUp(rect.bottom + 240 > window.innerHeight);
  }

  /**
   * Route key presses to the popover when open, else to the block commit.
   *
   * @param event - Keydown event.
   */
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (open) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((a) => (a + 1) % matches.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((a) => (a - 1 + matches.length) % matches.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        insert(matches[active].insert);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissed(true);
        return;
      }
    }
    if (event.key === "Escape") {
      onCommit();
      return;
    }
    const el = event.currentTarget;
    const pos = el.selectionStart ?? 0;
    if (event.key === "Enter" && !event.shiftKey && onNewBlock !== undefined) {
      const raw = el.value;
      const inFence =
        raw.trimStart().startsWith("```") || raw.trimStart().startsWith("~~~");
      const lineStart = raw.lastIndexOf("\n", pos - 1) + 1;
      const structuredLine = /^\s*(?:[-*]\s|>\s)/.test(raw.slice(lineStart));
      if (!inFence && !structuredLine) {
        event.preventDefault();
        onNewBlock(raw.slice(0, pos), raw.slice(pos));
        return;
      }
    }
    if (
      event.key === "ArrowUp" &&
      onLeaveUp !== undefined &&
      !el.value.slice(0, pos).includes("\n")
    ) {
      event.preventDefault();
      onLeaveUp();
      return;
    }
    if (
      event.key === "ArrowDown" &&
      onLeaveDown !== undefined &&
      !el.value.slice(pos).includes("\n")
    ) {
      event.preventDefault();
      onLeaveDown();
      return;
    }
    if (
      event.key === "Backspace" &&
      onMergeUp !== undefined &&
      pos === 0 &&
      el.selectionEnd === 0
    ) {
      event.preventDefault();
      onMergeUp();
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <AutoGrowTextarea
        autoFocus
        value={value}
        onFocus={(e) => {
          if (openCaret !== undefined && openCaret !== null) {
            const len = e.currentTarget.value.length;
            const p =
              openCaret === "start"
                ? 0
                : openCaret === "end"
                  ? len
                  : Math.min(openCaret, len);
            e.currentTarget.setSelectionRange(p, p);
          } else {
            onFocus?.(e);
          }
          syncCaret(e);
        }}
        onChange={(e) => {
          onChange(e.target.value);
          syncCaret(e);
        }}
        onClick={syncCaret}
        onKeyUp={syncCaret}
        onBlur={onCommit}
        onKeyDown={onKeyDown}
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
      {open && (
        <WikiSuggestions
          matches={matches}
          active={active}
          flipUp={flipUp}
          onPick={(text) => insert(text)}
        />
      )}
    </div>
  );
}

interface WikiSuggestionsProps {
  /** @param matches - Note and task suggestions matching the active query. */
  matches: LinkSuggestion[];
  /** @param active - Index of the highlighted match. */
  active: number;
  /** @param flipUp - Render above the caret instead of below (near page end). */
  flipUp: boolean;
  /** @param onPick - Insert the picked suggestion's link text. */
  onPick: (text: string) => void;
}

/**
 * Dropdown of note and task suggestions for an open `[[` query, resolved
 * from data already loaded in the workspace (the note tree list and the
 * project task map) so it adds no fetch. Picks fire on `mousedown` with
 * `preventDefault` so the textarea keeps focus and the block never commits
 * mid-pick.
 *
 * @param props - Matches, highlighted index, and pick handler.
 * @returns The suggestion popover.
 */
function WikiSuggestions({
  matches,
  active,
  flipUp,
  onPick,
}: WikiSuggestionsProps) {
  return (
    <div
      className={`absolute left-0 z-20 max-h-56 w-64 overflow-y-auto rounded-md border border-border py-1 shadow-[var(--shadow-float)] ${
        flipUp ? "bottom-full mb-1" : "top-full mt-1"
      }`}
      style={{ background: "var(--color-surface)" }}
    >
      {matches.map((match, i) => (
        <button
          key={match.id}
          type="button"
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(match.insert);
          }}
          className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1 text-left text-[12.5px]"
          style={{
            background: i === active ? tint(match.color, 10) : "transparent",
            color: "var(--color-text-secondary)",
          }}
        >
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: match.color }}
          />
          <span className="min-w-0 flex-1 truncate">{match.title}</span>
          <span className="shrink-0 font-mono text-[9.5px] uppercase tracking-wide text-text-faint">
            {match.hint}
          </span>
        </button>
      ))}
    </div>
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
    return <CodeBlock code={block.text ?? ""} lang={block.lang} />;
  return (
    <p style={{ margin: "0 0 10px", lineHeight: 1.62 }}>
      <InlineText text={block.text ?? ""} />
    </p>
  );
}
