import { SKIP, visitParents } from "unist-util-visit-parents";
import type { Parent, Root, Text } from "mdast";
import { escapeRegExp } from "@/lib/data/note-parse";

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
 * Remark transformer that tags task refs (`RSC-3`) and `[[wiki]]` links in
 * plain-text nodes so the rehype renderer maps them to chips/links. Only
 * `text` nodes are visited (so refs inside inline or fenced code are left
 * literal) and refs inside a `strong` ancestor are skipped, keeping the
 * rendered chips in lockstep with the server link extractor, which excludes
 * inline code and bold runs.
 *
 * @param options - The owning project identifier.
 * @returns A unified transformer over the mdast tree.
 */
export function remarkNoteRefs(options: NoteRefsOptions) {
  const id = escapeRegExp(options.identifier);
  const re = new RegExp(`\\b${id}-(\\d+)\\b|\\[\\[([^\\]]+)\\]\\]`, "g");
  return (tree: Root) => {
    visitParents(tree, "text", (node, ancestors) => {
      const parent = ancestors[ancestors.length - 1] as Parent | undefined;
      if (parent === undefined) return;
      if (ancestors.some((a) => a.type === "strong")) return;
      const index = parent.children.indexOf(node);
      if (index === -1) return;
      const value = node.value;
      re.lastIndex = 0;
      const out: (Text | TaggedText)[] = [];
      let cursor = 0;
      for (let m = re.exec(value); m !== null; m = re.exec(value)) {
        if (m.index > cursor)
          out.push({ type: "text", value: value.slice(cursor, m.index) });
        if (m[1] !== undefined) {
          out.push({
            type: "text",
            value: "",
            data: {
              hName: "noteref-task",
              hProperties: { seq: Number(m[1]) },
            },
          });
        } else {
          const title = (m[2] ?? "").trim();
          if (title === "") {
            out.push({ type: "text", value: m[0] });
          } else {
            out.push({
              type: "text",
              value: "",
              data: { hName: "noteref-wiki", hProperties: { title } },
            });
          }
        }
        cursor = m.index + m[0].length;
      }
      if (out.length === 0) return;
      if (cursor < value.length)
        out.push({ type: "text", value: value.slice(cursor) });
      parent.children.splice(index, 1, ...out);
      return [SKIP, index + out.length];
    });
  };
}
