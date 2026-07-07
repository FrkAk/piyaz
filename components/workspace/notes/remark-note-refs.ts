import { visit } from "unist-util-visit";
import type { Root, Text } from "mdast";
import { buildRefRe, buildTaskRefRe, classifyRef } from "@/lib/data/note-parse";

/** Options for {@link remarkNoteRefs}. */
interface NoteRefsOptions {
  /** Owning project identifier, e.g. `RSC`. */
  identifier: string;
}

/** An mdast text node carrying a rehype element hint. */
type TaggedText = Text & {
  data?: { hName: string; hProperties: Record<string, unknown> };
};

/**
 * Remark transformer that tags `[[…]]` refs in plain-text nodes so the
 * rehype renderer maps them to task chips (`[[RSC-3]]`) or note links
 * (`[[Title]]`). Only `text` nodes are visited, so refs inside inline or
 * fenced code are left literal; classification and validation come from
 * the shared {@link classifyRef}, keeping the render in lockstep with the
 * server link extractor. Refs inside bold runs are tagged (and
 * backlinked), so a reference always reads as one.
 *
 * @param options - The owning project identifier.
 * @returns A unified transformer over the mdast tree.
 */
export function remarkNoteRefs(options: NoteRefsOptions) {
  const refRe = buildRefRe();
  const taskRe = buildTaskRefRe(options.identifier);
  return (tree: Root) => {
    visit(tree, "text", (node, index, parent) => {
      if (parent === undefined || index === undefined) return;
      const value = node.value;
      refRe.lastIndex = 0;
      const out: (Text | TaggedText)[] = [];
      let cursor = 0;
      for (let m = refRe.exec(value); m !== null; m = refRe.exec(value)) {
        const ref = classifyRef(m[1], taskRe);
        if (ref === null) continue;
        if (m.index > cursor)
          out.push({ type: "text", value: value.slice(cursor, m.index) });
        out.push(
          ref.kind === "task"
            ? {
                type: "text",
                value: "",
                data: { hName: "noteref-task", hProperties: { seq: ref.seq } },
              }
            : {
                type: "text",
                value: "",
                data: {
                  hName: "noteref-wiki",
                  hProperties: { title: ref.title },
                },
              },
        );
        cursor = m.index + m[0].length;
      }
      if (out.length === 0) return;
      if (cursor < value.length)
        out.push({ type: "text", value: value.slice(cursor) });
      parent.children.splice(index, 1, ...out);
      return index + out.length;
    });
  };
}
