import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  escapeProse,
  normalizeProseDashes,
  parseActions,
  renderCatalog,
  renderToolPage,
  stripProseEmoji,
} from "../../scripts/generate-docs";
import { TOOLS } from "../../lib/mcp/schemas";

describe("TOOLS", () => {
  test("exposes all six tools", () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      "piyaz_project",
      "piyaz_task",
      "piyaz_edge",
      "piyaz_query",
      "piyaz_context",
      "piyaz_analyze",
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
    expect(page).toStartWith('---\ntitle: "piyaz_project"\n');
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

describe("renderCatalog", () => {
  test("renders commands and agents from the real plugin", async () => {
    const out = await renderCatalog(
      resolve(import.meta.dir, "../../plugins/claude-code"),
    );
    expect(out).toContain("### /piyaz");
    expect(out).toContain("### /piyaz:composer");
    expect(out).toContain("## Agents");
    expect(out).not.toMatch(/<PR/);
  });
});

describe("normalizeProseDashes", () => {
  test("replaces a spaced em-dash with a comma", () => {
    expect(normalizeProseDashes("renders X — use BEFORE coding")).toBe(
      "renders X, use BEFORE coding",
    );
  });

  test("replaces a tight em-dash with a comma and space", () => {
    expect(normalizeProseDashes("a—b")).toBe("a, b");
  });

  test("turns a numeric en-dash range into a hyphen", () => {
    expect(normalizeProseDashes("estimate 3–5 points")).toBe(
      "estimate 3-5 points",
    );
  });

  test("preserves dashes inside an inline code span", () => {
    expect(normalizeProseDashes("use `a — b` verbatim")).toBe(
      "use `a — b` verbatim",
    );
  });

  test("preserves dashes inside a fenced code block", () => {
    const input = "before\n```\nfoo — bar\n3–5\n```\nafter — end";
    expect(normalizeProseDashes(input)).toBe(
      "before\n```\nfoo — bar\n3–5\n```\nafter, end",
    );
  });

  test("leaves dash-free prose unchanged", () => {
    expect(normalizeProseDashes("draft → planned → done")).toBe(
      "draft → planned → done",
    );
  });
});

describe("stripProseEmoji", () => {
  test("removes a pictographic and collapses the gap it leaves", () => {
    expect(stripProseEmoji("includes a ⚠ Blocked section")).toBe(
      "includes a Blocked section",
    );
  });

  test("drops a trailing variation selector with the emoji", () => {
    expect(stripProseEmoji("done ✅️ here")).toBe("done here");
  });

  test("preserves emoji inside an inline code span", () => {
    expect(stripProseEmoji("use `⚠ flag` literally")).toBe(
      "use `⚠ flag` literally",
    );
  });

  test("preserves emoji inside a fenced code block", () => {
    const input = "before\n```\n⚠ keep\n```\nafter ⚠ gone";
    expect(stripProseEmoji(input)).toBe("before\n```\n⚠ keep\n```\nafter gone");
  });

  test("leaves emoji-free prose unchanged", () => {
    expect(stripProseEmoji("draft → planned → done")).toBe(
      "draft → planned → done",
    );
  });
});

describe("escapeProse", () => {
  test("escapes JSX-hostile characters in prose", () => {
    expect(escapeProse("Array<T> and {x}")).toBe("Array&lt;T> and &#123;x}");
  });

  test("leaves < and { inside an inline code span verbatim", () => {
    expect(escapeProse("see `Array<T>` and `{x}`")).toBe(
      "see `Array<T>` and `{x}`",
    );
  });

  test("strips emoji from prose while leaving code spans intact", () => {
    expect(escapeProse("a ⚠ b and `⚠ c`")).toBe("a b and `⚠ c`");
  });
});

describe("renderToolPage covers every tool", () => {
  for (const tool of TOOLS) {
    test(`${tool.name} has a populated values table`, () => {
      const page = renderToolPage(tool);
      const firstHeading = page.indexOf("\n## ");
      const valuesSection = page.slice(
        firstHeading,
        page.indexOf("\n## ", firstHeading + 4),
      );
      const bodyRows = valuesSection
        .split("\n")
        .filter((l) => l.startsWith("| `"));
      expect(bodyRows.length).toBeGreaterThan(0);
    });

    test(`${tool.name} renders deterministically`, () => {
      expect(renderToolPage(tool)).toBe(renderToolPage(tool));
    });
  }
});

describe("renderToolPage Required column", () => {
  test("default-valued fields are not marked Required", () => {
    const task = renderToolPage(TOOLS.find((t) => t.name === "piyaz_task")!);
    const previewRow = task
      .split("\n")
      .find((l) => l.startsWith("| `preview` |"));
    expect(previewRow).toBeDefined();
    expect(previewRow).toContain("| No |");
  });

  test("the discriminator field itself stays Required", () => {
    const task = renderToolPage(TOOLS.find((t) => t.name === "piyaz_task")!);
    const actionRow = task
      .split("\n")
      .find((l) => l.startsWith("| `action` |"));
    expect(actionRow).toContain("| Yes |");
  });
});

describe("renderToolPage union-array types", () => {
  test("renders an array of a union as its members, not unknown[]", () => {
    const task = renderToolPage(TOOLS.find((t) => t.name === "piyaz_task")!);
    const acRow = task
      .split("\n")
      .find((l) => l.startsWith("| `acceptanceCriteria` |"));
    expect(acRow).toContain("(string \\| object)[]");
    expect(acRow).not.toContain("unknown[]");
  });

  test("renders a url field as string (url), not bare string", () => {
    const task = renderToolPage(TOOLS.find((t) => t.name === "piyaz_task")!);
    const prUrlRow = task.split("\n").find((l) => l.startsWith("| `prUrl` |"));
    expect(prUrlRow).toContain("string (url) \\| null");
  });
});

describe("renderToolPage values-section label", () => {
  test("labels the section by the discriminator, not always 'Actions'", () => {
    const ctx = renderToolPage(TOOLS.find((t) => t.name === "piyaz_context")!);
    expect(ctx).toContain("## Depths");
    expect(ctx).toContain("| Depth | Purpose |");
    expect(ctx).not.toContain("## Actions");

    const analyze = renderToolPage(
      TOOLS.find((t) => t.name === "piyaz_analyze")!,
    );
    expect(analyze).toContain("## Types");
    expect(analyze).not.toContain("## Actions");

    const project = renderToolPage(
      TOOLS.find((t) => t.name === "piyaz_project")!,
    );
    expect(project).toContain("## Actions");
  });
});

describe("renderToolPage discriminator selection", () => {
  test("uses the declared discriminator, not an incidental enum field", () => {
    const task = renderToolPage(TOOLS.find((t) => t.name === "piyaz_task")!);
    const actionsSection = task.slice(
      task.indexOf("## Actions"),
      task.indexOf("## Parameters"),
    );
    for (const action of ["create", "update", "delete"]) {
      expect(actionsSection).toContain(`| \`${action}\` |`);
    }
    expect(actionsSection).not.toContain("| `draft` |");
  });
});

describe("normalizeProseDashes standalone cells", () => {
  test("a lone em-dash table cell becomes a single hyphen", () => {
    expect(normalizeProseDashes("| `field` | — | note |")).toBe(
      "| `field` | - | note |",
    );
  });

  test("prose em-dash still becomes a comma", () => {
    expect(normalizeProseDashes("X — Y")).toBe("X, Y");
  });
});
