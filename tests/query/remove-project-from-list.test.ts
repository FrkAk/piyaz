import { test, expect } from "bun:test";
import type { InfiniteData } from "@tanstack/react-query";
import {
  removeProjectFromList,
  type ProjectListPage,
} from "@/lib/query/queries";
import type { ProjectListEntry } from "@/lib/data/views";

const entry = (id: string): ProjectListEntry =>
  ({ id }) as unknown as ProjectListEntry;

const data = (pages: ProjectListPage[]): InfiniteData<ProjectListPage> => ({
  pages,
  pageParams: pages.map((_, i) => (i === 0 ? null : `c${i}`)),
});

test("removeProjectFromList drops the project from whichever page holds it", () => {
  const input = data([
    { rows: [entry("a"), entry("b")], nextCursor: "c1" },
    { rows: [entry("c"), entry("d")], nextCursor: null },
  ]);

  const out = removeProjectFromList(input, "c");

  expect(out!.pages[0]!.rows.map((r) => r.id)).toEqual(["a", "b"]);
  expect(out!.pages[1]!.rows.map((r) => r.id)).toEqual(["d"]);
  expect(out!.pageParams).toEqual(input.pageParams);
});

test("removeProjectFromList returns the same reference when the project is absent", () => {
  const input = data([{ rows: [entry("a")], nextCursor: null }]);
  expect(removeProjectFromList(input, "zzz")).toBe(input);
});

test("removeProjectFromList passes undefined through", () => {
  expect(removeProjectFromList(undefined, "a")).toBeUndefined();
});
