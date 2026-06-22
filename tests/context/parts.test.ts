import { expect, test } from "bun:test";
import { joinParts, type BundlePart } from "@/lib/context/parts";

test("joinParts joins markdown chunks with a blank line", () => {
  const parts: BundlePart[] = [
    { id: "notice", heading: null, markdown: "> notice" },
    { id: "header", heading: null, markdown: "# `REF` Title" },
    {
      id: "plan",
      heading: "Implementation Plan",
      markdown: "\n## Implementation Plan\n\nbody",
    },
  ];
  expect(joinParts(parts)).toBe(
    "> notice\n\n# `REF` Title\n\n\n## Implementation Plan\n\nbody",
  );
});
