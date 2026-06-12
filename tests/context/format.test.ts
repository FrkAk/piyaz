import { describe, expect, test } from "bun:test";
import { formatCriteria } from "@/lib/context/format";

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
