import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

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
    pathPrefix: "plugins/cursor/",
    subs: {
      "the AskUserQuestion tool": "the ask question tool",
      AskUserQuestion: "ask question tool",
    },
  },
  {
    pathPrefix: "plugins/antigravity/",
    subs: {
      "the AskUserQuestion tool":
        "the ask_user tool (prefer type:'choice'; type:'yesno' for confirmations; type:'text' only when the answer is genuinely open)",
      AskUserQuestion: "ask_user",
    },
  },
];

const shared: SharedGroup[] = [
  {
    name: "skills/mymir/SKILL.md",
    canonical: "plugins/claude-code/skills/mymir/SKILL.md",
    copies: [
      "plugins/codex/skills/mymir/SKILL.md",
      "plugins/cursor/skills/mymir/SKILL.md",
      "plugins/antigravity/skills/mymir/SKILL.md",
    ],
  },
  {
    name: "skills/mymir/references/conventions.md",
    canonical: "plugins/claude-code/skills/mymir/references/conventions.md",
    copies: [
      "plugins/codex/skills/mymir/references/conventions.md",
      "plugins/cursor/skills/mymir/references/conventions.md",
      "plugins/antigravity/skills/mymir/references/conventions.md",
    ],
  },
  {
    name: "skills/mymir/references/artifacts.md",
    canonical: "plugins/claude-code/skills/mymir/references/artifacts.md",
    copies: [
      "plugins/codex/skills/mymir/references/artifacts.md",
      "plugins/cursor/skills/mymir/references/artifacts.md",
      "plugins/antigravity/skills/mymir/references/artifacts.md",
    ],
  },
  {
    name: "skills/mymir/references/lifecycle.md",
    canonical: "plugins/claude-code/skills/mymir/references/lifecycle.md",
    copies: [
      "plugins/codex/skills/mymir/references/lifecycle.md",
      "plugins/cursor/skills/mymir/references/lifecycle.md",
      "plugins/antigravity/skills/mymir/references/lifecycle.md",
    ],
  },
  {
    name: "skills/mymir/references/resilience.md",
    canonical: "plugins/claude-code/skills/mymir/references/resilience.md",
    copies: [
      "plugins/codex/skills/mymir/references/resilience.md",
      "plugins/cursor/skills/mymir/references/resilience.md",
      "plugins/antigravity/skills/mymir/references/resilience.md",
    ],
  },
  {
    name: "brainstorm (agent + skill)",
    canonical: "plugins/claude-code/agents/brainstorm.md",
    copies: [
      "plugins/codex/skills/brainstorm/SKILL.md",
      "plugins/cursor/skills/brainstorm/SKILL.md",
      "plugins/antigravity/skills/brainstorm/SKILL.md",
    ],
  },
  {
    name: "decompose (agent + skill)",
    canonical: "plugins/claude-code/agents/decompose.md",
    copies: [
      "plugins/codex/skills/decompose/SKILL.md",
      "plugins/cursor/skills/decompose/SKILL.md",
      "plugins/antigravity/skills/decompose/SKILL.md",
    ],
  },
  {
    name: "decompose-task (agent + skill)",
    canonical: "plugins/claude-code/agents/decompose-task.md",
    copies: [
      "plugins/codex/skills/decompose-task/SKILL.md",
      "plugins/cursor/skills/decompose-task/SKILL.md",
      "plugins/antigravity/skills/decompose-task/SKILL.md",
    ],
  },
  {
    name: "decompose-feature (agent + skill)",
    canonical: "plugins/claude-code/agents/decompose-feature.md",
    copies: [
      "plugins/codex/skills/decompose-feature/SKILL.md",
      "plugins/cursor/skills/decompose-feature/SKILL.md",
      "plugins/antigravity/skills/decompose-feature/SKILL.md",
    ],
  },
  {
    name: "manage (agent + skill)",
    canonical: "plugins/claude-code/agents/manage.md",
    copies: [
      "plugins/codex/skills/manage/SKILL.md",
      "plugins/cursor/skills/manage/SKILL.md",
      "plugins/antigravity/skills/manage/SKILL.md",
    ],
  },
  {
    name: "onboarding (agent + skill)",
    canonical: "plugins/claude-code/agents/onboarding.md",
    copies: [
      "plugins/codex/skills/onboarding/SKILL.md",
      "plugins/cursor/skills/onboarding/SKILL.md",
      "plugins/antigravity/skills/onboarding/SKILL.md",
    ],
  },
  {
    name: "review (agent + skill)",
    canonical: "plugins/claude-code/agents/review.md",
    copies: [
      "plugins/codex/skills/review/SKILL.md",
      "plugins/cursor/skills/review/SKILL.md",
      "plugins/antigravity/skills/review/SKILL.md",
    ],
  },
  {
    name: "skills/composer/references/reviewer-rules.md",
    canonical: "plugins/claude-code/skills/composer/references/reviewer-rules.md",
    copies: [
      "plugins/codex/skills/composer/references/reviewer-rules.md",
      "plugins/cursor/skills/composer/references/reviewer-rules.md",
      "plugins/antigravity/skills/composer/references/reviewer-rules.md",
    ],
  },
];

const pluginRoots = [
  "plugins/claude-code",
  "plugins/codex",
  "plugins/cursor",
  "plugins/antigravity",
];

const extractPinsPath =
  "plugins/claude-code/skills/composer/references/sources.json";

interface ExtractPins {
  _comment: string;
  pins: Record<string, string>;
}

const fieldSyncs: FieldSync[] = [
  {
    name: "description",
    canonicalPath: "plugins/claude-code/.claude-plugin/plugin.json",
    canonicalJsonPath: ["description"],
    copies: [
      {
        path: "plugins/codex/.codex-plugin/plugin.json",
        jsonPath: ["description"],
      },
      {
        path: "plugins/cursor/.cursor-plugin/plugin.json",
        jsonPath: ["description"],
      },
      { path: "plugins/antigravity/plugin.json", jsonPath: ["description"] },
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
 * Removes a single mapping field from a markdown file's leading YAML frontmatter
 * (the first `---...---` block). Lines outside the frontmatter are never touched.
 * No-op when the file lacks frontmatter or the field is not present.
 * @param content - Markdown content as UTF-8 string.
 * @param field - Frontmatter field name to remove (matched as `${field}:` line prefix).
 * @returns Content with the matching field line removed.
 */
function stripFrontmatterField(content: string, field: string): string {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fmMatch) return content;
  const fmBody = fmMatch[1];
  const newFmBody = fmBody
    .split("\n")
    .filter((line) => !line.startsWith(`${field}:`))
    .join("\n");
  if (newFmBody === fmBody) return content;
  return content.replace(fmMatch[0], `---\n${newFmBody}\n---\n`);
}

/**
 * Renders canonical content for a specific copy path by applying platform-specific
 * substitutions, then stripping the Claude-Code-only `model` frontmatter field. The
 * first matching `pathPrefix` wins; copies whose path matches no platform are
 * returned unchanged. Substitutions run in `subs` insertion order, so longer
 * overlapping patterns must be declared first to avoid being shadowed by a shorter
 * one (e.g. `"the AskUserQuestion tool"` before `"AskUserQuestion"`).
 * @param content - Canonical content as UTF-8 string.
 * @param copyPath - Destination path used to select the substitution table.
 * @returns Content with platform substitutions applied and `model:` stripped.
 */
function render(content: string, copyPath: string): string {
  const platform = platformSubs.find((p) => copyPath.startsWith(p.pathPrefix));
  if (!platform) return content;
  const substituted = Object.entries(platform.subs).reduce(
    (acc, [from, to]) => acc.replaceAll(from, to),
    content,
  );
  return stripFrontmatterField(substituted, "model");
}

/**
 * Reads a nested JSON field by key path.
 * @param obj - Root object.
 * @param keys - Ordered list of property names to descend.
 * @returns The leaf value, or undefined if any segment is missing.
 */
function getNested(obj: Record<string, unknown>, keys: string[]): unknown {
  return keys.reduce<unknown>(
    (acc, k) => (acc as Record<string, unknown> | undefined)?.[k],
    obj,
  );
}

/**
 * Writes a nested JSON field by key path, mutating the parent object.
 * @param obj - Root object.
 * @param keys - Ordered list of property names; last is the field to set.
 * @param value - Value to assign.
 */
function setNested(
  obj: Record<string, unknown>,
  keys: string[],
  value: unknown,
): void {
  const last = keys[keys.length - 1];
  const parent = keys
    .slice(0, -1)
    .reduce<Record<string, unknown>>(
      (acc, k) => acc[k] as Record<string, unknown>,
      obj,
    );
  parent[last] = value;
}

/**
 * Recursively lists markdown files under a directory.
 * @param root - Directory to walk.
 * @returns Repo-relative paths of every `.md` file found.
 */
function listMarkdownFiles(root: string): string[] {
  return (readdirSync(root, { recursive: true }) as string[])
    .filter((p) => p.endsWith(".md"))
    .map((p) => join(root, p));
}

/**
 * Validates that every `@path` include line in a plugin's markdown files
 * resolves to an existing file inside that plugin. Includes are
 * plugin-root-relative; a dangling include silently strips an agent's
 * loaded rules at runtime, so it must fail the check.
 * @param root - Plugin root directory (e.g. `plugins/codex`).
 * @returns Number of dangling includes found (also logged to stderr).
 */
function checkIncludeTargets(root: string): number {
  let dangling = 0;
  for (const file of listMarkdownFiles(root)) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (const line of lines) {
      const match = line.match(/^@(\S+)$/);
      if (!match) continue;
      const target = join(root, match[1]);
      if (!existsSync(target)) {
        console.error(`[dangling include] ${file}: @${match[1]} (missing)`);
        dangling++;
      }
    }
  }
  return dangling;
}

/**
 * Verifies the composer extracts' canonical-source hash pins. The extracts
 * hand-mirror sections of the canonical mymir references; the pin file
 * records the canonical files' hashes the extracts were last reviewed
 * against. Any canonical edit fails the check until the extracts are
 * reviewed and the pins refreshed (`--fix` refreshes them, loudly).
 * @param fixMode - When true, refresh stale pins after warning.
 * @returns Object with failure and change counts.
 */
function checkExtractPins(fixMode: boolean): {
  failures: number;
  changes: number;
} {
  if (!existsSync(extractPinsPath)) {
    console.error(`[missing pins] ${extractPinsPath}`);
    return { failures: 1, changes: 0 };
  }
  const pinFile = JSON.parse(
    readFileSync(extractPinsPath, "utf8"),
  ) as ExtractPins;
  let failures = 0;
  let changes = 0;
  for (const [path, pinned] of Object.entries(pinFile.pins)) {
    const actual = hashFile(path);
    if (actual === pinned) {
      console.log(`[ok]      extract pin ${path}`);
      continue;
    }
    if (fixMode) {
      pinFile.pins[path] = actual;
      console.log(
        `[extracts] ${path} changed — pin refreshed. REVIEW the mirrored sections in plugins/claude-code/skills/composer/references/ before committing.`,
      );
      changes++;
    } else {
      console.error(
        `[extract drift] ${path} changed since the composer extracts were last reviewed (pin ${pinned.slice(0, 8)} vs ${actual.slice(0, 8)}). Review the mirrored sections in plugins/claude-code/skills/composer/references/, update them if needed, then run \`bun run sync:plugins\` to refresh the pin.`,
      );
      failures++;
    }
  }
  if (changes > 0) {
    writeFileSync(extractPinsPath, JSON.stringify(pinFile, null, 2) + "\n");
  }
  return { failures, changes };
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
        console.error(
          `    ${renderedHash.slice(0, 8)}  ${group.canonical} (rendered for ${copy})`,
        );
        console.error(`    ${copyHash.slice(0, 8)}  ${copy}`);
        failures++;
      }
    } else {
      console.log(`[ok]      ${copy}`);
    }
  }
}

for (const sync of fieldSyncs) {
  const canonicalManifest = JSON.parse(
    readFileSync(sync.canonicalPath, "utf8"),
  ) as Record<string, unknown>;
  const canonicalValue = getNested(canonicalManifest, sync.canonicalJsonPath);

  if (typeof canonicalValue !== "string" || canonicalValue.length === 0) {
    console.error(
      `[no ${sync.name}] ${sync.canonicalPath} is missing a string ${sync.name} field`,
    );
    failures++;
    continue;
  }

  for (const target of sync.copies) {
    const manifest = JSON.parse(readFileSync(target.path, "utf8")) as Record<
      string,
      unknown
    >;
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
      console.error(
        `[${sync.name} drift] ${target.path}: ${String(currentValue)} vs ${canonicalValue}`,
      );
      failures++;
    }
  }
}

for (const root of pluginRoots) {
  failures += checkIncludeTargets(root);
}

const pinResult = checkExtractPins(fix);
failures += pinResult.failures;
changes += pinResult.changes;

if (fix) {
  console.log(
    changes > 0
      ? `\nSynced ${changes} file(s)/field(s).`
      : `\nNothing to sync.`,
  );
  process.exit(failures > 0 ? 1 : 0);
}

if (failures > 0) {
  console.error(
    `\n${failures} drift issue(s). Run \`bun run sync:plugins\` to auto-fix.`,
  );
  process.exit(1);
}

console.log(`\nAll shared plugin content is in sync.`);
