import { test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const readJson = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));

test("Claude root marketplace sources the claude-code subdir via git-subdir", () => {
  const mkt = readJson(".claude-plugin/marketplace.json");
  expect(mkt.name).toBe("mymir");
  expect(mkt.owner?.name).toBe("Mymir");
  const plugin = mkt.plugins.find((p: { name: string }) => p.name === "mymir");
  expect(plugin).toBeDefined();
  expect(plugin.source.source).toBe("git-subdir");
  expect(plugin.source.url).toBe("https://github.com/FrkAk/mymir.git");
  expect(plugin.source.path).toBe("plugins/claude-code");
});

test("Codex root marketplace sources the codex subdir via git-subdir", () => {
  const mkt = readJson(".agents/plugins/marketplace.json");
  expect(mkt.name).toBe("mymir");
  expect(mkt.interface?.displayName).toBe("Mymir");
  const plugin = mkt.plugins.find((p: { name: string }) => p.name === "mymir");
  expect(plugin).toBeDefined();
  expect(plugin.source.source).toBe("git-subdir");
  expect(plugin.source.url).toBe("https://github.com/FrkAk/mymir.git");
  expect(plugin.source.path).toBe("plugins/codex");
});

test("Codex contributor marketplace is mymir-local sourcing ./codex", () => {
  const mkt = readJson("plugins/.agents/plugins/marketplace.json");
  expect(mkt.name).toBe("mymir-local");
  const plugin = mkt.plugins.find((p: { name: string }) => p.name === "mymir");
  expect(plugin).toBeDefined();
  expect(plugin.source.path).toBe("./codex");
});

test("Cursor root marketplace sources the cursor subdir", () => {
  const mkt = readJson(".cursor-plugin/marketplace.json");
  expect(mkt.name).toBe("mymir");
  const plugin = mkt.plugins.find((p: { name: string }) => p.name === "mymir");
  expect(plugin).toBeDefined();
  expect(plugin.source).toBe("plugins/cursor");
});

test("Cursor plugin manifest declares skills and mcp components", () => {
  const p = readJson("plugins/cursor/.cursor-plugin/plugin.json");
  expect(p.skills).toBeDefined();
  expect(p.mcpServers).toBeDefined();
});

test("Antigravity plugin marker exists and is named mymir", () => {
  const p = readJson("plugins/antigravity/plugin.json");
  expect(p.name).toBe("mymir");
});

test("Antigravity mcp_config uses serverUrl (never url/httpUrl) for both servers", () => {
  const cfg = readJson("plugins/antigravity/mcp_config.json");
  const hosted = cfg.mcpServers.mymir;
  const local = cfg.mcpServers["mymir-local"];
  expect(hosted.serverUrl).toContain("app.mymir.dev");
  expect(hosted.url).toBeUndefined();
  expect(hosted.httpUrl).toBeUndefined();
  expect(local.serverUrl).toContain("localhost:3000");
});

test("Antigravity bundles every shared skill", () => {
  for (const s of [
    "mymir",
    "brainstorm",
    "decompose",
    "decompose-task",
    "decompose-feature",
    "manage",
    "onboarding",
    "review",
  ]) {
    expect(
      existsSync(join(root, `plugins/antigravity/skills/${s}/SKILL.md`)),
    ).toBe(true);
  }
});

test.each([
  "plugins/claude-code/.mcp.json",
  "plugins/codex/.mcp.json",
  "plugins/cursor/mcp.json",
])("%s declares hosted mymir + local mymir-local", (path) => {
  const cfg = readJson(path);
  expect(cfg.mcpServers.mymir).toBeDefined();
  expect(cfg.mcpServers["mymir-local"]).toBeDefined();
  expect(JSON.stringify(cfg.mcpServers.mymir)).toContain("app.mymir.dev");
  expect(JSON.stringify(cfg.mcpServers["mymir-local"])).toContain(
    "localhost:3000",
  );
});
