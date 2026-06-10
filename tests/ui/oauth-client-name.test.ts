import { test, expect } from "bun:test";
import { formatOAuthClientName } from "@/lib/ui/oauth-client-name";

test("formats supported OAuth client brand names consistently", () => {
  expect(formatOAuthClientName("Codex")).toBe("Codex");
  expect(formatOAuthClientName("Claude Code (plugin:mymir:mymir)")).toBe(
    "Claude Code",
  );
  expect(formatOAuthClientName("Cursor")).toBe("Cursor");
  expect(formatOAuthClientName("Antigravity")).toBe("Antigravity");
  expect(formatOAuthClientName("Google Antigravity (plugin:mymir:mymir)")).toBe(
    "Antigravity",
  );
  expect(formatOAuthClientName("Gemini CLI")).toBe("Gemini");
});

test("keeps unknown OAuth client names while removing plugin metadata", () => {
  expect(formatOAuthClientName("Acme Agent (plugin:acme:agent)")).toBe(
    "Acme Agent",
  );
  expect(formatOAuthClientName("Custom Client")).toBe("Custom Client");
});

test("unverified clients are shown verbatim without brand laundering", () => {
  // A spoofed name must NOT collapse onto a trusted brand on the consent
  // screen: no suffix stripping, no brand-label match.
  expect(formatOAuthClientName("Claude Code (plugin:evil)", false)).toBe(
    "Claude Code (plugin:evil)",
  );
  expect(formatOAuthClientName("Codex", false)).toBe("Codex");
  // Only whitespace is tidied.
  expect(formatOAuthClientName("  Evil   Client  ", false)).toBe("Evil Client");
});
