import { describe, expect, test } from "bun:test";
import {
  capLines,
  formatCriteria,
  MAX_BUNDLE_LIST_LINES,
} from "@/lib/context/format";

const remaining = {
  id: "11111111-1111-4111-8111-111111111111",
  text: "It works",
  checked: false,
};
const done = {
  id: "22222222-2222-4222-8222-222222222222",
  text: "It ships",
  checked: true,
};

describe("formatCriteria", () => {
  test("renders the criterion id on unchecked items", () => {
    expect(formatCriteria([remaining])).toBe(
      "- [ ] `11111111-1111-4111-8111-111111111111` It works",
    );
  });

  test("renders the criterion id on checked items", () => {
    expect(formatCriteria([done])).toBe(
      "All criteria met:\n- [x] `22222222-2222-4222-8222-222222222222` It ships",
    );
  });

  test("renders ids in the mixed grouping", () => {
    expect(formatCriteria([remaining, done])).toBe(
      "Remaining:\n- [ ] `11111111-1111-4111-8111-111111111111` It works\n\n" +
        "Done:\n- [x] `22222222-2222-4222-8222-222222222222` It ships",
    );
  });

  test("empty input stays None", () => {
    expect(formatCriteria([])).toBe("None");
  });
});

describe("capLines", () => {
  test("keeps lists at or under the limit untouched", () => {
    expect(capLines(["a", "b"], "guidance")).toEqual(["a", "b"]);
  });

  test("caps long lists with a counted guidance line", () => {
    const lines = Array.from(
      { length: MAX_BUNDLE_LIST_LINES + 5 },
      (_, i) => `line ${i}`,
    );
    const capped = capLines(lines, "run piyaz_map view='neighbors'.");
    expect(capped).toHaveLength(MAX_BUNDLE_LIST_LINES + 1);
    expect(capped.at(-1)).toBe("… +5 more — run piyaz_map view='neighbors'.");
  });
});
