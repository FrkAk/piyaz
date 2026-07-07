"use client";

import type { ReactNode } from "react";
import { defaultSchema } from "rehype-sanitize";
import { Markdown } from "@/components/shared/Markdown";
import { remarkNoteRefs } from "./remark-note-refs";
import { DocLink, TaskChip } from "./NoteInline";

/** Sanitize schema that also permits the tagged ref elements. */
const noteSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "noteref-task", "noteref-wiki"],
  attributes: {
    ...defaultSchema.attributes,
    "noteref-task": ["seq"],
    "noteref-wiki": ["title"],
  },
};

/** Map the tagged ref elements to the note chip/link components. */
const components = {
  "noteref-task": ({ seq }: { seq?: string | number }) => (
    <TaskChip seq={Number(seq)} />
  ),
  "noteref-wiki": ({ title }: { title?: string }) => (
    <DocLink title={String(title ?? "")} />
  ),
  blockquote: ({ children }: { children?: ReactNode }) => (
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
      {children}
    </blockquote>
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
 *
 * @param props - Note body and owning project identifier.
 * @returns The rendered note.
 */
export function NoteMarkdown({ body, identifier }: NoteMarkdownProps) {
  return (
    <Markdown
      className="text-[13.5px] text-text-secondary"
      remarkPlugins={[[remarkNoteRefs, { identifier }]]}
      sanitizeSchema={noteSchema}
      components={components as never}
    >
      {body}
    </Markdown>
  );
}

export default NoteMarkdown;
