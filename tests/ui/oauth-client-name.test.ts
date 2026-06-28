import { test, expect } from "bun:test";
import {
  formatOAuthClientName,
  resolveOAuthBrand,
} from "@/lib/ui/oauth-client-name";

test("formats supported OAuth client brand names consistently", () => {
  expect(formatOAuthClientName("Codex", true)).toBe("Codex");
  expect(formatOAuthClientName("Claude Code (plugin:piyaz:piyaz)", true)).toBe(
    "Claude Code",
  );
  expect(formatOAuthClientName("Cursor", true)).toBe("Cursor");
  expect(formatOAuthClientName("Antigravity", true)).toBe("Antigravity");
  expect(
    formatOAuthClientName("Google Antigravity (plugin:piyaz:piyaz)", true),
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

test("resolveOAuthBrand groups harnesses into family buckets", () => {
  expect(resolveOAuthBrand("Claude Code (plugin:piyaz:piyaz-local)")).toBe(
    "Claude",
  );
  expect(resolveOAuthBrand("Claude")).toBe("Claude");
  expect(resolveOAuthBrand("claude.ai")).toBe("Claude");
  expect(resolveOAuthBrand("Codex")).toBe("Codex");
  expect(resolveOAuthBrand("Cursor")).toBe("Cursor");
  expect(resolveOAuthBrand("Gemini CLI")).toBe("Antigravity");
  expect(resolveOAuthBrand("Google Antigravity (plugin:piyaz:piyaz)")).toBe(
    "Antigravity",
  );
  expect(resolveOAuthBrand("Antigravity")).toBe("Antigravity");
});

test("resolveOAuthBrand returns null for unknown clients", () => {
  expect(resolveOAuthBrand("Acme Agent (plugin:acme:agent)")).toBeNull();
  expect(resolveOAuthBrand("Custom Client")).toBeNull();
});

test("resolveOAuthBrand groups a spoofed brand name into its family drawer", () => {
  expect(resolveOAuthBrand("Claude Code (plugin:evil)")).toBe("Claude");
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
