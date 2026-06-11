import { test, expect } from "bun:test";
import { formatOAuthClientName } from "@/lib/ui/oauth-client-name";

test("formats supported OAuth client brand names consistently", () => {
  expect(formatOAuthClientName("Codex", true)).toBe("Codex");
  expect(formatOAuthClientName("Claude Code (plugin:mymir:mymir)", true)).toBe(
    "Claude Code",
  );
  expect(formatOAuthClientName("Cursor", true)).toBe("Cursor");
  expect(formatOAuthClientName("Antigravity", true)).toBe("Antigravity");
  expect(
    formatOAuthClientName("Google Antigravity (plugin:mymir:mymir)", true),
  ).toBe("Antigravity");
  expect(formatOAuthClientName("Gemini CLI", true)).toBe("Gemini");
});

test("keeps unknown OAuth client names while removing plugin metadata", () => {
  expect(formatOAuthClientName("Acme Agent (plugin:acme:agent)", true)).toBe(
    "Acme Agent",
  );
  expect(formatOAuthClientName("Custom Client", true)).toBe("Custom Client");
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

test("invisible Unicode is stripped so lookalike names cannot render", () => {
  // Zero-width space (U+200B) must not let "Claude<zwsp>Code" render as a
  // visual "Claude Code" while comparing unequal to it.
  expect(formatOAuthClientName("Claude​Code", false)).toBe("ClaudeCode");
  // RTL override (U+202E) and zero-width joiner (U+200D) are stripped in
  // both verified and unverified modes.
  expect(formatOAuthClientName("Claude‮ Code", false)).toBe("Claude Code");
  expect(formatOAuthClientName("Cla‍ude Code", true)).toBe("Claude Code");
  // Whitespace-class controls still collapse to plain spaces, not deletion.
  expect(formatOAuthClientName("Claude\tCode", false)).toBe("Claude Code");
});
