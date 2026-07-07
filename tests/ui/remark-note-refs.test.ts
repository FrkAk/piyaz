import { test, expect } from "bun:test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { visit } from "unist-util-visit";
import { remarkNoteRefs } from "@/components/workspace/notes/remark-note-refs";
import { extractNoteRefs } from "@/lib/data/note-parse";

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
    const data = (n as { data?: { hName?: string; hProperties?: object } })
      .data;
    if (data?.hName === "noteref-task" || data?.hName === "noteref-wiki")
      out.push({
        name: data.hName,
        props: data.hProperties as Record<string, unknown>,
      });
  });
  return out;
}

test("tags task refs and wiki links", () => {
  expect(refsIn("see [[RSC-3]] and [[My Note]]")).toEqual([
    { name: "noteref-task", props: { seq: 3 } },
    { name: "noteref-wiki", props: { title: "My Note" } },
  ]);
});

test("does not tag refs inside inline code", () => {
  expect(refsIn("`[[RSC-3]]` literal")).toEqual([]);
});

test("treats a foreign-project ref as a note title", () => {
  expect(refsIn("[[XXX-9]] here")).toEqual([
    { name: "noteref-wiki", props: { title: "XXX-9" } },
  ]);
});

test("a blank wiki title degrades to text", () => {
  expect(refsIn("empty [[   ]] link")).toEqual([]);
});

test("drops an out-of-range task seq to text", () => {
  expect(refsIn("bad [[RSC-0]] ref")).toEqual([]);
});

test("tags refs inside bold runs", () => {
  expect(refsIn("**bold [[RSC-3]] [[X]]** tail")).toEqual([
    { name: "noteref-task", props: { seq: 3 } },
    { name: "noteref-wiki", props: { title: "X" } },
  ]);
});

/**
 * Collect the refs the renderer surfaces (GFM parse + plugin), deduped like
 * the extractor: distinct seqs, case-insensitively distinct titles.
 *
 * @param md - Markdown source.
 * @returns Sorted seqs and titles.
 */
function rendererRefs(md: string) {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(md);
  remarkNoteRefs({ identifier: "RSC" })(tree);
  const seqs = new Set<number>();
  const seenTitle = new Set<string>();
  const titles: string[] = [];
  visit(tree, (n: unknown) => {
    const data = (n as { data?: { hName?: string; hProperties?: object } })
      .data;
    const props = data?.hProperties as Record<string, unknown> | undefined;
    if (data?.hName === "noteref-task") seqs.add(Number(props?.seq));
    if (data?.hName === "noteref-wiki") {
      const title = String(props?.title);
      const key = title.toLowerCase();
      if (seenTitle.has(key)) return;
      seenTitle.add(key);
      titles.push(title);
    }
  });
  return { taskSeqs: [...seqs], titles };
}

const lockstepCorpus = [
  "plain [[RSC-1]] and [[One]]",
  "bold **[[RSC-2]] [[Two]]** then [[RSC-3]]",
  "italic *[[RSC-4]]* stays a ref",
  "strike ~~[[RSC-5]]~~ stays a ref",
  "inline `[[RSC-6]] [[Hidden]]` skipped",
  "link [text](https://x.com) and [[RSC-7]]",
  "```\n[[RSC-8]] [[Fenced]]\n```\nafter [[RSC-9]]",
  "dupes [[Same]] [[same]] [[RSC-10]] [[RSC-10]]",
  "foreign [[XXX-9]] and blank [[   ]]",
  "case [[rsc-11]] and out-of-range [[RSC-0]]",
];

test.each(lockstepCorpus)("renderer refs match extractNoteRefs: %s", (md) => {
  const rendered = rendererRefs(md);
  const extracted = extractNoteRefs(md, "RSC");
  expect(rendered.taskSeqs.toSorted((a, b) => a - b)).toEqual(
    extracted.taskSeqs.toSorted((a, b) => a - b),
  );
  expect(rendered.titles.toSorted()).toEqual(extracted.titles.toSorted());
});
