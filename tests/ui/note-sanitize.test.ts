import { test, expect } from "bun:test";
import type {
  Element,
  ElementContent,
  Properties,
  Root,
  RootContent,
} from "hast";
import rehypeSanitize from "rehype-sanitize";
import { noteSchema } from "@/components/workspace/notes/NoteMarkdown";
import { schema } from "@/components/shared/Markdown";

/**
 * Build a hast element node from tag name, properties, and children.
 *
 * @param tagName - Element tag name.
 * @param properties - Element properties (attributes).
 * @param children - Child element content.
 * @returns The hast element node.
 */
function el(
  tagName: string,
  properties: Properties,
  children: ElementContent[] = [],
): Element {
  return { type: "element", tagName, properties, children };
}

/**
 * Sanitize a set of top-level nodes against a schema and return the cleaned
 * tree. Runs the real rehype-sanitize plugin, the same instance the render
 * paths use, so the assertions pin the actual allowlist.
 *
 * @param schemaObj - The sanitize schema to enforce.
 * @param children - Top-level nodes to sanitize.
 * @returns The sanitized root.
 */
function clean(schemaObj: object, children: RootContent[]): Root {
  const root: Root = { type: "root", children };
  return rehypeSanitize(schemaObj)(root) as Root;
}

/**
 * Collect every element node in a tree, depth first.
 *
 * @param node - The root or element to walk.
 * @returns All element descendants (and the node itself when an element).
 */
function elements(node: Root | ElementContent): Element[] {
  const out: Element[] = [];
  const walk = (n: Root | ElementContent) => {
    if (n.type === "element") out.push(n);
    if ("children" in n)
      for (const child of n.children) walk(child as ElementContent);
  };
  walk(node);
  return out;
}

/**
 * Find the first element with the given tag name in a tree.
 *
 * @param tree - The sanitized root.
 * @param tagName - Tag name to locate.
 * @returns The element, or undefined when none survived.
 */
function find(tree: Root, tagName: string): Element | undefined {
  return elements(tree).find((n) => n.tagName === tagName);
}

test("drops a script element entirely", () => {
  const tree = clean(noteSchema, [
    el("script", {}, [{ type: "text", value: "alert(1)" }]),
    el("p", {}, [{ type: "text", value: "safe" }]),
  ]);
  expect(find(tree, "script")).toBeUndefined();
  expect(find(tree, "p")).toBeDefined();
});

test("keeps img src but strips every on* handler", () => {
  const tree = clean(noteSchema, [
    el("img", {
      src: "https://ok.example.com/a.png",
      onError: "alert(1)",
      onLoad: "steal()",
    }),
  ]);
  const img = find(tree, "img");
  expect(img).toBeDefined();
  expect(img?.properties.src).toBe("https://ok.example.com/a.png");
  expect(img?.properties.onError).toBeUndefined();
  expect(img?.properties.onLoad).toBeUndefined();
});

test("strips javascript:/data:/vbscript: hrefs and keeps https", () => {
  const tree = clean(noteSchema, [
    el("a", { href: "javascript:alert(1)" }, [{ type: "text", value: "x" }]),
    el("a", { href: "data:text/html,<script>1</script>" }, [
      { type: "text", value: "d" },
    ]),
    el("a", { href: "vbscript:msgbox(1)" }, [{ type: "text", value: "v" }]),
    el("a", { href: "https://ok.example.com" }, [
      { type: "text", value: "ok" },
    ]),
  ]);
  const anchors = elements(tree).filter((n) => n.tagName === "a");
  expect(anchors).toHaveLength(4);
  expect(anchors[0]?.properties.href).toBeUndefined();
  expect(anchors[1]?.properties.href).toBeUndefined();
  expect(anchors[2]?.properties.href).toBeUndefined();
  expect(anchors[3]?.properties.href).toBe("https://ok.example.com");
});

test("noteref-task keeps only seq, dropping an injected onClick", () => {
  const tree = clean(noteSchema, [
    el("noteref-task", { seq: 3, onClick: "steal()" }),
  ]);
  const ref = find(tree, "noteref-task");
  expect(ref).toBeDefined();
  expect(ref?.properties.seq).toBe(3);
  expect(ref?.properties.onClick).toBeUndefined();
});

test("noteref-wiki keeps only title, dropping an injected href/onClick", () => {
  const tree = clean(noteSchema, [
    el("noteref-wiki", {
      title: "My Note",
      href: "javascript:alert(1)",
      onClick: "steal()",
    }),
  ]);
  const ref = find(tree, "noteref-wiki");
  expect(ref).toBeDefined();
  expect(ref?.properties.title).toBe("My Note");
  expect(ref?.properties.href).toBeUndefined();
  expect(ref?.properties.onClick).toBeUndefined();
});

test("data-src-line survives while sibling style/on* attributes are stripped", () => {
  const tree = clean(noteSchema, [
    el("p", {
      "data-src-line": 4,
      style: "background:url(javascript:alert(1))",
      onMouseOver: "steal()",
    }),
  ]);
  const p = find(tree, "p");
  expect(p).toBeDefined();
  expect(p?.properties["data-src-line"]).toBe(4);
  expect(p?.properties.style).toBeUndefined();
  expect(p?.properties.onMouseOver).toBeUndefined();
});

test("the base shared schema is equally strict on script/img/js-href", () => {
  const tree = clean(schema, [
    el("script", {}, [{ type: "text", value: "alert(1)" }]),
    el("img", { src: "https://ok.example.com/a.png", onError: "alert(1)" }),
    el("a", { href: "javascript:alert(1)" }, [{ type: "text", value: "x" }]),
    el("a", { href: "https://ok.example.com" }, [
      { type: "text", value: "ok" },
    ]),
  ]);
  expect(find(tree, "script")).toBeUndefined();
  expect(find(tree, "img")?.properties.onError).toBeUndefined();
  expect(find(tree, "img")?.properties.src).toBe(
    "https://ok.example.com/a.png",
  );
  const anchors = elements(tree).filter((n) => n.tagName === "a");
  expect(anchors[0]?.properties.href).toBeUndefined();
  expect(anchors[1]?.properties.href).toBe("https://ok.example.com");
});

test("the base shared schema rejects the note-only ref tags", () => {
  const tree = clean(schema, [el("noteref-task", { seq: 3 })]);
  expect(find(tree, "noteref-task")).toBeUndefined();
});
