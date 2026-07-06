import { describe, expect, test } from "bun:test";
import {
  type Block,
  type InlineToken,
  parseBlocks,
  splitChunks,
  tokenizeInline,
} from "@/components/workspace/notes/note-blocks";
import { extractNoteRefs } from "@/lib/data/note-parse";

describe("splitChunks", () => {
  test("splits on blank-line runs", () => {
    expect(splitChunks("a\n\nb\n\n\nc")).toEqual(["a", "b", "c"]);
  });

  test("keeps single newlines inside one chunk", () => {
    expect(splitChunks("## H\nbody")).toEqual(["## H\nbody"]);
  });

  test("returns no chunks for an empty body", () => {
    expect(splitChunks("")).toEqual([]);
    expect(splitChunks("\n\n\n")).toEqual([]);
  });

  test("blank lines inside a backtick fence stay one chunk", () => {
    const body = "```\nfirst\n\nsecond\n```\n\nafter";
    expect(splitChunks(body)).toEqual(["```\nfirst\n\nsecond\n```", "after"]);
  });

  test("blank lines inside a tilde fence stay one chunk", () => {
    const body = "~~~\nfirst\n\nsecond\n~~~";
    expect(splitChunks(body)).toEqual([body]);
  });

  test("a 4-backtick opener ignores a 3-backtick closer", () => {
    const body = "````\ncode\n```\n\nstill code\n````\n\nafter";
    expect(splitChunks(body)).toEqual([
      "````\ncode\n```\n\nstill code\n````",
      "after",
    ]);
  });

  test("a backtick info string containing a backtick is not an opener", () => {
    const body = "``` a`b\n\nplain";
    expect(splitChunks(body)).toEqual(["``` a`b", "plain"]);
  });

  test("an unterminated fence swallows the rest of the body", () => {
    const body = "before\n\n```\ncode\n\nmore";
    expect(splitChunks(body)).toEqual(["before", "```\ncode\n\nmore"]);
  });
});

describe("parseBlocks", () => {
  test("parses h2, callout, ul, and p kinds keeping line boundaries", () => {
    const blocks = parseBlocks(
      "## Title\n> quoted\n> more\n- one\n- two\npara line\nsecond line",
    );
    expect(blocks).toEqual([
      { kind: "h2", text: "Title" },
      { kind: "callout", text: "quoted\nmore" },
      { kind: "ul", items: ["one", "two"] },
      { kind: "p", text: "para line\nsecond line" },
    ] satisfies Block[]);
  });

  test("parses a fenced code block with blank lines as one block", () => {
    const blocks = parseBlocks("```ts\nconst a = 1;\n\nconst b = 2;\n```");
    expect(blocks).toEqual([
      { kind: "code", text: "const a = 1;\n\nconst b = 2;", lang: "ts" },
    ]);
  });

  test("an unterminated fence swallows the rest of the chunk", () => {
    const blocks = parseBlocks("intro\n```\ncode\nmore");
    expect(blocks).toEqual([
      { kind: "p", text: "intro" },
      { kind: "code", text: "code\nmore" },
    ]);
  });

  test("closes a tilde fence only on a length-matched same-char run", () => {
    const blocks = parseBlocks("~~~~\ncode\n~~~\n~~~~");
    expect(blocks).toEqual([{ kind: "code", text: "code\n~~~" }]);
  });
});

describe("tokenizeInline", () => {
  const taskTokens = (tokens: InlineToken[]) =>
    tokens.flatMap((t) => (t.kind === "task" ? [t.seq] : []));
  const wikiTokens = (tokens: InlineToken[]) =>
    tokens.flatMap((t) => (t.kind === "wiki" ? [t.title] : []));

  test("emits task and wiki tokens with surrounding text", () => {
    const tokens = tokenizeInline("see PYZ-12 and [[Auth Notes]].", "PYZ");
    expect(tokens).toEqual([
      { kind: "text", text: "see " },
      { kind: "task", text: "PYZ-12", seq: 12 },
      { kind: "text", text: " and " },
      { kind: "wiki", text: "[[Auth Notes]]", title: "Auth Notes" },
      { kind: "text", text: "." },
    ]);
  });

  test("refs inside code spans and bold runs stay consumed", () => {
    const tokens = tokenizeInline("`PYZ-1` and **PYZ-2 [[X]]**", "PYZ");
    expect(taskTokens(tokens)).toEqual([]);
    expect(wikiTokens(tokens)).toEqual([]);
    expect(tokens).toEqual([
      { kind: "code", text: "PYZ-1" },
      { kind: "text", text: " and " },
      { kind: "bold", text: "PYZ-2 [[X]]" },
    ]);
  });

  test("matches lowercase refs case-insensitively", () => {
    const tokens = tokenizeInline("fix pyz-12 now", "PYZ");
    expect(tokens).toContainEqual({ kind: "task", text: "pyz-12", seq: 12 });
  });

  test("escapes regex metacharacters in the identifier", () => {
    const tokens = tokenizeInline("A+B-7 hit, AxB-7 miss", "A+B");
    expect(taskTokens(tokens)).toEqual([7]);
  });

  test("a blank wiki title degrades to text", () => {
    const tokens = tokenizeInline("[[   ]] stays", "PYZ");
    expect(tokens).toEqual([{ kind: "text", text: "[[   ]] stays" }]);
  });

  test("an out-of-range sequence degrades to text", () => {
    const tokens = tokenizeInline("PYZ-99999999999999999999", "PYZ");
    expect(taskTokens(tokens)).toEqual([]);
    expect(tokens).toEqual([
      { kind: "text", text: "PYZ-99999999999999999999" },
    ]);
  });

  test("joins multi-line text with a single space text token", () => {
    const tokens = tokenizeInline("para line\nsecond line", "PYZ");
    expect(tokens).toEqual([{ kind: "text", text: "para line second line" }]);
  });

  test("spans never pair across a line boundary", () => {
    const tokens = tokenizeInline("a `x` b `y\nz` PYZ-2 `w`", "PYZ");
    expect(taskTokens(tokens)).toEqual([]);
    expect(tokens).toEqual([
      { kind: "text", text: "a " },
      { kind: "code", text: "x" },
      { kind: "text", text: " b `y z" },
      { kind: "code", text: " PYZ-2 " },
      { kind: "text", text: "w`" },
    ]);
  });

  test("a ref after an unbalanced backtick line stays a task token", () => {
    const tokens = tokenizeInline("`code\nPYZ-1` after", "PYZ");
    expect(taskTokens(tokens)).toEqual([1]);
  });

  test("a ref after an unbalanced bold line stays a task token", () => {
    const tokens = tokenizeInline("**bold\nPYZ-3** [[T]]", "PYZ");
    expect(taskTokens(tokens)).toEqual([3]);
    expect(wikiTokens(tokens)).toEqual(["T"]);
  });
});

describe("renderer/extractor lockstep", () => {
  /**
   * Collect the task seqs and wiki titles the renderer would surface:
   * every non-code block's text tokenized, list items included, code
   * blocks skipped.
   *
   * @param body - Markdown note body.
   * @param identifier - Project identifier.
   * @returns Deduped seqs and case-insensitively deduped titles.
   */
  function rendererRefs(body: string, identifier: string) {
    const taskSeqs = new Set<number>();
    const titles: string[] = [];
    const seenTitles = new Set<string>();
    const collect = (text: string) => {
      for (const token of tokenizeInline(text, identifier)) {
        if (token.kind === "task") taskSeqs.add(token.seq);
        if (token.kind === "wiki") {
          const key = token.title.toLowerCase();
          if (seenTitles.has(key)) continue;
          seenTitles.add(key);
          titles.push(token.title);
        }
      }
    };
    for (const chunk of splitChunks(body)) {
      for (const block of parseBlocks(chunk)) {
        if (block.kind === "code") continue;
        if (block.kind === "ul") {
          for (const item of block.items ?? []) collect(item);
          continue;
        }
        collect(block.text ?? "");
      }
    }
    return { taskSeqs: [...taskSeqs], titles };
  }

  const corpus = [
    "plain PYZ-1 and [[One]]",
    "## PYZ-2 heading\n> callout [[Two]] PYZ-3\n- item PYZ-4\n- [[Three]]",
    "```\nPYZ-5 [[Hidden]]\n\nPYZ-6\n```\nafter PYZ-7",
    "````\ncode [[Nope]]\n```\nPYZ-8 still fenced\n````\n\n[[Four]]",
    "inline `PYZ-9` and **[[Five]] PYZ-10** then PYZ-11",
    "~~~\nPYZ-12\nunterminated [[Six]]",
    "``` info`tick\nnot fenced PYZ-13 [[Seven]]",
    "dupes [[Same]] [[same]] [[SAME]] PYZ-14 PYZ-14",
    "a `x` b `y\nz` PYZ-2 `w`",
    "`code\nPYZ-1` after",
    "> `q\n> PYZ-4` tail",
    "**bold\nPYZ-3** [[T]]",
    "one [[A\nB]] wiki never spans lines PYZ-15",
  ];

  test.each(corpus)("renderer refs match extractNoteRefs: %s", (body) => {
    const extracted = extractNoteRefs(body, "PYZ");
    const rendered = rendererRefs(body, "PYZ");
    expect(rendered.taskSeqs.toSorted((a, b) => a - b)).toEqual(
      extracted.taskSeqs.toSorted((a, b) => a - b),
    );
    expect(rendered.titles.toSorted()).toEqual(extracted.titles.toSorted());
  });
});
