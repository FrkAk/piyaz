import { test, expect } from "bun:test";
import { formatOAuthClientName } from "@/lib/ui/oauth-client-name";

test("formats supported OAuth client brand names consistently", () => {
  expect(formatOAuthClientName("Codex")).toBe("Codex");
  expect(formatOAuthClientName("Claude Code (plugin:mymir:mymir)")).toBe(
    "Claude Code",
  );
  expect(formatOAuthClientName("Cursor")).toBe("Cursor");
  expect(formatOAuthClientName("Gemini CLI")).toBe("Gemini");
});

test("keeps unknown OAuth client names while removing plugin metadata", () => {
  expect(formatOAuthClientName("Acme Agent (plugin:acme:agent)")).toBe(
    "Acme Agent",
  );
  expect(formatOAuthClientName("Custom Client")).toBe("Custom Client");
});
