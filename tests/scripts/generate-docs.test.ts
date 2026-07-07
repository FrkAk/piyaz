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
  test("exposes all nine tools", () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      "piyaz_workspace",
      "piyaz_search",
      "piyaz_get",
      "piyaz_create",
      "piyaz_edit",
      "piyaz_link",
      "piyaz_map",
      "piyaz_activity",
      "piyaz_note",
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
    expect(page).toStartWith('---\ntitle: "piyaz_workspace"\n');
    expect(page).toContain("Do not edit by hand");
    expect(page).toContain("## Actions");
    expect(page).toContain("## Parameters");
  });

  test("lists every action and the action parameter first", () => {
    for (const action of ["whoami", "teams", "projects", "create", "update"]) {
      expect(page).toContain(`| \`${action}\` |`);
    }
    const actionRow = page.indexOf("| `action` |");
    const projectRow = page.indexOf("| `project` |");
    expect(actionRow).toBeGreaterThan(-1);
    expect(actionRow).toBeLessThan(projectRow);
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
  test("optional fields are not marked Required", () => {
    const get = renderToolPage(TOOLS.find((t) => t.name === "piyaz_get")!);
    const lensRow = get.split("\n").find((l) => l.startsWith("| `lens` |"));
    expect(lensRow).toBeDefined();
    expect(lensRow).toContain("| No |");
  });

  test("the discriminator field itself stays Required", () => {
    const ws = renderToolPage(TOOLS.find((t) => t.name === "piyaz_workspace")!);
    const actionRow = ws.split("\n").find((l) => l.startsWith("| `action` |"));
    expect(actionRow).toContain("| Yes |");
  });
});

describe("renderToolPage union types", () => {
  test("renders a literal-union field as its members, not unknown", () => {
    const map = renderToolPage(TOOLS.find((t) => t.name === "piyaz_map")!);
    const hopsRow = map.split("\n").find((l) => l.startsWith("| `hops` |"));
    expect(hopsRow).toBeDefined();
    expect(hopsRow).not.toContain("unknown");
  });

  test("renders object-array fields with their item shape, not unknown[]", () => {
    const create = renderToolPage(
      TOOLS.find((t) => t.name === "piyaz_create")!,
    );
    const tasksRow = create
      .split("\n")
      .find((l) => l.startsWith("| `tasks` |"));
    expect(tasksRow).toBeDefined();
    expect(tasksRow).not.toContain("unknown[]");
  });
});

describe("renderToolPage values-section label", () => {
  test("labels the section by the discriminator, not always 'Actions'", () => {
    const get = renderToolPage(TOOLS.find((t) => t.name === "piyaz_get")!);
    expect(get).toContain("## Lenses");
    expect(get).toContain("| Lens | Purpose |");
    expect(get).not.toContain("## Actions");

    const map = renderToolPage(TOOLS.find((t) => t.name === "piyaz_map")!);
    expect(map).toContain("## Views");
    expect(map).not.toContain("## Actions");

    const ws = renderToolPage(TOOLS.find((t) => t.name === "piyaz_workspace")!);
    expect(ws).toContain("## Actions");
  });
});

describe("renderToolPage without a discriminator", () => {
  test("renders no values table for null-discriminator tools", () => {
    for (const name of [
      "piyaz_search",
      "piyaz_create",
      "piyaz_edit",
      "piyaz_activity",
    ]) {
      const page = renderToolPage(TOOLS.find((t) => t.name === name)!);
      expect(page).toContain("## Parameters");
      expect(page).not.toContain("| Purpose |");
    }
  });
});

describe("renderToolPage discriminator selection", () => {
  test("uses the declared discriminator, not an incidental enum field", () => {
    const link = renderToolPage(TOOLS.find((t) => t.name === "piyaz_link")!);
    const actionsSection = link.slice(
      link.indexOf("## Actions"),
      link.indexOf("## Parameters"),
    );
    for (const action of ["create", "update", "remove"]) {
      expect(actionsSection).toContain(`| \`${action}\` |`);
    }
    expect(actionsSection).not.toContain("| `depends_on` |");
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
