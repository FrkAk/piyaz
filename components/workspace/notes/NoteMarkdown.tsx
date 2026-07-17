"use client";

import { memo } from "react";
import type { Root } from "mdast";
import { defaultSchema } from "rehype-sanitize";
import { Markdown } from "@/components/shared/Markdown";
import { remarkNoteRefs } from "./remark-note-refs";
import { DocLink, NoteRefLink, TaskChip } from "./NoteInline";

/**
 * Tag each top-level block with its source line so a double-click enters
 * edit at the clicked block. Best-effort placement; the editor falls back
 * to the note start when absent.
 *
 * @returns A unified transformer setting `data-src-line` on root children.
 */
function remarkSrcLine() {
  return (tree: Root) => {
    for (const node of tree.children) {
      const line = node.position?.start.line;
      if (line === undefined) continue;
      const data = (node.data ??= {});
      const props = (data.hProperties ??= {}) as Record<string, unknown>;
      props["data-src-line"] = line;
    }
  };
}

/** Sanitize schema that also permits the tagged ref elements + src line. */
export const noteSchema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    "noteref-task",
    "noteref-note",
    "noteref-wiki",
  ],
  attributes: {
    ...defaultSchema.attributes,
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "data-src-line"],
    "noteref-task": ["seq"],
    "noteref-note": ["seq"],
    "noteref-wiki": ["title"],
  },
};

/** Map the tagged ref elements to the note chip/link components. */
const components = {
  "noteref-task": ({ seq }: { seq?: string | number }) => (
    <TaskChip seq={Number(seq)} />
  ),
  "noteref-note": ({ seq }: { seq?: string | number }) => (
    <NoteRefLink seq={Number(seq)} />
  ),
  "noteref-wiki": ({ title }: { title?: string }) => (
    <DocLink title={String(title ?? "")} />
  ),
};

interface NoteMarkdownProps {
  /** @param body - Raw markdown note body. */
  body: string;
  /** @param identifier - Owning project identifier for inline task refs. */
  identifier: string;
}

/**
 * Full-markdown renderer for a note body: the shared {@link Markdown}
 * component plus clickable task-ref chips and `[[wiki]]` links. Resolution
 * and navigation come from the `NoteLinkContext` the caller provides.
 * Memoized on its two string props: markdown parses in render, so without
 * the memo every parent re-render (each title keystroke) re-parses the
 * whole body.
 *
 * @param props - Note body and owning project identifier.
 * @returns The rendered note.
 */
export const NoteMarkdown = memo(function NoteMarkdown({
  body,
  identifier,
}: NoteMarkdownProps) {
  return (
    <Markdown
      className="note-md text-[13.5px] text-text-secondary"
      remarkPlugins={[[remarkNoteRefs, { identifier }], remarkSrcLine]}
      sanitizeSchema={noteSchema}
      components={components as never}
    >
      {body}
    </Markdown>
  );
});

export default NoteMarkdown;
