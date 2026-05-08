import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";

interface SharedGroup {
  name: string;
  canonical: string;
  copies: string[];
}

interface FieldTarget {
  path: string;
  jsonPath: string[];
}

interface FieldSync {
  name: string;
  canonicalPath: string;
  canonicalJsonPath: string[];
  copies: FieldTarget[];
}

interface PlatformSubs {
  pathPrefix: string;
  subs: Record<string, string>;
}

const platformSubs: PlatformSubs[] = [
  {
    pathPrefix: "plugins/codex/",
    subs: {
      "the AskUserQuestion tool":
        "the ask_user_question tool if your Codex install exposes it, otherwise a numbered prose list (≤4 questions, ≤4 options each)",
      AskUserQuestion: "ask_user_question",
    },
  },
  {
    pathPrefix: "plugins/gemini/",
    subs: {
      "the AskUserQuestion tool":
        "the ask_user tool (prefer type:'choice'; type:'yesno' for confirmations; type:'text' only when the answer is genuinely open)",
      AskUserQuestion: "ask_user",
    },
  },
  {
    pathPrefix: "plugins/cursor/",
    subs: {
      "the AskUserQuestion tool": "the ask question tool",
      AskUserQuestion: "ask question tool",
    },
  },
];

const shared: SharedGroup[] = [
  {
    name: "skills/mymir/SKILL.md",
    canonical: "plugins/claude-code/skills/mymir/SKILL.md",
    copies: [
      "plugins/codex/skills/mymir/SKILL.md",
      "plugins/gemini/skills/mymir/SKILL.md",
      "plugins/cursor/skills/mymir/SKILL.md",
    ],
  },
  {
    name: "skills/mymir/references/conventions.md",
    canonical: "plugins/claude-code/skills/mymir/references/conventions.md",
    copies: [
      "plugins/codex/skills/mymir/references/conventions.md",
      "plugins/gemini/skills/mymir/references/conventions.md",
      "plugins/cursor/skills/mymir/references/conventions.md",
    ],
  },
  {
    name: "skills/mymir/references/artifacts.md",
    canonical: "plugins/claude-code/skills/mymir/references/artifacts.md",
    copies: [
      "plugins/codex/skills/mymir/references/artifacts.md",
      "plugins/gemini/skills/mymir/references/artifacts.md",
      "plugins/cursor/skills/mymir/references/artifacts.md",
    ],
  },
  {
    name: "skills/mymir/references/lifecycle.md",
    canonical: "plugins/claude-code/skills/mymir/references/lifecycle.md",
    copies: [
      "plugins/codex/skills/mymir/references/lifecycle.md",
      "plugins/gemini/skills/mymir/references/lifecycle.md",
      "plugins/cursor/skills/mymir/references/lifecycle.md",
    ],
  },
  {
    name: "skills/mymir/references/resilience.md",
    canonical: "plugins/claude-code/skills/mymir/references/resilience.md",
    copies: [
      "plugins/codex/skills/mymir/references/resilience.md",
      "plugins/gemini/skills/mymir/references/resilience.md",
      "plugins/cursor/skills/mymir/references/resilience.md",
    ],
  },
  {
    name: "brainstorm (agent + skill)",
    canonical: "plugins/claude-code/agents/brainstorm.md",
    copies: [
      "plugins/codex/skills/brainstorm/SKILL.md",
      "plugins/gemini/skills/brainstorm/SKILL.md",
      "plugins/cursor/skills/brainstorm/SKILL.md",
    ],
  },
  {
    name: "decompose (agent + skill)",
    canonical: "plugins/claude-code/agents/decompose.md",
    copies: [
      "plugins/codex/skills/decompose/SKILL.md",
      "plugins/gemini/skills/decompose/SKILL.md",
      "plugins/cursor/skills/decompose/SKILL.md",
    ],
  },
  {
    name: "manage (agent + skill)",
    canonical: "plugins/claude-code/agents/manage.md",
    copies: [
      "plugins/codex/skills/manage/SKILL.md",
      "plugins/gemini/skills/manage/SKILL.md",
      "plugins/cursor/skills/manage/SKILL.md",
    ],
  },
  {
    name: "onboarding (agent + skill)",
    canonical: "plugins/claude-code/agents/onboarding.md",
    copies: [
      "plugins/codex/skills/onboarding/SKILL.md",
      "plugins/gemini/skills/onboarding/SKILL.md",
      "plugins/cursor/skills/onboarding/SKILL.md",
    ],
  },
];

const fieldSyncs: FieldSync[] = [
  {
    name: "version",
    canonicalPath: "plugins/claude-code/.claude-plugin/plugin.json",
    canonicalJsonPath: ["version"],
    copies: [
      { path: "plugins/codex/.codex-plugin/plugin.json", jsonPath: ["version"] },
      { path: "plugins/gemini/gemini-extension.json", jsonPath: ["version"] },
      { path: "plugins/cursor/.cursor-plugin/plugin.json", jsonPath: ["version"] },
    ],
  },
  {
    name: "description",
    canonicalPath: "plugins/claude-code/.claude-plugin/plugin.json",
    canonicalJsonPath: ["description"],
    copies: [
      { path: "plugins/codex/.codex-plugin/plugin.json", jsonPath: ["description"] },
      { path: "plugins/gemini/gemini-extension.json", jsonPath: ["description"] },
      { path: "plugins/cursor/.cursor-plugin/plugin.json", jsonPath: ["description"] },
    ],
  },
];

/**
 * Computes the SHA-256 hex digest of a file's bytes.
 * @param path - Path to read.
 * @returns Lowercase hex hash string.
 */
function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Computes the SHA-256 hex digest of a UTF-8 string.
 * @param content - String to hash.
 * @returns Lowercase hex hash string.
 */
function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Renders canonical content for a specific copy path by applying platform-specific
 * substitutions. The first matching `pathPrefix` wins; copies whose path matches no
 * platform are returned unchanged. Substitutions run in `subs` insertion order, so
 * longer overlapping patterns must be declared first to avoid being shadowed by a
 * shorter one (e.g. `"the AskUserQuestion tool"` before `"AskUserQuestion"`).
 * @param content - Canonical content as UTF-8 string.
 * @param copyPath - Destination path used to select the substitution table.
 * @returns Content with platform substitutions applied.
 */
function render(content: string, copyPath: string): string {
  const platform = platformSubs.find((p) => copyPath.startsWith(p.pathPrefix));
  if (!platform) return content;
  return Object.entries(platform.subs).reduce(
    (acc, [from, to]) => acc.replaceAll(from, to),
    content,
  );
}

/**
 * Reads a nested JSON field by key path.
 * @param obj - Root object.
 * @param keys - Ordered list of property names to descend.
 * @returns The leaf value, or undefined if any segment is missing.
 */
function getNested(obj: Record<string, unknown>, keys: string[]): unknown {
  return keys.reduce<unknown>((acc, k) => (acc as Record<string, unknown> | undefined)?.[k], obj);
}

/**
 * Writes a nested JSON field by key path, mutating the parent object.
 * @param obj - Root object.
 * @param keys - Ordered list of property names; last is the field to set.
 * @param value - Value to assign.
 */
function setNested(obj: Record<string, unknown>, keys: string[], value: unknown): void {
  const last = keys[keys.length - 1];
  const parent = keys.slice(0, -1).reduce<Record<string, unknown>>(
    (acc, k) => acc[k] as Record<string, unknown>,
    obj,
  );
  parent[last] = value;
}

const fix = process.argv.includes("--fix");

let failures = 0;
let changes = 0;

for (const group of shared) {
  if (!existsSync(group.canonical)) {
    console.error(`[missing canonical] ${group.name}: ${group.canonical}`);
    failures++;
    continue;
  }
  const canonicalContent = readFileSync(group.canonical, "utf8");

  for (const copy of group.copies) {
    const renderedContent = render(canonicalContent, copy);
    const renderedHash = hashContent(renderedContent);

    if (!existsSync(copy)) {
      if (fix) {
        mkdirSync(dirname(copy), { recursive: true });
        writeFileSync(copy, renderedContent);
        console.log(`[created] ${copy}`);
        changes++;
      } else {
        console.error(`[missing] ${copy}`);
        failures++;
      }
      continue;
    }
    const copyHash = hashFile(copy);
    if (copyHash !== renderedHash) {
      if (fix) {
        writeFileSync(copy, renderedContent);
        console.log(`[synced]  ${copy}`);
        changes++;
      } else {
        console.error(`[drift]   ${group.name}`);
        console.error(`    ${renderedHash.slice(0, 8)}  ${group.canonical} (rendered for ${copy})`);
        console.error(`    ${copyHash.slice(0, 8)}  ${copy}`);
        failures++;
      }
    } else {
      console.log(`[ok]      ${copy}`);
    }
  }
}

for (const sync of fieldSyncs) {
  const canonicalManifest = JSON.parse(readFileSync(sync.canonicalPath, "utf8")) as Record<string, unknown>;
  const canonicalValue = getNested(canonicalManifest, sync.canonicalJsonPath);

  if (typeof canonicalValue !== "string" || canonicalValue.length === 0) {
    console.error(`[no ${sync.name}] ${sync.canonicalPath} is missing a string ${sync.name} field`);
    failures++;
    continue;
  }

  for (const target of sync.copies) {
    const manifest = JSON.parse(readFileSync(target.path, "utf8")) as Record<string, unknown>;
    const currentValue = getNested(manifest, target.jsonPath);
    if (currentValue === canonicalValue) {
      console.log(`[ok]      ${target.path} ${sync.name} ok`);
      continue;
    }
    if (fix) {
      setNested(manifest, target.jsonPath, canonicalValue);
      writeFileSync(target.path, JSON.stringify(manifest, null, 2) + "\n");
      console.log(`[synced]  ${target.path} ${sync.name} → ${canonicalValue}`);
      changes++;
    } else {
      console.error(`[${sync.name} drift] ${target.path}: ${String(currentValue)} vs ${canonicalValue}`);
      failures++;
    }
  }
}

if (fix) {
  console.log(changes > 0 ? `\nSynced ${changes} file(s)/field(s).` : `\nNothing to sync.`);
  process.exit(0);
}

if (failures > 0) {
  console.error(`\n${failures} drift issue(s). Run \`bun run sync:plugins\` to auto-fix.`);
  process.exit(1);
}

console.log(`\nAll shared content and versions are in sync.`);
