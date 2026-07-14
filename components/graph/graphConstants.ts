import type { EdgeType, NoteTaskLinkKind, NoteType } from "@/lib/types";
import type { SimulationLinkDatum } from "d3-force";

// ---------------------------------------------------------------------------
// Graph node / link types
// ---------------------------------------------------------------------------

/** A node in the force-directed graph with d3-force positional fields. */
export interface GraphNode {
  id: string;
  title: string;
  /** Composed ref — a taskRef for task nodes, a noteRef for note nodes. */
  taskRef: string;
  /** Lifecycle status for task nodes; the inert `"note"` sentinel for note
   *  nodes (draw and filter paths branch on `kind` before reading it). */
  status: string;
  /** Entity discriminator: tasks draw as circles, notes as rounded squares. */
  kind: "task" | "note";
  /** Note type driving the note node's color; undefined on task nodes. */
  noteType?: NoteType;
  /** Note auto-feeds tasks (`feedMode != 'none'`); undefined on task nodes. */
  fed?: boolean;
  tags: string[];
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;

  // Animation fields (managed per-tick)
  /** Entrance progress 0->1. */
  _enterT: number;
  /** Dim progress 0=normal, 1=fully dimmed. */
  _dimT: number;
  /** Selection glow progress 0->1. */
  _selectGlow: number;
  /** Hover/focus scale progress 0->1 (driven by hover or selection). */
  _hoverT: number;
}

/** Note edge discriminants — one per visible relation so the style table
 *  and hover-label map stay exhaustiveness-checked. */
export type NoteLinkType =
  | "note_note"
  | "note_task_spec_of"
  | "note_task_reference"
  | "note_task_mention";

/** A link between two graph nodes. Note edges carry their relation so
 *  deliberate links, body mentions, and the knowledge web style apart. */
export interface GraphLink extends SimulationLinkDatum<GraphNode> {
  source: string | GraphNode;
  target: string | GraphNode;
  type: EdgeType | NoteLinkType;
}

/**
 * Narrow a link type to the note edge vocabulary.
 *
 * @param t - Link type.
 * @returns True when the link is a note edge of any relation.
 */
export function isNoteLinkType(t: GraphLink["type"]): t is NoteLinkType {
  return t === "note_note" || t.startsWith("note_task_");
}

/**
 * Map a payload note-task link kind to its graph link type.
 *
 * @param kind - Note-task link kind from the slim payload.
 * @returns The matching {@link NoteLinkType} discriminant.
 */
export function kindToLinkType(kind: NoteTaskLinkKind): NoteLinkType {
  switch (kind) {
    case "spec_of":
      return "note_task_spec_of";
    case "reference":
      return "note_task_reference";
    case "mention":
      return "note_task_mention";
  }
}

// ---------------------------------------------------------------------------
// Visual constants
// ---------------------------------------------------------------------------

/** Default node radius (used as fallback). */
export const NODE_RADIUS_DEFAULT = 14;

/** Fixed radius for note nodes — satellites stay small and uniform; only
 *  task nodes grow with connectivity. */
export const NOTE_NODE_RADIUS = 9;

/** Dark-theme fallback for the notes-layer gray. The canvas resolves the
 *  theme-aware value from `ThemeColors.noteEdge`; DOM surfaces read
 *  `var(--color-note-edge)` directly. */
export const NOTE_EDGE_GRAY = "#8b93a1";

export const EDGE_COLOR: Record<EdgeType | NoteLinkType, string> = {
  depends_on: "#55b3ff",
  relates_to: "#a78bfa",
  // note_note is the dark fallback only — the canvas resolves it from
  // ThemeColors.noteLink so the teal stays theme-aware.
  note_note: "#2dd4bf",
  note_task_spec_of: NOTE_EDGE_GRAY,
  note_task_reference: NOTE_EDGE_GRAY,
  note_task_mention: NOTE_EDGE_GRAY,
};

export const RELATES_DASH: number[] = [4, 6];
export const RELATES_OPACITY = 0.6;

/** Per-relation note edge styling. Deliberate note-task links read as the
 *  documented layer, mentions as ambient residue, and the note-note web as
 *  a distinct dotted stratum. `label` feeds the hover pill. */
export const NOTE_EDGE_STYLE: Record<
  NoteLinkType,
  { dash: readonly number[]; opacity: number; width: number; label: string }
> = {
  note_note: {
    dash: [1.5, 3.5],
    opacity: 0.45,
    width: 1.25,
    label: "links note",
  },
  note_task_spec_of: {
    dash: [2, 5],
    opacity: 0.55,
    width: 1.25,
    label: "spec of",
  },
  note_task_reference: {
    dash: [2, 5],
    opacity: 0.55,
    width: 1.25,
    label: "references",
  },
  note_task_mention: {
    dash: [1, 4],
    opacity: 0.3,
    width: 1,
    label: "mentions",
  },
};

export const ACCENT = "#818cf8";

export const ZOOM_FACTOR = 1.2;
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 5;

// ---------------------------------------------------------------------------
// Node sizing by connectivity
// ---------------------------------------------------------------------------

/**
 * Compute node radius. Task nodes grow with their TASK-edge count (note
 * attachments must not inflate a task); note nodes stay at the fixed
 * satellite radius.
 *
 * @param node - Node id + kind.
 * @param taskLinkCounts - Map of node ID to task-edge count.
 * @returns Pixel radius for the node.
 */
export function getNodeSize(
  node: Pick<GraphNode, "id" | "kind">,
  taskLinkCounts: Map<string, number>,
): number {
  if (node.kind === "note") return NOTE_NODE_RADIUS;
  const count = taskLinkCounts.get(node.id) ?? 0;
  if (count >= 7) return 22;
  if (count >= 4) return 18;
  return 14;
}

/**
 * Build a map of node ID -> edge count from links array.
 * @param links - Array of graph links.
 * @returns Map of node ID to number of connections.
 */
export function buildLinkCounts(links: GraphLink[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const l of links) {
    const srcId = typeof l.source === "string" ? l.source : l.source.id;
    const tgtId = typeof l.target === "string" ? l.target : l.target.id;
    counts.set(srcId, (counts.get(srcId) ?? 0) + 1);
    counts.set(tgtId, (counts.get(tgtId) ?? 0) + 1);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Theme colors
// ---------------------------------------------------------------------------

export interface ThemeColors {
  labelText: string;
  labelDimmed: string;
  hoverGlow: string;
  tooltipBg: string;
  tooltipBorder: string;
  tooltipText: string;
  taskBorder: string;
  statusDraft: string;
  statusPlanned: string;
  statusInProgress: string;
  statusInReview: string;
  statusDone: string;
  statusCancelled: string;
  noteReference: string;
  noteGuidance: string;
  noteKnowledge: string;
  /** Stroke for note-note edges — the knowledge web's teal. */
  noteLink: string;
  /** Stroke for note-task edges and the notes-layer swatch gray. */
  noteEdge: string;
  surface: string;
  /** True when rendering against the light theme. Drives node halo/fill
   *  alpha boosts so colored pixels stay visible against a near-white
   *  surface (the dark-mode tuning relies on additive contrast). */
  isLight: boolean;
  /** Alpha at the centre of the ambient radial halo behind each node. */
  haloAlpha: number;
  /** Alpha at the centre of the radial gradient that fills the node body. */
  fillInnerAlpha: number;
  /** Alpha at the outer edge of the node fill gradient. */
  fillOuterAlpha: number;
}

export const DARK_THEME: ThemeColors = {
  labelText: "#f9f9f9",
  labelDimmed: "rgba(249,249,249,0.2)",
  hoverGlow: "rgba(249,249,249,0.4)",
  tooltipBg: "rgba(7,8,10,0.95)",
  tooltipBorder: "rgba(255,255,255,0.10)",
  tooltipText: "#f9f9f9",
  taskBorder: "#07080a",
  // Brighter on dark — the previous #9ca3af leaned too neutral and the
  // dashed draft ring + reduced fill made the nodes vanish into the
  // canvas surface. This still reads as "muted / unspecced" against the
  // filled status colours.
  statusDraft: "#b9c1cb",
  statusPlanned: "#55b3ff",
  statusInProgress: "#ffbc33",
  statusInReview: "#a78bfa",
  statusDone: "#5fc992",
  statusCancelled: "#e57373",
  // Note-type palette mirrors NOTE_TYPE_META (components/workspace/notes):
  // reference = planned blue, guidance = progress amber, knowledge =
  // relates violet, so the graph and the notes rail speak one language.
  noteReference: "#55b3ff",
  noteGuidance: "#ffbc33",
  noteKnowledge: "#a78bfa",
  noteLink: "#2dd4bf",
  noteEdge: NOTE_EDGE_GRAY,
  surface: "rgba(7,8,10,0.85)",
  isLight: false,
  haloAlpha: 0.12,
  fillInnerAlpha: 0.6,
  fillOuterAlpha: 0.05,
};

export const LIGHT_THEME: ThemeColors = {
  labelText: "#1a1a1a",
  labelDimmed: "rgba(26,26,26,0.2)",
  hoverGlow: "rgba(26,26,26,0.2)",
  tooltipBg: "rgba(255,255,255,0.97)",
  tooltipBorder: "rgba(0,0,0,0.10)",
  tooltipText: "#1a1a1a",
  taskBorder: "#f0f1f3",
  statusDraft: "#6b7280",
  statusPlanned: "#3b82f6",
  statusInProgress: "#d97706",
  statusInReview: "#7c3aed",
  statusDone: "#059669",
  statusCancelled: "#c25454",
  noteReference: "#3b82f6",
  noteGuidance: "#d97706",
  noteKnowledge: "#7c3aed",
  noteLink: "#0d9488",
  noteEdge: "#64748b",
  surface: "rgba(255,255,255,0.85)",
  isLight: true,
  haloAlpha: 0.22,
  fillInnerAlpha: 0.85,
  fillOuterAlpha: 0.2,
};

/**
 * Read canvas theme colors from CSS custom properties at runtime.
 * Falls back to static DARK_THEME/LIGHT_THEME during SSR or if reading fails.
 * @returns ThemeColors matching the current CSS theme.
 */
export function getCanvasTheme(): ThemeColors {
  if (typeof document === "undefined") return DARK_THEME;
  const isLight = document.documentElement.classList.contains("light");
  const base = isLight ? LIGHT_THEME : DARK_THEME;
  try {
    const s = getComputedStyle(document.documentElement);
    const read = (prop: string) => s.getPropertyValue(prop).trim();
    const surface = read("--color-surface");
    const textPrimary = read("--color-text-primary");
    if (!surface || !textPrimary) return base;
    return {
      ...base,
      labelText: textPrimary,
      labelDimmed: isLight ? "rgba(26,26,26,0.2)" : "rgba(249,249,249,0.2)",
      surface: isLight ? "rgba(255,255,255,0.85)" : "rgba(7,8,10,0.85)",
      tooltipText: textPrimary,
      statusDraft: read("--color-todo") || base.statusDraft,
      statusInReview: read("--color-glyph-review") || base.statusInReview,
      statusDone: read("--color-done") || base.statusDone,
      statusCancelled: read("--color-cancelled") || base.statusCancelled,
      noteReference: read("--color-planned") || base.noteReference,
      noteGuidance: read("--color-progress") || base.noteGuidance,
      noteKnowledge: read("--color-relates") || base.noteKnowledge,
      noteLink: read("--color-note-link") || base.noteLink,
      noteEdge: read("--color-note-edge") || base.noteEdge,
    };
  } catch {
    return base;
  }
}

/**
 * Map a lifecycle stage (schema status, or one of the derived sub-stages
 * `plannable` / `ready`) to a theme color.
 *
 * Palette is split along execution intent:
 *   - `plannable` → planned blue (still in the planning arc).
 *   - `ready`     → in-progress orange (staged for execution; the next
 *                   transition flips this task to `in_progress`).
 * The canvas distinguishes shape from colour: `plannable` and `ready` both
 * draw hollow, but their ring colour signals which arc the task is in.
 *
 * @param stage - Lifecycle stage string (status or `plannable` / `ready`).
 * @param t - Theme colors.
 * @returns Hex color string for the stage.
 */
export function statusColor(stage: string, t: ThemeColors): string {
  switch (stage) {
    case "done":
      return t.statusDone;
    case "planned":
    case "plannable":
      return t.statusPlanned;
    case "ready":
    case "in_progress":
      return t.statusInProgress;
    case "in_review":
      return t.statusInReview;
    case "cancelled":
      return t.statusCancelled;
    default:
      return t.statusDraft;
  }
}

/**
 * Map a note type to its theme color. The counterpart of {@link statusColor}
 * for note nodes; the palette mirrors `NOTE_TYPE_META` on the notes surface.
 *
 * @param type - Note type.
 * @param t - Theme colors.
 * @returns Color string for the type.
 */
export function noteTypeColor(type: NoteType, t: ThemeColors): string {
  switch (type) {
    case "guidance":
      return t.noteGuidance;
    case "knowledge":
      return t.noteKnowledge;
    default:
      return t.noteReference;
  }
}

/**
 * Parse hex color to RGB.
 * @param hex - Hex color string (e.g. "#6366f1").
 * @returns [r, g, b] tuple.
 */
export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/**
 * Ease-out cubic: decelerating to zero.
 * @param t - Progress value between 0 and 1.
 * @returns Eased value between 0 and 1.
 */
export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

// ---------------------------------------------------------------------------
// Adaptive performance tier
// ---------------------------------------------------------------------------

/** Performance tier — tunes simulation cost and visual richness. */
export type GraphTier = "high" | "mid" | "low";

/** Per-tier knobs read by the simulation hook and the canvas renderer. */
export interface GraphTierConfig {
  /** Pre-tick iteration count for synchronous layout (no-explosion mounts). */
  preTickN: number;
  /** d3-force alphaDecay — higher = faster cooldown. */
  alphaDecay: number;
  /** d3-force link iterations per tick. */
  linkIterations: number;
  /** Cap for `window.devicePixelRatio` when sizing the canvas backing store. */
  maxDpr: number;
  /** Whether to draw the animated flow dots along `depends_on` edges. */
  flowDots: boolean;
  /** Whether to draw the radial ambient halo behind each node. */
  halo: boolean;
}

const TIER_CONFIG: Record<GraphTier, GraphTierConfig> = {
  high: {
    preTickN: 320,
    alphaDecay: 0.022,
    linkIterations: 3,
    maxDpr: 2,
    flowDots: true,
    halo: true,
  },
  mid: {
    preTickN: 220,
    alphaDecay: 0.04,
    linkIterations: 2,
    maxDpr: 2,
    flowDots: true,
    halo: true,
  },
  low: {
    preTickN: 120,
    alphaDecay: 0.06,
    linkIterations: 1,
    maxDpr: 1,
    flowDots: false,
    halo: false,
  },
};

/**
 * Detect the device performance tier from `navigator` heuristics.
 * Falls back to `mid` on the server or when the heuristics are missing.
 * @returns Tier string suitable for indexing `TIER_CONFIG`.
 */
export function getDeviceTier(): GraphTier {
  if (typeof navigator === "undefined") return "mid";
  const cores = navigator.hardwareConcurrency ?? 4;
  const memory =
    (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  if (cores >= 8 && memory >= 8) return "high";
  if (cores >= 4 && memory >= 2) return "mid";
  return "low";
}

/**
 * Resolve the config for a tier.
 * @param tier - Performance tier.
 * @returns Tunables for the simulation and renderer.
 */
export function getTierConfig(tier: GraphTier): GraphTierConfig {
  return TIER_CONFIG[tier];
}
