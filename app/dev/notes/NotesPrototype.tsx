"use client";

import {
  createContext,
  Fragment,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { AutoGrowTextarea } from "@/components/shared/AutoGrowTextarea";
import { Button } from "@/components/shared/Button";
import { Dropdown } from "@/components/shared/Dropdown";
import { ChipTrigger } from "@/components/shared/FilterChip";
import {
  IconAgent,
  IconBundle,
  IconChevronDown,
  IconChevronRight,
  IconDoc,
  IconFolderPlus,
  IconGraph,
  IconGrip,
  IconList,
  IconLock,
  IconMoon,
  IconPlus,
  IconSearch,
  IconSun,
  IconTag,
  IconUser,
  IconUsers,
  IconX,
} from "@/components/shared/icons";
import { MonoId } from "@/components/shared/MonoId";
import { STATUS_META, type TaskStatus } from "@/components/shared/StatusGlyph";

interface NavHandlers {
  onNote: (title: string) => void;
  onTask: (ref: string) => void;
}

/** Navigation handlers for inline links — only present inside the editor. */
const NavContext = createContext<NavHandlers | null>(null);

/*
 * NON-FUNCTIONAL PROTOTYPE — all data below is mock. No DB, MCP, or network.
 * Purpose: confirm the Notes look against the real app design soul before any
 * backend work. Reuses the real tokens, StatusGlyph palette, MonoId, Button,
 * and icon set. Spec: docs/superpowers/specs/2026-06-20-piyaz-notes-design.md
 *
 * Editing follows the Typora / Obsidian Live Preview model: content renders
 * styled, click a block to edit its markdown in place, click away to re-render.
 * The third note type (Knowledge) follows Karpathy's Obsidian "LLM Wiki"
 * pattern — an agent-maintained, interlinked base surfaced via search.
 */

type NoteType = "reference" | "guidance" | "knowledge";
type Visibility = "private" | "team";
type FeedMode = "none" | "all" | "categories" | "tags" | "tasks";
type AccessLevel = "open" | "agent" | "locked";

interface Feed {
  mode: FeedMode;
  categories: string[];
  tags: string[];
  tasks: string[];
}

interface NoteTypeMeta {
  label: string;
  color: string;
  behavior: "Pull-on-demand" | "Auto-inject" | "Search";
  blurb: string;
  rule: string;
  depth: string;
}

/** Type-driven context behavior + the real token each note type borrows. */
const NOTE_TYPE_META: Record<NoteType, NoteTypeMeta> = {
  reference: {
    label: "Reference",
    color: "var(--color-planned)",
    behavior: "Pull-on-demand",
    blurb: "Specs, docs, research.",
    rule: "Pulled on demand. Heading-addressable; never auto-injected.",
    depth: "agent · planning",
  },
  guidance: {
    label: "Guidance",
    color: "var(--color-progress)",
    behavior: "Auto-inject",
    blurb: "Agent rules & project guidelines.",
    rule: "Auto-injected as a short constraints block for in-scope tasks.",
    depth: "agent · planning",
  },
  knowledge: {
    label: "Knowledge",
    color: "var(--color-relates)",
    behavior: "Search",
    blurb: "Agent-maintained wiki & memory.",
    rule: "Interlinked base. Surfaced to agents via semantic search.",
    depth: "agent (semantic)",
  },
};

const CATEGORIES = [
  "Backend",
  "Frontend",
  "MCP",
  "Database",
  "Product",
  "All categories",
] as const;

const PROJECT_TAGS = [
  "auth",
  "sessions",
  "security",
  "rls",
  "schema",
  "dependencies",
  "style",
  "process",
  "design",
  "notes",
  "postgres",
] as const;

interface MockTask {
  status: TaskStatus;
  title: string;
}

/** Mock task store the live status chips resolve against. */
const TASKS: Record<string, MockTask> = {
  "PYZ-145": { status: "done", title: "better-auth org scoping" },
  "PYZ-153": { status: "in_progress", title: "Session refresh token rotation" },
  "PYZ-188": { status: "planned", title: "Context-bundle linked knowledge" },
  "PYZ-201": { status: "done", title: "Notes data model + migration" },
  "PYZ-202": { status: "in_review", title: "piyaz_note MCP tool" },
  "PYZ-210": { status: "blocked", title: "Guidance scope matcher" },
};

interface LinkedTask {
  ref: string;
  kind: "mention" | "reference" | "spec_of";
  pinned?: boolean;
}

interface LinkedNote {
  title: string;
  type: NoteType;
  direction: "links to" | "backlink";
}

interface Note {
  id: string;
  type: NoteType;
  folder: string;
  title: string;
  summary: string;
  author: { kind: "human" | "agent"; name: string };
  version: number;
  updated: string;
  visibility: Visibility;
  agentWritable: boolean;
  locked: boolean;
  category: string;
  tags: string[];
  feed: Feed;
  shareRequest?: boolean;
  raw: string;
  linkedTasks: LinkedTask[];
  linkedNotes: LinkedNote[];
  isDraft?: boolean;
}

const NO_FEED: Feed = { mode: "none", categories: [], tags: [], tasks: [] };

const SEED_NOTES: Note[] = [
  {
    id: "auth-sessions",
    type: "reference",
    folder: "Architecture/Auth",
    title: "Auth & sessions",
    summary:
      "How sessions, refresh rotation, and better-auth org scoping fit together.",
    author: { kind: "agent", name: "onboarding agent" },
    version: 4,
    updated: "12d",
    visibility: "team",
    agentWritable: true,
    locked: false,
    category: "Backend",
    tags: ["auth", "sessions", "security"],
    feed: NO_FEED,
    raw: `## Overview
Sessions are issued by better-auth and scoped per organization. Every request resolves an org context before touching the database; see [[Data model]] for the \`organization_id\` columns this relies on.

## Refresh rotation
Refresh tokens rotate on every use. The rotation work lands in PYZ-153 — until it ships, treat long-lived sessions as a **known gap**.

> Never read sessions outside the RLS-aware DB layer. Raw queries bypass org scoping.

## Token storage
- Access tokens live in memory only
- Refresh tokens are httpOnly cookies
- Reuse of a rotated token revokes the whole family`,
    linkedTasks: [
      { ref: "PYZ-153", kind: "mention" },
      { ref: "PYZ-145", kind: "reference", pinned: true },
    ],
    linkedNotes: [
      { title: "Data model", type: "reference", direction: "links to" },
      { title: "Version pins", type: "guidance", direction: "backlink" },
    ],
  },
  {
    id: "data-model",
    type: "reference",
    folder: "Architecture",
    title: "Data model",
    summary: "Core tables, org scoping, and the edge relations.",
    author: { kind: "human", name: "Zeynep" },
    version: 7,
    updated: "3d",
    visibility: "team",
    agentWritable: true,
    locked: false,
    category: "Database",
    tags: ["schema", "rls"],
    feed: NO_FEED,
    raw: `## Scoping
Every project-owned table carries \`organization_id\` and \`project_id\`, and all access goes through the RLS layer. See [[Auth & sessions]] for how the org context is resolved per request.

## Edge relations
Task-to-task relations live in \`task_edges\`. Notes mirror this with \`note_task_links\` and \`note_links\` — separate tables, so the task graph is never touched.

## Notes tables
- \`notes\` — markdown body is the source of truth
- \`note_task_links\` — note ↔ task, tombstoned on delete
- \`note_links\` — note ↔ note`,
    linkedTasks: [{ ref: "PYZ-201", kind: "reference" }],
    linkedNotes: [
      { title: "Auth & sessions", type: "reference", direction: "backlink" },
    ],
  },
  {
    id: "version-pins",
    type: "guidance",
    folder: "Guidance",
    title: "Version pins",
    summary: "Pinned dependency versions agents must not bump.",
    author: { kind: "human", name: "Furkan" },
    version: 3,
    updated: "1d",
    visibility: "team",
    agentWritable: false,
    locked: false,
    category: "Backend",
    tags: ["dependencies", "security"],
    feed: {
      mode: "categories",
      categories: ["Backend", "Database"],
      tags: [],
      tasks: [],
    },
    raw: `## Pinned versions
Pinned for CVE and compatibility reasons. Do not bump without an approved task.

- \`drizzle-orm\` stays at 0.45.2
- \`better-auth\` stays at 1.6.14
- \`hono\` must be >=4.12.25

> If a task needs a newer version, stop and raise it first — see PYZ-210.`,
    linkedTasks: [{ ref: "PYZ-210", kind: "mention" }],
    linkedNotes: [
      { title: "Auth & sessions", type: "reference", direction: "links to" },
    ],
  },
  {
    id: "conventions",
    type: "guidance",
    folder: "Guidance",
    title: "Code conventions",
    summary: "House style for commits, tests, and naming.",
    author: { kind: "human", name: "Zeynep" },
    version: 5,
    updated: "6d",
    visibility: "team",
    agentWritable: false,
    locked: false,
    category: "All categories",
    tags: ["style", "process"],
    feed: { mode: "all", categories: [], tags: [], tasks: [] },
    raw: `## Commits
Imperative mood, lowercase, under 72 chars. Format: \`type: short description\`.

## Tests
Every behavior change ships with a test. Run the suite before opening a PR.

> No inline comments unless the algorithm is genuinely non-obvious.`,
    linkedTasks: [],
    linkedNotes: [],
  },
  {
    id: "rls-internals",
    type: "knowledge",
    folder: "Knowledge",
    title: "RLS internals",
    summary: "How row-level security is enforced end to end — agent memory.",
    author: { kind: "agent", name: "composer agent" },
    version: 9,
    updated: "4h",
    visibility: "private",
    agentWritable: true,
    locked: false,
    category: "Database",
    tags: ["rls", "postgres", "security"],
    feed: NO_FEED,
    shareRequest: true,
    raw: `## What this is
A living map the agent maintains while working the RLS surface. Links out to [[Data model]] and the request-scope helpers.

## Enforcement path
Every query runs through the RLS-aware layer, which sets the org context per request before the statement executes.

> Learned in PYZ-145: bypassing the layer in a background job silently drops the org filter.

## Open questions
- Does the connection pool reset the org GUC between checkouts?
- Where do we test the deny path?`,
    linkedTasks: [{ ref: "PYZ-145", kind: "reference" }],
    linkedNotes: [
      { title: "Data model", type: "reference", direction: "links to" },
    ],
  },
  {
    id: "notes-feature",
    type: "reference",
    folder: "Specs",
    title: "Notes feature",
    summary: "Design rationale for project-scoped Notes.",
    author: { kind: "agent", name: "decompose agent" },
    version: 2,
    updated: "2d",
    visibility: "team",
    agentWritable: true,
    locked: true,
    category: "Product",
    tags: ["design", "notes"],
    feed: NO_FEED,
    raw: `## Thesis
Project-scoped markdown that humans and agents both write, links to tasks, and feeds the context bundle. Not a wiki — a context layer on the graph Piyaz already owns.

## Scope
The data model lands in PYZ-201, the MCP tool in PYZ-202, and bundle integration in PYZ-188. Background reading: [[Auth & sessions]].

> Deferred on purpose: drift engine, coverage scoring, graph nodes.`,
    linkedTasks: [
      { ref: "PYZ-201", kind: "spec_of" },
      { ref: "PYZ-202", kind: "spec_of" },
      { ref: "PYZ-188", kind: "spec_of" },
    ],
    linkedNotes: [
      { title: "Auth & sessions", type: "reference", direction: "links to" },
    ],
  },
];

const NOTES_BY_TITLE = new Map(SEED_NOTES.map((n) => [n.title, n]));

type TypeFilter = "all" | NoteType;
type Subview = "documents" | "task";

/** Tint a token color at a given percentage over transparent. */
function tint(color: string, pct: number): string {
  return `color-mix(in srgb, ${color} ${pct}%, transparent)`;
}

/** Parent folder path of a path, or "" for a root folder. */
function parentOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

/** Last path segment — the folder's display name. */
function leafOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

/** Derive the access level from a note's write flags. */
function accessLevel(note: Note): AccessLevel {
  if (note.locked) return "locked";
  return note.agentWritable ? "open" : "agent";
}

/** Map an access level back to the note's write flags. */
function applyAccessLevel(level: AccessLevel): Partial<Note> {
  if (level === "locked") return { agentWritable: false, locked: true };
  if (level === "agent") return { agentWritable: false, locked: false };
  return { agentWritable: true, locked: false };
}

/** Human summary of where a note auto-feeds into tasks. */
function feedSummary(feed: Feed): string {
  switch (feed.mode) {
    case "all":
      return "every task in this project";
    case "categories":
      return `tasks in ${feed.categories.join(", ") || "—"}`;
    case "tags":
      return `tasks tagged ${feed.tags.join(", ") || "—"}`;
    case "tasks":
      return `${feed.tasks.length} selected task${feed.tasks.length === 1 ? "" : "s"}`;
    default:
      return "";
  }
}

interface Block {
  kind: "h2" | "p" | "ul" | "callout" | "code";
  text?: string;
  items?: string[];
}

/**
 * Minimal markdown block parser — enough to render the prototype faithfully
 * while keeping the raw markdown as the single source of truth.
 *
 * @param raw - Markdown source.
 * @returns Ordered block list.
 */
function parseBlocks(raw: string): Block[] {
  const lines = raw.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (line.startsWith("## ")) {
      blocks.push({ kind: "h2", text: line.slice(3) });
      i++;
      continue;
    }
    if (line.startsWith("> ")) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].startsWith("> ")) {
        buf.push(lines[i].slice(2));
        i++;
      }
      blocks.push({ kind: "callout", text: buf.join(" ") });
      continue;
    }
    if (line.startsWith("```")) {
      i++;
      const buf: string[] = [];
      while (i < lines.length && !lines[i].startsWith("```")) {
        buf.push(lines[i]);
        i++;
      }
      i++;
      blocks.push({ kind: "code", text: buf.join("\n") });
      continue;
    }
    if (line.startsWith("- ")) {
      const items: string[] = [];
      while (i < lines.length && lines[i].startsWith("- ")) {
        items.push(lines[i].slice(2));
        i++;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].startsWith("## ") &&
      !lines[i].startsWith("- ") &&
      !lines[i].startsWith("> ") &&
      !lines[i].startsWith("```")
    ) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push({ kind: "p", text: buf.join(" ") });
  }
  return blocks;
}

const INLINE_RE = /(\bPYZ-\d+\b|\[\[[^\]]+\]\]|`[^`]+`|\*\*[^*]+\*\*)/g;

/**
 * Inline renderer for the signature interactions: live task chips, doc links,
 * inline code, and bold runs.
 *
 * @param text - A single block's text.
 * @returns React fragments with chips and links resolved.
 */
function renderInline(text: string) {
  return text.split(INLINE_RE).map((part, idx) => {
    const key = `${idx}-${part}`;
    if (/^PYZ-\d+$/.test(part)) return <TaskChip key={key} taskRef={part} />;
    if (/^\[\[.+\]\]$/.test(part))
      return <DocLink key={key} title={part.slice(2, -2)} />;
    if (/^`.+`$/.test(part))
      return (
        <code
          key={key}
          className="rounded px-1 py-0.5 font-mono text-[0.84em]"
          style={{
            background: "rgba(255,255,255,0.06)",
            color: "var(--color-accent-light)",
          }}
        >
          {part.slice(1, -1)}
        </code>
      );
    if (/^\*\*.+\*\*$/.test(part))
      return (
        <strong
          key={key}
          style={{ color: "var(--color-text-primary)", fontWeight: 600 }}
        >
          {part.slice(2, -2)}
        </strong>
      );
    return <Fragment key={key}>{part}</Fragment>;
  });
}

interface TaskChipProps {
  taskRef: string;
}

/** Inline task-ref chip — status conveyed by chip color; clickable to open. */
function TaskChip({ taskRef }: TaskChipProps) {
  const nav = useContext(NavContext);
  const task = TASKS[taskRef];
  const color = task ? STATUS_META[task.status].cssVar : "var(--color-danger)";
  const tip = task
    ? `${STATUS_META[task.status].label} · ${task.title}`
    : "Unknown task";
  const cls =
    "inline-flex items-center rounded px-1.5 align-baseline font-mono text-[0.82em]";
  const style = {
    color,
    background: tint(color, 12),
    border: `1px solid ${tint(color, 30)}`,
  };
  if (nav) {
    return (
      <button
        type="button"
        title={tip}
        onClick={(e) => {
          e.stopPropagation();
          nav.onTask(taskRef);
        }}
        className={`${cls} cursor-pointer`}
        style={style}
      >
        {taskRef}
      </button>
    );
  }
  return (
    <span title={tip} className={cls} style={style}>
      {taskRef}
    </span>
  );
}

interface DocLinkProps {
  title: string;
}

/** Inline `[[note]]` link — colored by the target note's type; clickable to open. */
function DocLink({ title }: DocLinkProps) {
  const nav = useContext(NavContext);
  const target = NOTES_BY_TITLE.get(title);
  if (!target) {
    return (
      <span style={{ color: "var(--color-danger)" }} title="Unresolved link">
        [[{title}]]
      </span>
    );
  }
  const color = NOTE_TYPE_META[target.type].color;
  const style = { color, borderBottom: `1px solid ${tint(color, 42)}` };
  const tip = `${NOTE_TYPE_META[target.type].label} · ${target.title}`;
  if (nav) {
    return (
      <button
        type="button"
        title={tip}
        onClick={(e) => {
          e.stopPropagation();
          nav.onNote(title);
        }}
        className="cursor-pointer bg-transparent p-0 align-baseline"
        style={style}
      >
        {title}
      </button>
    );
  }
  return (
    <span style={{ ...style, cursor: "pointer" }} title={tip}>
      {title}
    </span>
  );
}

/**
 * Piyaz Notes — non-functional UI prototype.
 *
 * @returns The full Notes frame: top bar, primary view tabs, and the
 *   three-pane Notes experience (or the task-detail integration showcase).
 */
export function NotesPrototype() {
  const [light, setLight] = useState(false);
  const [notes, setNotes] = useState<Note[]>(SEED_NOTES);
  const [extraFolders, setExtraFolders] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState("auth-sessions");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [query, setQuery] = useState("");
  const [subview, setSubview] = useState<Subview>("documents");
  const [activeView, setActiveView] = useState("notes");
  const [activeTask, setActiveTask] = useState("PYZ-153");
  const [draftSeq, setDraftSeq] = useState(1);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("light", light);
    return () => root.classList.remove("light");
  }, [light]);

  const selected = notes.find((n) => n.id === selectedId) ?? notes[0];

  const allFolders = useMemo(() => {
    const set = new Set<string>(extraFolders);
    for (const n of notes) if (n.folder) set.add(n.folder);
    for (const f of [...set]) {
      const parts = f.split("/");
      let acc = "";
      for (const p of parts) {
        acc = acc ? `${acc}/${p}` : p;
        set.add(acc);
      }
    }
    return [...set].sort();
  }, [notes, extraFolders]);

  const visibleNotes = useMemo(() => {
    const q = query.trim().toLowerCase();
    return notes.filter((n) => {
      if (typeFilter !== "all" && n.type !== typeFilter) return false;
      if (!q) return true;
      return (
        n.title.toLowerCase().includes(q) ||
        n.raw.toLowerCase().includes(q) ||
        n.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [notes, typeFilter, query]);

  /** Patch a single note in place. */
  function patchNote(id: string, partial: Partial<Note>) {
    setNotes((ns) => ns.map((n) => (n.id === id ? { ...n, ...partial } : n)));
  }

  /** Move a note into a folder (drag-and-drop target). */
  function moveNote(id: string, folder: string) {
    patchNote(id, { folder });
  }

  /** Re-parent a folder and its whole subtree under a destination folder. */
  function moveFolder(src: string, destParent: string) {
    if (destParent === src || destParent.startsWith(`${src}/`)) return;
    const dest = destParent ? `${destParent}/${leafOf(src)}` : leafOf(src);
    if (dest === src) return;
    setNotes((ns) =>
      ns.map((n) =>
        n.folder === src || n.folder.startsWith(`${src}/`)
          ? { ...n, folder: dest + n.folder.slice(src.length) }
          : n,
      ),
    );
    setExtraFolders((fs) =>
      fs.map((f) =>
        f === src || f.startsWith(`${src}/`) ? dest + f.slice(src.length) : f,
      ),
    );
  }

  /** Create a draft note in Drafts and open it inline, ready to edit. */
  function handleNewNote() {
    const id = `draft-${draftSeq}`;
    setDraftSeq((s) => s + 1);
    const draft: Note = {
      id,
      type: "reference",
      folder: "Drafts",
      title: "",
      summary: "",
      author: { kind: "human", name: "Zeynep" },
      version: 1,
      updated: "now",
      visibility: "private",
      agentWritable: true,
      locked: false,
      category: "Backend",
      tags: [],
      feed: { mode: "none", categories: [], tags: [], tasks: [] },
      raw: "## Overview\n",
      linkedTasks: [],
      linkedNotes: [],
      isDraft: true,
    };
    setNotes((ns) => [draft, ...ns]);
    setExtraFolders((f) => (f.includes("Drafts") ? f : ["Drafts", ...f]));
    setSelectedId(id);
  }

  /** Create a uniquely-named empty root folder. */
  function handleNewFolder() {
    const existing = new Set(allFolders);
    let name = "New folder";
    let i = 2;
    while (existing.has(name)) name = `New folder ${i++}`;
    setExtraFolders((f) => [...f, name]);
  }

  return (
    <div
      className="flex flex-col"
      style={{
        height: "100vh",
        background: "var(--color-base)",
        color: "var(--color-text-primary)",
      }}
    >
      <TopBar
        light={light}
        onToggleTheme={() => setLight((v) => !v)}
        activeView={activeView}
        onView={setActiveView}
      />

      <div className="min-h-0 flex-1">
        {subview === "documents" ? (
          <div className="flex h-full">
            <TreePane
              notes={visibleNotes}
              allFolders={allFolders}
              selectedId={selected.id}
              typeFilter={typeFilter}
              query={query}
              onQuery={setQuery}
              onSelect={setSelectedId}
              onTypeFilter={setTypeFilter}
              onNewNote={handleNewNote}
              onNewFolder={handleNewFolder}
              onMoveNote={moveNote}
              onMoveFolder={moveFolder}
            />
            <EditorPane
              note={selected}
              onPatch={(partial) => patchNote(selected.id, partial)}
              onSelectNote={setSelectedId}
              onSelectTask={(ref) => {
                setActiveTask(ref);
                setSubview("task");
              }}
            />
            <SettingsPane
              note={selected}
              onPatch={(partial) => patchNote(selected.id, partial)}
              onSelectNote={setSelectedId}
            />
          </div>
        ) : (
          <TaskDetailShowcase
            taskRef={activeTask}
            onSelectNote={(id) => {
              setSelectedId(id);
              setSubview("documents");
            }}
          />
        )}
      </div>

      <SubviewBar subview={subview} onChange={setSubview} />
    </div>
  );
}

interface TopBarProps {
  light: boolean;
  onToggleTheme: () => void;
  activeView: string;
  onView: (id: string) => void;
}

/** App top bar — project title, always-visible view switcher, theme toggle. */
function TopBar({ light, onToggleTheme, activeView, onView }: TopBarProps) {
  return (
    <div
      className="flex shrink-0 items-center gap-3 px-4"
      style={{
        height: 44,
        borderBottom: "1px solid var(--color-border)",
        background: "var(--color-base-2)",
      }}
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="inline-block"
          style={{
            width: 14,
            height: 14,
            borderRadius: 4,
            background: "var(--color-accent-grad)",
          }}
        />
        <span className="text-[13px] font-semibold">Piyaz Platform</span>
        <span
          className="ml-1 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium"
          style={{
            color: "var(--color-done)",
            background: "var(--color-done-bg)",
          }}
        >
          <span
            style={{
              width: 5,
              height: 5,
              borderRadius: 999,
              background: "var(--color-done)",
            }}
          />
          ACTIVE
        </span>
      </div>

      <ViewSwitcher active={activeView} onChange={onView} />

      <button
        type="button"
        onClick={onToggleTheme}
        aria-label="Toggle theme"
        className="ml-auto inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-text-muted hover:bg-surface-hover hover:text-text-primary"
      >
        {light ? <IconMoon size={14} /> : <IconSun size={14} />}
      </button>
    </div>
  );
}

interface ViewSwitcherProps {
  active: string;
  onChange: (id: string) => void;
}

/** Compact segmented project view switcher — Structure / Graph / Notes. */
function ViewSwitcher({ active, onChange }: ViewSwitcherProps) {
  const tabs = [
    { id: "structure", label: "Structure", icon: <IconList size={13} /> },
    { id: "graph", label: "Graph", icon: <IconGraph size={13} /> },
    { id: "notes", label: "Notes", icon: <IconDoc size={13} /> },
  ];
  return (
    <div
      className="inline-flex items-center gap-0.5 rounded-md p-0.5"
      style={{
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
      }}
    >
      {tabs.map((t) => {
        const on = t.id === active;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onChange(t.id)}
            className="inline-flex h-6 cursor-pointer items-center gap-1.5 rounded px-2 text-[12px]"
            style={{
              fontWeight: on ? 600 : 500,
              color: on
                ? "var(--color-text-primary)"
                : "var(--color-text-muted)",
              background: on ? "var(--color-surface-hover)" : "transparent",
            }}
          >
            <span
              style={{
                display: "inline-flex",
                color: on ? "var(--color-accent-light)" : "currentColor",
              }}
            >
              {t.icon}
            </span>
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

interface SubviewBarProps {
  subview: Subview;
  onChange: (s: Subview) => void;
}

/**
 * Prototype-only secondary strip to showcase the task-detail integration in
 * isolation. In the real app, "Mentioned in notes" merges into DetailView.
 */
function SubviewBar({ subview, onChange }: SubviewBarProps) {
  const tabs: { id: Subview; label: string }[] = [
    { id: "documents", label: "Documents" },
    { id: "task", label: "Task detail (showcase)" },
  ];
  return (
    <div
      className="flex shrink-0 items-center gap-1.5 px-4"
      style={{
        height: 38,
        borderTop: "1px solid var(--color-border)",
        background: "var(--color-base-2)",
      }}
    >
      <span className="mr-1 font-mono text-[10px] uppercase tracking-wider text-text-faint">
        prototype
      </span>
      {tabs.map((t) => {
        const active = subview === t.id;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onChange(t.id)}
            className="cursor-pointer rounded-full px-2.5 py-1 text-[11px]"
            style={{
              fontWeight: active ? 600 : 500,
              color: active
                ? "var(--color-text-primary)"
                : "var(--color-text-muted)",
              background: active ? "var(--color-surface-hover)" : "transparent",
              border: active
                ? "1px solid var(--color-border)"
                : "1px solid transparent",
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

interface TreePaneProps {
  notes: Note[];
  allFolders: string[];
  selectedId: string;
  typeFilter: TypeFilter;
  query: string;
  onQuery: (q: string) => void;
  onSelect: (id: string) => void;
  onTypeFilter: (t: TypeFilter) => void;
  onNewNote: () => void;
  onNewFolder: () => void;
  onMoveNote: (id: string, folder: string) => void;
  onMoveFolder: (src: string, destParent: string) => void;
}

type DragItem = { kind: "note" | "folder"; id: string };

/** Left pane — searchable nested folder tree with drag-and-drop and inline actions. */
function TreePane({
  notes,
  allFolders,
  selectedId,
  typeFilter,
  query,
  onQuery,
  onSelect,
  onTypeFilter,
  onNewNote,
  onNewFolder,
  onMoveNote,
  onMoveFolder,
}: TreePaneProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<DragItem | null>(null);
  const [dropFolder, setDropFolder] = useState<string | null>(null);
  const chips: TypeFilter[] = ["all", "reference", "guidance", "knowledge"];

  /** Toggle a folder's collapsed state. */
  function toggle(path: string) {
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  /** Complete a drop onto a folder, moving the dragged note or folder. */
  function dropOnto(path: string) {
    if (drag?.kind === "note") onMoveNote(drag.id, path);
    else if (drag?.kind === "folder") onMoveFolder(drag.id, path);
    setDrag(null);
    setDropFolder(null);
  }

  /**
   * Recursively render a folder, its child folders, and its notes.
   *
   * @param path - Folder path.
   * @param depth - Nesting depth, drives indentation.
   * @returns The folder branch.
   */
  function renderFolder(path: string, depth: number): React.ReactNode {
    const folderNotes = notes.filter((n) => n.folder === path);
    const subFolders = allFolders.filter((f) => parentOf(f) === path);
    if (
      query.trim() &&
      folderNotes.length === 0 &&
      subFolders.every((s) => notes.filter((n) => n.folder === s).length === 0)
    ) {
      return null;
    }
    const isCollapsed = collapsed.has(path);
    const isDropTarget = dropFolder === path;
    const indent = 8 + depth * 12;
    return (
      <div key={path}>
        <button
          type="button"
          draggable
          onClick={() => toggle(path)}
          onDragStart={(e) => {
            e.stopPropagation();
            setDrag({ kind: "folder", id: path });
          }}
          onDragEnd={() => {
            setDrag(null);
            setDropFolder(null);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDropFolder(path);
          }}
          onDrop={(e) => {
            e.preventDefault();
            dropOnto(path);
          }}
          className="group flex w-full items-center gap-1 rounded-md pr-2 text-left text-text-secondary"
          style={{
            height: 26,
            paddingLeft: indent,
            opacity: drag?.kind === "folder" && drag.id === path ? 0.45 : 1,
            background: isDropTarget
              ? tint("var(--color-accent)", 14)
              : "transparent",
            outline: isDropTarget
              ? "1px solid var(--color-accent)"
              : "1px solid transparent",
          }}
        >
          {isCollapsed ? (
            <IconChevronRight size={11} className="text-text-muted" />
          ) : (
            <IconChevronDown size={11} className="text-text-muted" />
          )}
          <span className="text-[12px] font-semibold">{leafOf(path)}</span>
          <span className="ml-auto font-mono text-[10px] text-text-faint">
            {folderNotes.length}
          </span>
        </button>
        {!isCollapsed && (
          <>
            {subFolders.map((s) => renderFolder(s, depth + 1))}
            {folderNotes.map((n) => {
              const active = n.id === selectedId;
              const color = NOTE_TYPE_META[n.type].color;
              const dragging = drag?.kind === "note" && drag.id === n.id;
              return (
                <button
                  key={n.id}
                  type="button"
                  draggable
                  onDragStart={() => setDrag({ kind: "note", id: n.id })}
                  onDragEnd={() => {
                    setDrag(null);
                    setDropFolder(null);
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDropFolder(n.folder);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    dropOnto(n.folder);
                  }}
                  onClick={() => onSelect(n.id)}
                  className="group relative flex w-full cursor-pointer items-center gap-2 rounded-md pr-2 text-left"
                  style={{
                    height: 30,
                    paddingLeft: indent + 16,
                    opacity: dragging ? 0.45 : 1,
                    background: active
                      ? tint("var(--color-accent)", 7)
                      : "transparent",
                  }}
                >
                  {active && (
                    <span
                      aria-hidden="true"
                      style={{
                        position: "absolute",
                        left: 4,
                        top: 5,
                        bottom: 5,
                        width: 2,
                        borderRadius: 2,
                        background: color,
                      }}
                    />
                  )}
                  <span className="text-text-faint opacity-0 group-hover:opacity-100">
                    <IconGrip size={11} />
                  </span>
                  <IconDoc size={13} style={{ color }} />
                  <span
                    className="min-w-0 flex-1 truncate text-[12.5px]"
                    style={{
                      fontWeight: active ? 600 : 500,
                      fontStyle: n.title ? "normal" : "italic",
                      color: active
                        ? "var(--color-text-primary)"
                        : n.title
                          ? "var(--color-text-secondary)"
                          : "var(--color-text-faint)",
                    }}
                  >
                    {n.title || "Untitled"}
                  </span>
                  {n.visibility === "private" && (
                    <IconUser size={10} className="text-text-faint" />
                  )}
                  {!n.agentWritable && (
                    <IconLock size={10} className="text-text-faint" />
                  )}
                </button>
              );
            })}
          </>
        )}
      </div>
    );
  }

  const roots = allFolders.filter((f) => parentOf(f) === "");

  return (
    <div
      className="flex shrink-0 flex-col"
      style={{
        width: 266,
        background: "var(--color-base-2)",
        borderRight: "1px solid var(--color-border)",
      }}
    >
      <div
        className="flex items-center justify-between px-3"
        style={{ height: 40 }}
      >
        <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          Notes · {notes.length}
        </span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={onNewFolder}
            aria-label="New folder"
            title="New folder"
            className="inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded text-text-muted hover:bg-surface-hover hover:text-text-primary"
          >
            <IconFolderPlus size={13} />
          </button>
          <button
            type="button"
            onClick={onNewNote}
            aria-label="New note"
            title="New note"
            className="inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded text-text-muted hover:bg-surface-hover hover:text-text-primary"
          >
            <IconPlus size={13} />
          </button>
        </div>
      </div>

      <div className="px-3 pb-2">
        <div
          className="flex items-center gap-1.5 rounded-md px-2"
          style={{
            height: 28,
            border: "1px solid var(--color-border)",
            background: "var(--color-surface)",
          }}
        >
          <IconSearch size={12} className="text-text-faint" />
          <input
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Search notes…"
            className="w-full bg-transparent font-mono text-[11.5px] outline-none placeholder:text-text-faint"
            style={{ color: "var(--color-text-secondary)" }}
          />
        </div>
        <p className="mt-1 px-0.5 font-mono text-[9.5px] text-text-faint">
          Same index agents query via piyaz_note search
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5 px-3 pb-2">
        {chips.map((c) => {
          const active = typeFilter === c;
          const color =
            c === "all" ? "var(--color-accent)" : NOTE_TYPE_META[c].color;
          const labelColor =
            c === "all" && !active ? "var(--color-text-muted)" : color;
          return (
            <button
              key={c}
              type="button"
              onClick={() => onTypeFilter(c)}
              className="inline-flex cursor-pointer items-center rounded-full px-2 py-0.5 font-mono text-[10px] uppercase"
              style={{
                color: labelColor,
                background: active ? tint(color, 13) : "transparent",
                border: `1px solid ${active ? tint(color, 30) : "var(--color-border)"}`,
              }}
            >
              {c === "all" ? "All" : NOTE_TYPE_META[c].label}
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {roots.map((r) => renderFolder(r, 0))}
      </div>
    </div>
  );
}

interface EditorPaneProps {
  note: Note;
  onPatch: (partial: Partial<Note>) => void;
  onSelectNote: (id: string) => void;
  onSelectTask: (ref: string) => void;
}

/** Center pane — note header, meta, feed notice, and the live (click-to-edit) editor. */
function EditorPane({
  note,
  onPatch,
  onSelectNote,
  onSelectTask,
}: EditorPaneProps) {
  const meta = NOTE_TYPE_META[note.type];

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto"
      style={{ background: "var(--color-base)" }}
    >
      <div
        className="mx-auto"
        style={{ maxWidth: 760, padding: "28px 34px 64px" }}
      >
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <MonoId id={note.id.toUpperCase()} copyable={false} />
          <span
            className="inline-flex items-center rounded-full px-2 py-0.5 font-mono text-[10px] uppercase"
            style={{
              color: meta.color,
              background: tint(meta.color, 13),
              border: `1px solid ${tint(meta.color, 26)}`,
            }}
          >
            {meta.label}
          </span>
          <span
            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px] uppercase"
            style={{
              color:
                note.visibility === "team"
                  ? "var(--color-done)"
                  : "var(--color-text-muted)",
              background:
                note.visibility === "team"
                  ? "var(--color-done-bg)"
                  : "var(--color-surface-hover)",
              border: "1px solid var(--color-border)",
            }}
          >
            {note.visibility === "team" ? (
              <IconUsers size={10} />
            ) : (
              <IconUser size={10} />
            )}
            {note.visibility}
          </span>
          {note.locked && (
            <span
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px] uppercase"
              style={{
                color: "var(--color-danger)",
                background: tint("var(--color-danger)", 12),
                border: `1px solid ${tint("var(--color-danger)", 30)}`,
              }}
            >
              <IconLock size={10} /> locked
            </span>
          )}
          {!note.agentWritable && (
            <span
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px] uppercase"
              style={{
                color: "var(--color-glyph-review)",
                background: tint("var(--color-glyph-review)", 12),
                border: `1px solid ${tint("var(--color-glyph-review)", 30)}`,
              }}
            >
              <IconAgent size={10} /> agent read-only
            </span>
          )}
          {note.locked && (
            <span className="ml-auto font-mono text-[10px] text-text-faint">
              locked — unlock to edit
            </span>
          )}
        </div>

        <input
          value={note.title}
          onChange={(e) => onPatch({ title: e.target.value })}
          readOnly={note.locked}
          placeholder="Untitled note"
          className="mb-2.5 w-full bg-transparent outline-none placeholder:text-text-faint"
          style={{
            fontSize: 24,
            fontWeight: 600,
            letterSpacing: "-0.01em",
            color: "var(--color-text-primary)",
          }}
        />

        <div className="mb-5 flex flex-wrap items-center gap-1.5 text-[11px] text-text-muted">
          <AuthorBadge author={note.author} />
          <span>
            updated by {note.author.name} · {note.updated} ago
          </span>
        </div>

        {note.feed.mode !== "none" && (
          <Banner color={meta.color} icon={<IconBundle size={13} />}>
            <strong
              style={{ color: "var(--color-text-primary)", fontWeight: 600 }}
            >
              Auto-fed
            </strong>{" "}
            into {feedSummary(note.feed)}.
          </Banner>
        )}

        <NavContext.Provider
          value={{ onNote: onSelectNote, onTask: onSelectTask }}
        >
          <LiveEditor note={note} onPatch={onPatch} editable={!note.locked} />
        </NavContext.Provider>
      </div>
    </div>
  );
}

interface LiveEditorProps {
  note: Note;
  onPatch: (partial: Partial<Note>) => void;
  editable: boolean;
}

/**
 * Obsidian Live Preview-style editor — blocks render styled, and clicking one
 * turns it into a seamless inline field (no box) over its raw markdown,
 * matched to the block's own typography, until blur or Escape.
 *
 * @param note - Active note (raw markdown is the source of truth).
 * @param onPatch - Commits the rebuilt raw markdown.
 * @param editable - When false (locked note), blocks render read-only.
 */
function LiveEditor({ note, onPatch, editable }: LiveEditorProps) {
  const chunks = useMemo(
    () => note.raw.split(/\n{2,}/).filter((c) => c.length > 0),
    [note.raw],
  );
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [draft, setDraft] = useState("");

  /** Enter edit mode for a block, seeding the draft from current raw. */
  function startEdit(i: number) {
    setDraft(chunks[i] ?? "");
    setEditingIdx(i);
  }

  /** Commit the draft back into the note's raw markdown. */
  function commit(i: number) {
    const next = [...chunks];
    next[i] = draft;
    onPatch({ raw: next.filter((c) => c.trim() !== "").join("\n\n") });
    setEditingIdx(null);
  }

  /** Append an empty block and open it for editing. */
  function addBlock() {
    const next = [...chunks, ""];
    onPatch({ raw: next.join("\n\n") });
    setDraft("");
    setEditingIdx(next.length - 1);
  }

  if (!editable) {
    return (
      <div
        className="prose-spec"
        style={{ fontSize: 13.5, color: "var(--color-text-secondary)" }}
      >
        {chunks.map((chunk, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: stable block order
          <div key={i}>
            {parseBlocks(chunk).map((b, bi) => (
              <BlockView key={bi} block={b} />
            ))}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div
      className="prose-spec"
      style={{ fontSize: 13.5, color: "var(--color-text-secondary)" }}
    >
      {chunks.map((chunk, i) => {
        if (editingIdx === i) {
          return (
            <BlockEditor
              // biome-ignore lint/suspicious/noArrayIndexKey: stable block order
              key={i}
              value={draft}
              heading={draft.trimStart().startsWith("## ")}
              onChange={setDraft}
              onCommit={() => commit(i)}
            />
          );
        }
        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: click-to-edit block; inner links stop propagation
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: stable block order
            key={i}
            tabIndex={0}
            onClick={() => startEdit(i)}
            onKeyDown={(e) => {
              if (e.key === "Enter") startEdit(i);
            }}
            className="block w-full cursor-text"
          >
            {parseBlocks(chunk).map((b, bi) => (
              <BlockView key={bi} block={b} />
            ))}
          </div>
        );
      })}

      <button
        type="button"
        onClick={addBlock}
        className="mt-2 flex w-full cursor-text items-center gap-2 rounded-md py-1.5 text-left font-mono text-[11.5px] text-text-faint hover:text-text-muted"
      >
        <IconPlus size={12} />
        Add a block… <span className="text-text-muted">[[</span> links a note or
        task
      </button>
    </div>
  );
}

interface BlockEditorProps {
  value: string;
  heading: boolean;
  onChange: (value: string) => void;
  onCommit: () => void;
}

/**
 * Seamless inline block editor — a borderless textarea that wraps long lines
 * and auto-grows to fit its content, matched to the block's typography.
 *
 * @param value - Draft markdown for the block.
 * @param heading - Whether the block renders as a heading (drives type scale).
 * @param onChange - Draft change handler.
 * @param onCommit - Commit on blur or Escape.
 */
function BlockEditor({ value, heading, onChange, onCommit }: BlockEditorProps) {
  return (
    <AutoGrowTextarea
      autoFocus
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCommit();
      }}
      className="block w-full bg-transparent outline-none"
      style={{
        fontFamily: "inherit",
        border: "none",
        padding: 0,
        resize: "none",
        maxHeight: 1200,
        margin: heading ? "18px 0 6px" : "0 0 10px",
        fontSize: heading ? 15 : 13.5,
        fontWeight: heading ? 600 : 400,
        lineHeight: 1.62,
        color: heading
          ? "var(--color-text-primary)"
          : "var(--color-text-secondary)",
        caretColor: "var(--color-accent)",
      }}
    />
  );
}

interface BlockViewProps {
  block: Block;
}

/** Render one parsed markdown block with inline chips resolved. */
function BlockView({ block }: BlockViewProps) {
  if (block.kind === "h2")
    return (
      <h2
        style={{
          fontSize: 15,
          fontWeight: 600,
          color: "var(--color-text-primary)",
          margin: "18px 0 6px",
        }}
      >
        {block.text}
      </h2>
    );
  if (block.kind === "ul")
    return (
      <ul
        style={{ margin: "6px 0", paddingLeft: "1.3em", listStyleType: "disc" }}
      >
        {block.items!.map((it, i) => (
          <li key={i} style={{ margin: "3px 0", lineHeight: 1.6 }}>
            {renderInline(it)}
          </li>
        ))}
      </ul>
    );
  if (block.kind === "callout")
    return (
      <blockquote
        style={{
          borderLeft: "2px solid var(--color-accent)",
          background: "var(--color-accent-grad-soft)",
          padding: "8px 12px",
          borderRadius: 6,
          margin: "10px 0",
          lineHeight: 1.6,
        }}
      >
        {renderInline(block.text!)}
      </blockquote>
    );
  if (block.kind === "code")
    return (
      <pre
        style={{
          background: "rgba(0,0,0,0.35)",
          border: "1px solid var(--color-border)",
          borderRadius: 8,
          padding: "10px 12px",
          margin: "10px 0",
          overflowX: "auto",
        }}
      >
        <code
          className="font-mono text-[12px]"
          style={{ color: "var(--color-text-secondary)" }}
        >
          {block.text}
        </code>
      </pre>
    );
  return (
    <p style={{ margin: "0 0 10px", lineHeight: 1.62 }}>
      {renderInline(block.text!)}
    </p>
  );
}

interface AuthorBadgeProps {
  author: Note["author"];
}

/** 18px author badge — gradient AI mark for agents, initials for humans. */
function AuthorBadge({ author }: AuthorBadgeProps) {
  const isAgent = author.kind === "agent";
  return (
    <span
      aria-hidden="true"
      className="inline-flex items-center justify-center font-mono text-[8.5px] font-semibold"
      style={{
        width: 18,
        height: 18,
        borderRadius: 5,
        color: isAgent ? "#0b0c10" : "var(--color-text-primary)",
        background: isAgent
          ? "var(--color-accent-grad)"
          : "var(--color-surface-hover)",
        border: isAgent ? "none" : "1px solid var(--color-border-strong)",
      }}
    >
      {isAgent ? "AI" : author.name.slice(0, 2).toUpperCase()}
    </span>
  );
}

interface BannerProps {
  color: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}

/** Type-tinted inline banner for feed / planning-depth notices. */
function Banner({ color, icon, children }: BannerProps) {
  return (
    <div
      className="mb-4 flex items-start gap-2 rounded-lg px-3 py-2 text-[12px] leading-relaxed"
      style={{
        background: tint(color, 8),
        border: `1px solid ${tint(color, 32)}`,
        color: "var(--color-text-secondary)",
      }}
    >
      <span style={{ color, marginTop: 1 }}>{icon}</span>
      <span>{children}</span>
    </div>
  );
}

interface SettingsPaneProps {
  note: Note;
  onPatch: (partial: Partial<Note>) => void;
  onSelectNote: (id: string) => void;
}

/**
 * Right ribbon — split into what the note IS (type, visibility, write access,
 * classification) versus where it GOES (auto-feed targeting), then derived
 * mentions and linked notes.
 */
function SettingsPane({ note, onPatch, onSelectNote }: SettingsPaneProps) {
  const meta = NOTE_TYPE_META[note.type];

  return (
    <div
      className="min-h-0 shrink-0 overflow-y-auto"
      style={{
        width: 320,
        background: "var(--color-base)",
        borderLeft: "1px solid var(--color-border)",
      }}
    >
      <div className="p-4">
        <Section label="Settings">
          <FieldLabel>Type</FieldLabel>
          <div className="mb-3 grid grid-cols-3 gap-1.5">
            {(["reference", "guidance", "knowledge"] as NoteType[]).map((t) => {
              const m = NOTE_TYPE_META[t];
              const active = note.type === t;
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => onPatch({ type: t })}
                  title={m.blurb}
                  className="flex cursor-pointer items-center justify-center rounded-md py-1.5 font-mono text-[10px] uppercase"
                  style={{
                    color: m.color,
                    background: active ? tint(m.color, 13) : "transparent",
                    border: `1px solid ${active ? tint(m.color, 36) : "var(--color-border)"}`,
                  }}
                >
                  {m.label}
                </button>
              );
            })}
          </div>
          <p className="mb-3 text-[11px] leading-snug text-text-muted">
            {meta.blurb} {meta.rule}
          </p>

          <FieldLabel>Visibility</FieldLabel>
          <div className="mb-2 grid grid-cols-2 gap-1.5">
            {(["private", "team"] as Visibility[]).map((v) => {
              const active = note.visibility === v;
              const color =
                v === "team" ? "var(--color-done)" : "var(--color-accent)";
              return (
                <button
                  key={v}
                  type="button"
                  onClick={() => onPatch({ visibility: v })}
                  className="flex cursor-pointer items-center justify-center gap-1.5 rounded-md py-1.5 text-[11px] font-medium capitalize"
                  style={{
                    color: active ? color : "var(--color-text-muted)",
                    background: active ? tint(color, 12) : "transparent",
                    border: `1px solid ${active ? tint(color, 34) : "var(--color-border)"}`,
                  }}
                >
                  {v === "team" ? (
                    <IconUsers size={12} />
                  ) : (
                    <IconUser size={12} />
                  )}
                  {v === "team" ? "Team" : "Private"}
                </button>
              );
            })}
          </div>

          {note.shareRequest && note.visibility === "private" && (
            <div
              className="mb-3 rounded-lg p-2.5"
              style={{
                background: "var(--color-accent-grad-soft)",
                border: `1px solid ${tint("var(--color-accent)", 34)}`,
              }}
            >
              <div className="mb-1.5 flex items-center gap-1.5 text-[11px]">
                <AuthorBadge author={{ kind: "agent", name: "agent" }} />
                <span className="text-text-secondary">
                  An agent asked to share this with the team.
                </span>
              </div>
              <div className="flex gap-1.5">
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() =>
                    onPatch({ visibility: "team", shareRequest: false })
                  }
                >
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onPatch({ shareRequest: false })}
                >
                  Keep private
                </Button>
              </div>
            </div>
          )}

          <FieldLabel>Access</FieldLabel>
          <AccessSlider
            level={accessLevel(note)}
            onChange={(lvl) => onPatch(applyAccessLevel(lvl))}
          />
        </Section>

        <Section label="Classification">
          <p className="mb-2 text-[11px] leading-snug text-text-muted">
            What this note is. Shares the project’s categories and tags.
          </p>
          <FieldLabel>Category</FieldLabel>
          <div className="mb-3">
            <Dropdown
              value={note.category}
              options={CATEGORIES.map((c) => ({ value: c, label: c }))}
              onChange={(v) => onPatch({ category: v })}
              ariaLabel="Category"
              renderTrigger={(opt, open) => (
                <ChipTrigger icon={<IconTag size={11} />} open={open}>
                  {opt?.label ?? "Uncategorized"}
                </ChipTrigger>
              )}
            />
          </div>

          <FieldLabel>Tags</FieldLabel>
          <TagEditor
            tags={note.tags}
            onAdd={(t) => onPatch({ tags: [...note.tags, t] })}
            onRemove={(t) =>
              onPatch({ tags: note.tags.filter((x) => x !== t) })
            }
          />
        </Section>

        <Section label="Auto-feed into tasks">
          <p className="mb-2 text-[11px] leading-snug text-text-muted">
            Controls whether agents can see this note. Off hides it entirely —
            agents can’t discover or fetch it. Any other option mentions it in
            the agent’s MCP prompt for the chosen scope.
          </p>
          <FeedEditor feed={note.feed} onChange={(feed) => onPatch({ feed })} />
        </Section>

        <Section label="Mentions">
          <p className="mb-1.5 text-[11px] leading-snug text-text-muted">
            Tasks referenced in the body — backlinks, not targeting.
          </p>
          {note.linkedTasks.length === 0 && (
            <div className="py-0.5 text-[12px] text-text-faint">None</div>
          )}
          {note.linkedTasks.map((lt) => {
            const task = TASKS[lt.ref];
            return (
              <div key={lt.ref} className="flex items-center gap-2 py-1">
                <MonoId
                  id={lt.ref}
                  copyable={false}
                  tone={(task?.status ?? "draft") as never}
                />
                <span className="min-w-0 flex-1 truncate text-[11.5px] text-text-secondary">
                  {task?.title ?? "unresolved"}
                </span>
                {lt.pinned && (
                  <IconLock size={11} className="text-text-muted" />
                )}
              </div>
            );
          })}
        </Section>

        <Section label="Linked notes">
          {note.linkedNotes.length === 0 && (
            <div className="py-0.5 text-[12px] text-text-faint">None</div>
          )}
          {note.linkedNotes.map((ln) => {
            const target = NOTES_BY_TITLE.get(ln.title);
            const color = NOTE_TYPE_META[ln.type].color;
            return (
              <button
                key={ln.title + ln.direction}
                type="button"
                onClick={() => target && onSelectNote(target.id)}
                className="flex w-full cursor-pointer items-center gap-2 py-1 text-left"
              >
                <IconDoc size={13} style={{ color }} />
                <span className="min-w-0 flex-1 truncate text-[11.5px] text-text-secondary">
                  {ln.title}
                </span>
                <span className="font-mono text-[9.5px] text-text-faint">
                  {ln.direction}
                </span>
              </button>
            );
          })}
        </Section>
      </div>
    </div>
  );
}

interface FeedEditorProps {
  feed: Feed;
  onChange: (feed: Feed) => void;
}

/** Auto-feed targeting editor — mode selector plus the matching target picker. */
function FeedEditor({ feed, onChange }: FeedEditorProps) {
  const modes: { id: FeedMode; label: string }[] = [
    { id: "none", label: "Off" },
    { id: "all", label: "All" },
    { id: "categories", label: "By category" },
    { id: "tags", label: "By tag" },
    { id: "tasks", label: "By task" },
  ];

  /** Toggle membership of a value within a feed target list. */
  function toggleIn(key: "categories" | "tags" | "tasks", value: string) {
    const set = new Set(feed[key]);
    if (set.has(value)) set.delete(value);
    else set.add(value);
    onChange({ ...feed, [key]: [...set] });
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {modes.map((m) => {
          const active = feed.mode === m.id;
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => onChange({ ...feed, mode: m.id })}
              className="cursor-pointer rounded-full px-2 py-0.5 text-[11px]"
              style={{
                color: active
                  ? "var(--color-accent-light)"
                  : "var(--color-text-muted)",
                background: active
                  ? tint("var(--color-accent)", 13)
                  : "transparent",
                border: `1px solid ${active ? tint("var(--color-accent)", 32) : "var(--color-border)"}`,
              }}
            >
              {m.label}
            </button>
          );
        })}
      </div>

      {feed.mode === "categories" && (
        <div className="flex flex-wrap gap-1.5">
          {CATEGORIES.filter((c) => c !== "All categories").map((c) => (
            <ChipToggle
              key={c}
              label={c}
              active={feed.categories.includes(c)}
              onClick={() => toggleIn("categories", c)}
            />
          ))}
        </div>
      )}
      {feed.mode === "tags" && (
        <div className="flex flex-wrap gap-1.5">
          {PROJECT_TAGS.map((t) => (
            <ChipToggle
              key={t}
              label={t}
              active={feed.tags.includes(t)}
              onClick={() => toggleIn("tags", t)}
            />
          ))}
        </div>
      )}
      {feed.mode === "tasks" && (
        <div className="flex flex-col gap-1">
          {Object.entries(TASKS).map(([ref, task]) => {
            const active = feed.tasks.includes(ref);
            const color = STATUS_META[task.status].cssVar;
            return (
              <button
                key={ref}
                type="button"
                onClick={() => toggleIn("tasks", ref)}
                className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left"
                style={{
                  background: active
                    ? tint("var(--color-accent)", 8)
                    : "transparent",
                }}
              >
                <span className="font-mono text-[11px]" style={{ color }}>
                  {ref}
                </span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-text-muted">
                  {task.title}
                </span>
                {active && (
                  <span
                    className="font-mono text-[9px] uppercase"
                    style={{ color: "var(--color-accent-light)" }}
                  >
                    fed
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      <p className="mt-2 text-[11px] leading-snug text-text-muted">
        {FEED_MODE_HINT[feed.mode]}
      </p>
    </div>
  );
}

const FEED_MODE_HINT: Record<FeedMode, string> = {
  none: "Agents don't know this note exists and can't fetch it.",
  all: "Mentioned in every task's agent prompt over MCP.",
  categories:
    "Mentioned in agent prompts for tasks in the selected categories.",
  tags: "Mentioned in agent prompts for tasks with the selected tags.",
  tasks: "Mentioned in the agent prompts for the selected tasks.",
};

interface ChipToggleProps {
  label: string;
  active: boolean;
  onClick: () => void;
}

/** Selectable accent chip for category / tag feed targets. */
function ChipToggle({ label, active, onClick }: ChipToggleProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="cursor-pointer rounded-full px-2 py-0.5 text-[11px]"
      style={{
        color: active ? "var(--color-accent-light)" : "var(--color-text-muted)",
        background: active ? tint("var(--color-accent)", 13) : "transparent",
        border: `1px solid ${active ? tint("var(--color-accent)", 30) : "var(--color-border)"}`,
      }}
    >
      {label}
    </button>
  );
}

interface AccessSliderProps {
  level: AccessLevel;
  onChange: (level: AccessLevel) => void;
}

const ACCESS_STOPS: {
  id: AccessLevel;
  label: string;
  icon: React.ReactNode;
  color: string;
  hint: string;
}[] = [
  {
    id: "open",
    label: "Open",
    icon: <IconUsers size={12} />,
    color: "var(--color-done)",
    hint: "Humans and agents can edit.",
  },
  {
    id: "agent",
    label: "Agent RO",
    icon: <IconAgent size={12} />,
    color: "var(--color-glyph-review)",
    hint: "Humans edit; agents read only.",
  },
  {
    id: "locked",
    label: "Locked",
    icon: <IconLock size={12} />,
    color: "var(--color-danger)",
    hint: "Locked — no one edits until unlocked.",
  },
];

/**
 * Three-stop access slider — Open → Agent read-only → Locked. The thumb slides
 * to the active stop and takes its color.
 *
 * @param level - Current access level.
 * @param onChange - Fired with the picked level.
 */
function AccessSlider({ level, onChange }: AccessSliderProps) {
  const idx = ACCESS_STOPS.findIndex((s) => s.id === level);
  const active = ACCESS_STOPS[Math.max(0, idx)];
  return (
    <div>
      <div
        className="relative mb-2 flex rounded-full p-0.5"
        style={{
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
        }}
      >
        <span
          aria-hidden="true"
          className="absolute rounded-full transition-transform"
          style={{
            top: 2,
            bottom: 2,
            left: 2,
            width: "calc((100% - 4px) / 3)",
            transform: `translateX(${idx * 100}%)`,
            background: tint(active.color, 18),
            border: `1px solid ${tint(active.color, 40)}`,
          }}
        />
        {ACCESS_STOPS.map((s) => {
          const on = s.id === level;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onChange(s.id)}
              className="relative z-10 flex flex-1 cursor-pointer items-center justify-center gap-1 py-1 text-[11px] font-medium"
              style={{ color: on ? s.color : "var(--color-text-muted)" }}
            >
              {s.icon}
              {s.label}
            </button>
          );
        })}
      </div>
      <p className="text-[11px] leading-snug text-text-muted">{active.hint}</p>
    </div>
  );
}

interface TagEditorProps {
  tags: string[];
  onAdd: (tag: string) => void;
  onRemove: (tag: string) => void;
}

/** Tag chips with inline add input — Enter commits, click X removes. */
function TagEditor({ tags, onAdd, onRemove }: TagEditorProps) {
  const [val, setVal] = useState("");

  /** Commit the trimmed input as a new tag. */
  function commit() {
    const t = val.trim().toLowerCase();
    if (t && !tags.includes(t)) onAdd(t);
    setVal("");
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tags.map((t) => (
        <span
          key={t}
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
          style={{
            color: "var(--color-accent-light)",
            background: tint("var(--color-accent)", 12),
            border: `1px solid ${tint("var(--color-accent)", 26)}`,
          }}
        >
          {t}
          <button
            type="button"
            onClick={() => onRemove(t)}
            aria-label={`Remove ${t}`}
            className="cursor-pointer text-text-muted hover:text-text-primary"
          >
            <IconX size={10} />
          </button>
        </span>
      ))}
      <input
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
        placeholder="add tag…"
        className="min-w-[64px] flex-1 bg-transparent text-[11px] outline-none placeholder:text-text-faint"
        style={{ color: "var(--color-text-secondary)" }}
      />
    </div>
  );
}

interface FieldLabelProps {
  children: React.ReactNode;
}

/** Compact mono uppercase field label. */
function FieldLabel({ children }: FieldLabelProps) {
  return (
    <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-text-faint">
      {children}
    </div>
  );
}

interface SectionProps {
  label: string;
  children: React.ReactNode;
}

/** Right-pane section with a mono uppercase header rule. */
function Section({ label, children }: SectionProps) {
  return (
    <div className="mb-5">
      <div className="section-label">{label}</div>
      {children}
    </div>
  );
}

interface TaskDetailShowcaseProps {
  taskRef: string;
  onSelectNote: (id: string) => void;
}

/** Showcase of what gets merged into the real task DetailView. */
function TaskDetailShowcase({
  taskRef,
  onSelectNote,
}: TaskDetailShowcaseProps) {
  const task = TASKS[taskRef] ?? TASKS["PYZ-153"];
  const status = STATUS_META[task.status];
  const linkedNotes = SEED_NOTES.filter((n) =>
    n.linkedTasks.some((lt) => lt.ref === taskRef),
  );
  return (
    <div
      className="h-full overflow-y-auto"
      style={{ background: "var(--color-base)" }}
    >
      <div
        className="mx-auto"
        style={{ maxWidth: 760, padding: "28px 34px 64px" }}
      >
        <div className="mb-2 flex items-center gap-2">
          <MonoId id={taskRef} copyable={false} tone={task.status as never} />
          <span
            className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px]"
            style={{
              color: status.cssVar,
              background: tint(status.cssVar, 13),
              border: `1px solid ${tint(status.cssVar, 30)}`,
            }}
          >
            {status.label}
          </span>
        </div>
        <h1
          style={{
            fontSize: 22,
            fontWeight: 600,
            letterSpacing: "-0.01em",
            margin: "0 0 16px",
          }}
        >
          {task.title}
        </h1>

        <div className="section-label">Linked notes</div>
        <div className="mb-6">
          {linkedNotes.map((n) => {
            const color = NOTE_TYPE_META[n.type].color;
            const pinned = n.linkedTasks.find(
              (lt) => lt.ref === taskRef,
            )?.pinned;
            return (
              <button
                key={n.id}
                type="button"
                onClick={() => onSelectNote(n.id)}
                className="mb-1.5 flex w-full cursor-pointer items-start gap-3 rounded-lg p-3 text-left"
                style={{
                  background: "var(--color-surface)",
                  border: "1px solid var(--color-border)",
                }}
              >
                <IconDoc size={16} style={{ color, marginTop: 1 }} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium text-text-primary">
                      {n.title}
                    </span>
                    <span
                      className="rounded-full px-1.5 py-0.5 font-mono text-[9px] uppercase"
                      style={{ color, background: tint(color, 13) }}
                    >
                      {NOTE_TYPE_META[n.type].label}
                    </span>
                    {pinned && (
                      <span className="inline-flex items-center gap-1 font-mono text-[9.5px] text-text-muted">
                        <IconLock size={10} /> pinned
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[12px] text-text-muted">
                    {n.summary}
                  </p>
                </div>
              </button>
            );
          })}
          {linkedNotes.length === 0 && (
            <div className="text-[12px] text-text-faint">
              No notes linked to {taskRef}.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default NotesPrototype;
