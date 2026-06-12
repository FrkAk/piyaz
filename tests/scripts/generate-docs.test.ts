import { describe, expect, test } from "bun:test";
import { parseActions, renderToolPage } from "../../scripts/generate-docs";
import { TOOLS } from "../../lib/mcp/schemas";

describe("TOOLS", () => {
  test("exposes all six tools", () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      "mymir_project",
      "mymir_task",
      "mymir_edge",
      "mymir_query",
      "mymir_context",
      "mymir_analyze",
    ]);
  });
});

describe("parseActions", () => {
  test("splits per-action purpose text", () => {
    const desc = "list=all projects. teams=memberships. create=new project.";
    const parsed = parseActions(desc, ["list", "teams", "create"]);
    expect(parsed).toEqual([
      { action: "list", purpose: "all projects" },
      { action: "teams", purpose: "memberships" },
      { action: "create", purpose: "new project" },
    ]);
  });
});

describe("renderToolPage", () => {
  const page = renderToolPage(TOOLS[0]);

  test("emits frontmatter, marker, and sections", () => {
    expect(page).toStartWith("---\ntitle: mymir_project\n");
    expect(page).toContain("Do not edit by hand");
    expect(page).toContain("## Actions");
    expect(page).toContain("## Parameters");
  });

  test("lists every action and the action parameter first", () => {
    for (const action of ["list", "teams", "create", "select", "update"]) {
      expect(page).toContain(`| \`${action}\` |`);
    }
    const actionRow = page.indexOf("| `action` |");
    const projectIdRow = page.indexOf("| `projectId` |");
    expect(actionRow).toBeGreaterThan(-1);
    expect(actionRow).toBeLessThan(projectIdRow);
  });

  test("is deterministic", () => {
    expect(renderToolPage(TOOLS[0])).toBe(page);
  });

  test("escapes MDX-hostile characters in prose", () => {
    expect(page).not.toMatch(/^[^`]*<[a-zA-Z]/m);
  });
});
