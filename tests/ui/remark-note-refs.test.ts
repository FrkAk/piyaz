import { test, expect } from "bun:test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { visit } from "unist-util-visit";
import { remarkNoteRefs } from "@/components/workspace/notes/remark-note-refs";

/**
 * Parse markdown, run the plugin, and collect the tagged ref nodes.
 *
 * @param md - Markdown source.
 * @returns The ordered `{ name, props }` of tagged ref nodes.
 */
function refsIn(md: string) {
  const tree = unified().use(remarkParse).parse(md);
  remarkNoteRefs({ identifier: "RSC" })(tree);
  const out: { name: string; props: Record<string, unknown> }[] = [];
  visit(tree, (n: unknown) => {
    const data = (n as { data?: { hName?: string; hProperties?: object } }).data;
    if (data?.hName === "noteref-task" || data?.hName === "noteref-wiki")
      out.push({
        name: data.hName,
        props: data.hProperties as Record<string, unknown>,
      });
  });
  return out;
}

test("tags task refs and wiki links", () => {
  expect(refsIn("see RSC-3 and [[My Note]]")).toEqual([
    { name: "noteref-task", props: { seq: 3 } },
    { name: "noteref-wiki", props: { title: "My Note" } },
  ]);
});

test("does not tag refs inside inline code", () => {
  expect(refsIn("`RSC-3` literal")).toEqual([]);
});

test("ignores a foreign-project ref", () => {
  expect(refsIn("XXX-9 here")).toEqual([]);
});

test("a blank wiki title degrades to text", () => {
  expect(refsIn("empty [[   ]] link")).toEqual([]);
});
