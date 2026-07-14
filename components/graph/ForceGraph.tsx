"use client";

import {
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
  useState,
  useMemo,
} from "react";
import { useReducedMotion } from "motion/react";
import { quadtree } from "d3-quadtree";
import type {
  NoteGraphEdge,
  NoteGraphSlim,
  NoteTaskGraphEdge,
  TaskGraphEdge,
  TaskGraphSlim,
} from "@/lib/data/views";
import type { EdgeType, NoteType } from "@/lib/types";
import { NOTE_TYPE_META } from "@/components/workspace/notes/note-meta";
import { useForceSimulation, type NoteEdge } from "./useForceSimulation";
import { GraphControls } from "./GraphControls";
import {
  type GraphNode,
  type GraphLink,
  type ThemeColors,
  EDGE_COLOR,
  RELATES_DASH,
  RELATES_OPACITY,
  NOTE_EDGE_STYLE,
  ACCENT,
  ZOOM_FACTOR,
  MIN_ZOOM,
  MAX_ZOOM,
  getCanvasTheme,
  statusColor,
  noteTypeColor,
  hexToRgb,
  easeOutCubic,
  getNodeSize,
  buildLinkCounts,
  getDeviceTier,
  getTierConfig,
  isNoteLinkType,
  kindToLinkType,
} from "./graphConstants";

/** Props for the ForceGraph component. */
interface ForceGraphProps {
  /** @param projectId - Stable id used to key the simulation's position
   *   cache. Two mounts of the same project share their layout. */
  projectId: string;
  /** @param tasks - Slim task records (augmented with taskRef) to visualize. */
  tasks: TaskGraphSlim[];
  /** @param edges - Slim edge records defining relationships. */
  edges: TaskGraphEdge[];
  /** @param notes - Slim note records rendered alongside the tasks. */
  notes: NoteGraphSlim[];
  /** @param noteLinks - Note-to-note edges from the slim payload. */
  noteLinks: NoteGraphEdge[];
  /** @param noteTaskLinks - Note-to-task edges from the slim payload. */
  noteTaskLinks: NoteTaskGraphEdge[];
  /** @param selectedNodeId - Currently selected node ID, or null. */
  selectedNodeId: string | null;
  /** @param onSelectNode - Called when a task node is clicked. */
  onSelectNode: (nodeId: string) => void;
  /** @param onSelectNote - Called when a note node is clicked or tapped.
   *   `viaTouch` distinguishes the gesture: the parent opens the in-graph
   *   preview for pointer clicks and jumps straight to the notes surface
   *   for touch taps. */
  onSelectNote?: (noteId: string, viaTouch: boolean) => void;
  /** @param notesHidden - Hides every note node and note edge. Controlled
   *   by the parent legend's Notes toggle. */
  notesHidden?: boolean;
  /** @param noteEdgesHidden - Hides note edges only (nodes stay). Driven
   *   by the task-stratum edge filter pills. */
  noteEdgesHidden?: boolean;
  /** @param onDeselect - Called when the canvas background is clicked. */
  onDeselect?: () => void;
  /**
   * @param hoveredIdHint - External hover hint (e.g. driven by a paired list
   *   rail). Brightens the matched node without dimming the rest of the graph.
   */
  hoveredIdHint?: string | null;
  /** @param onHoverNode - Called when the canvas-driven hover changes. */
  onHoverNode?: (nodeId: string | null) => void;
  /**
   * @param hiddenStatuses - Statuses to hide from the canvas. Controlled by
   *   the parent so the legend can live outside this component. When omitted,
   *   no statuses are hidden.
   */
  hiddenStatuses?: Set<string>;
  /**
   * @param hiddenEdgeTypes - Edge types to hide. Filtered alongside
   *   `hiddenStatuses` before the simulation runs.
   */
  hiddenEdgeTypes?: Set<EdgeType>;
  /**
   * @param rightInset - Pixels on the right edge of the canvas obscured by
   *   an overlay (e.g. a detail slide-over). Drives both the focus / fit
   *   target (so the node sits inside the visible region) and the floating
   *   GraphControls position.
   */
  rightInset?: number;
  /**
   * @param stageMap - Optional override that surfaces derived lifecycle
   *   sub-stages (`plannable` / `ready`) to the renderer so it can paint
   *   them with the dedicated hollow-blue treatment. When the map has no
   *   entry for an id the renderer falls back to the schema `status`. Status
   *   filtering still uses the raw `status` field — the map only affects
   *   visual styling.
   */
  stageMap?: ReadonlyMap<string, string>;
  /** @param className - Additional CSS classes. */
  className?: string;
}

/** Empty set fallback used when no filter prop is provided. */
const EMPTY_STATUS_SET: ReadonlySet<string> = new Set();
/** Empty set fallback used when no edge filter prop is provided. */
const EMPTY_EDGE_SET: ReadonlySet<EdgeType> = new Set();
/** Long-press hold time before a touch toggles a node's pin, in ms. */
const LONG_PRESS_MS = 500;

/**
 * Detect if light mode is active by checking the HTML class.
 * @returns true if light mode.
 */
function isLightMode(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.classList.contains("light");
}

/**
 * Compute a fit-to-graph camera transform that respects an overlay on the
 * right edge of the canvas. Returns null when there are no nodes to fit.
 *
 * @param nodesArr - Nodes to encompass.
 * @param size - Full canvas size.
 * @param rightInset - Pixels on the right covered by an overlay.
 * @returns Transform `{ x, y, scale }` placing the centroid in the visible
 *   region and scaling so the bounding box fits with padding.
 */
function fitTransform(
  nodesArr: GraphNode[],
  size: { width: number; height: number },
  rightInset: number,
): { x: number; y: number; scale: number } | null {
  if (nodesArr.length === 0) return null;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const n of nodesArr) {
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    const r = 50;
    if (x - r < minX) minX = x - r;
    if (y - r < minY) minY = y - r;
    if (x + r > maxX) maxX = x + r;
    if (y + r > maxY) maxY = y + r;
  }
  // Shrink the padding on narrow visible regions so a small canvas (or a
  // wide-overlay state on a small laptop) still leaves usable space inside
  // the frame. Without this, `(visibleW - 120) / gw` can go ≤ 0 → scale = 0
  // → blank canvas. Clamp scale to MIN_ZOOM as a final safety net.
  const visibleW = Math.max(120, size.width - rightInset);
  const visibleH = Math.max(120, size.height);
  const pad = Math.max(8, Math.min(60, visibleW / 4, visibleH / 4));
  const gw = maxX - minX || 1;
  const gh = maxY - minY || 1;
  const rawScale = Math.min(
    (visibleW - pad * 2) / gw,
    (visibleH - pad * 2) / gh,
    2,
  );
  const scale = Math.max(MIN_ZOOM, rawScale);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return {
    x: visibleW / 2 - cx * scale,
    y: visibleH / 2 - cy * scale,
    scale,
  };
}

/**
 * Compute a centre-on-node camera transform that respects an overlay on the
 * right edge of the canvas.
 *
 * @param node - The node to centre on.
 * @param size - Full canvas size.
 * @param rightInset - Pixels on the right covered by an overlay.
 * @param scale - Desired zoom scale.
 * @returns Transform `{ x, y, scale }` placing the node at the visible centre.
 */
function focusTransform(
  node: GraphNode,
  size: { width: number; height: number },
  rightInset: number,
  scale: number,
): { x: number; y: number; scale: number } | null {
  if (node.x == null || node.y == null) return null;
  const visibleW = Math.max(120, size.width - rightInset);
  return {
    x: visibleW / 2 - node.x * scale,
    y: size.height / 2 - node.y * scale,
    scale,
  };
}

/**
 * Canvas-based force-directed graph showing tasks with their relationships.
 * Drives a state-machine simulation (cold → settling → settled → focused);
 * the camera responds to lifecycle phase transitions instead of trying to
 * track moving nodes every frame, which kept the previous version fighting
 * itself any time data refreshed.
 *
 * @param props - Graph data, selection state, and callbacks.
 * @returns Rendered canvas element with graph controls overlay.
 */
export function ForceGraph({
  projectId,
  tasks,
  edges,
  notes,
  noteLinks,
  noteTaskLinks,
  selectedNodeId,
  onSelectNode,
  onSelectNote,
  notesHidden = false,
  noteEdgesHidden = false,
  onDeselect,
  hoveredIdHint = null,
  onHoverNode,
  hiddenStatuses,
  hiddenEdgeTypes,
  rightInset = 0,
  stageMap,
  className = "",
}: ForceGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Start at 0,0 so the simulation never spawns with a wrong centre. The
  // useLayoutEffect below measures the container and writes the real size
  // synchronously before first paint — no flash of incorrectly-positioned
  // nodes, no top-left frame on initial open.
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [light, setLight] = useState(isLightMode);
  const [zoomLevel, setZoomLevel] = useState(1);

  const tier = useMemo(() => getTierConfig(getDeviceTier()), []);
  // `prefers-reduced-motion` folds into the same effective-config flags the
  // adaptive perf level uses: decorative animation (flow dots, status
  // pulse, transition lerps) is dropped and camera moves snap, while the
  // simulation itself — the layout mechanism — keeps running.
  const reducedMotion = useReducedMotion() === true;

  const statusFilter = hiddenStatuses ?? EMPTY_STATUS_SET;
  const edgeFilter = hiddenEdgeTypes ?? EMPTY_EDGE_SET;

  // Filter tasks/edges by hidden statuses + hidden edge types
  const filteredTasks = useMemo(
    () => tasks.filter((t) => !statusFilter.has(t.status)),
    [tasks, statusFilter],
  );
  const filteredTaskIds = useMemo(
    () => new Set(filteredTasks.map((t) => t.id)),
    [filteredTasks],
  );
  const filteredEdges = useMemo(
    () =>
      edges.filter(
        (e) =>
          filteredTaskIds.has(e.sourceTaskId) &&
          filteredTaskIds.has(e.targetTaskId) &&
          !edgeFilter.has(e.edgeType as EdgeType),
      ),
    [edges, filteredTaskIds, edgeFilter],
  );
  const visibleNotes = useMemo(
    () => (notesHidden ? [] : notes),
    [notesHidden, notes],
  );
  // Flatten both note link arrays into direction-agnostic typed edges once
  // per input change — never per frame. A note-task edge survives only while
  // its task survives the status filter; note-note edges only need both
  // endpoints present (RLS already scoped the payload to visible notes).
  const visibleNoteEdges = useMemo(() => {
    if (notesHidden || noteEdgesHidden) return [];
    const noteIds = new Set(notes.map((n) => n.id));
    const out: NoteEdge[] = [];
    for (const l of noteTaskLinks) {
      if (noteIds.has(l.noteId) && filteredTaskIds.has(l.taskId)) {
        out.push({
          sourceId: l.noteId,
          targetId: l.taskId,
          type: kindToLinkType(l.kind),
        });
      }
    }
    for (const l of noteLinks) {
      if (noteIds.has(l.sourceNoteId) && noteIds.has(l.targetNoteId)) {
        out.push({
          sourceId: l.sourceNoteId,
          targetId: l.targetNoteId,
          type: "note_note",
        });
      }
    }
    return out;
  }, [
    notesHidden,
    noteEdgesHidden,
    notes,
    noteTaskLinks,
    noteLinks,
    filteredTaskIds,
  ]);

  useEffect(() => {
    const observer = new MutationObserver(() => setLight(isLightMode()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- light triggers re-read of CSS vars
  const theme = useMemo(() => getCanvasTheme(), [light]);

  // Transform state (pan/zoom)
  const transformRef = useRef({ x: 0, y: 0, scale: 1 });
  const dragRef = useRef<{
    active: boolean;
    nodeId: string | null;
    /** Entity kind of the pressed node — routes the click on pointerup
     *  (tasks select in-graph, notes navigate to the notes surface). */
    nodeKind: "task" | "note" | null;
    panning: boolean;
    /** Rolling basis updated each pan tick — used to compute incremental
     *  translation deltas. NOT a stable click anchor. */
    startX: number;
    startY: number;
    /** Stable click anchor — never mutated after pointerdown. Use this for
     *  click vs drag detection. */
    originX: number;
    originY: number;
    /** Set true the moment the gesture is committed as a drag (node move or
     *  canvas pan). On pointerup, `!moved` means it was a clean tap. */
    moved: boolean;
  }>({
    active: false,
    nodeId: null,
    nodeKind: null,
    panning: false,
    startX: 0,
    startY: 0,
    originX: 0,
    originY: 0,
    moved: false,
  });
  /** Live pointers on the canvas (screen coords), keyed by pointerId —
   *  two simultaneous entries arm the pinch gesture. */
  const activePointersRef = useRef(new Map<number, { x: number; y: number }>());
  /** Two-finger gesture baseline (span + centroid), null when not pinching.
   *  Updated every move so zoom/pan apply incremental deltas. */
  const pinchRef = useRef<{
    prevDist: number;
    prevCx: number;
    prevCy: number;
  } | null>(null);
  /** Pending long-press pin/unpin timer for a touch hold on a node. */
  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoveredRef = useRef<string | null>(null);
  const hoveredEdgeRef = useRef<GraphLink | null>(null);
  const tooltipRef = useRef<{ text: string; x: number; y: number } | null>(
    null,
  );
  const needsRedrawRef = useRef(true);
  /**
   * Set when the user pans, zooms, or drag-rejigs a node — suppresses the
   * automated camera effect so their viewport intent is respected. Cleared
   * on selection change and on the explicit reset / fit controls.
   */
  const userOverrideRef = useRef(false);

  // --- Animated transform transitions ---
  const animRef = useRef<{
    startX: number;
    startY: number;
    startScale: number;
    endX: number;
    endY: number;
    endScale: number;
    startTime: number;
    duration: number;
  } | null>(null);

  /**
   * Animate the camera from the current transform to a target over duration ms.
   * @param target - Target transform `{ x, y, scale }`.
   * @param duration - Animation duration in ms.
   */
  const animateTransform = useCallback(
    (target: { x: number; y: number; scale: number }, duration = 500) => {
      const cur = transformRef.current;
      animRef.current = {
        startX: cur.x,
        startY: cur.y,
        startScale: cur.scale,
        endX: target.x,
        endY: target.y,
        endScale: target.scale,
        startTime: performance.now(),
        // 1ms, not 0: a same-timestamp frame would compute 0/0 = NaN.
        duration: reducedMotion ? 1 : duration,
      };
      needsRedrawRef.current = true;
    },
    [reducedMotion],
  );

  // Stable callback handed to the simulation hook — fires on every live
  // tick and just flags a redraw. Keeping this out of React state means a
  // settling 200-node graph doesn't trigger 60 reconciliations per second.
  const handleSimTick = useCallback(() => {
    needsRedrawRef.current = true;
  }, []);

  const { nodes, links, state, topologyVersion, reheat, reset } =
    useForceSimulation(
      projectId,
      filteredTasks,
      filteredEdges,
      visibleNotes,
      visibleNoteEdges,
      size.width,
      size.height,
      selectedNodeId,
      handleSimTick,
    );

  const ticking = state === "settling";

  // Ref writes are mirrored in effects; all consumers run post-commit.
  const nodesForFitRef = useRef<GraphNode[]>([]);
  const sizeRef = useRef(size);
  useEffect(() => {
    nodesForFitRef.current = nodes;
  }, [nodes]);
  useEffect(() => {
    sizeRef.current = size;
  }, [size]);

  // Task-edge counts for node sizing / hit radii / label gating. Filtered
  // to task links so the renderer agrees with the sim: note attachments
  // must not grow a task's drawn size while its collide radius stays put.
  const taskLinkCounts = useMemo(
    () => buildLinkCounts(links.filter((l) => !isNoteLinkType(l.type))),
    [links],
  );

  // Per-link parallel-edge metadata — counts how many edges share the same
  // unordered (src, tgt) pair plus this link's index inside that bundle.
  // Topology-stable: `links` only changes when the simulation rebuilds, so
  // this map is recomputed once per topology rather than 60×/sec inside
  // `draw()`.
  const parallelMeta = useMemo(() => {
    const counts = new Map<string, number>();
    for (const l of links) {
      const srcId =
        typeof l.source === "string" ? l.source : (l.source as GraphNode).id;
      const tgtId =
        typeof l.target === "string" ? l.target : (l.target as GraphNode).id;
      const key = srcId < tgtId ? `${srcId}|${tgtId}` : `${tgtId}|${srcId}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const seen = new Map<string, number>();
    const meta = new Map<GraphLink, { count: number; idx: number }>();
    for (const l of links) {
      const srcId =
        typeof l.source === "string" ? l.source : (l.source as GraphNode).id;
      const tgtId =
        typeof l.target === "string" ? l.target : (l.target as GraphNode).id;
      const key = srcId < tgtId ? `${srcId}|${tgtId}` : `${tgtId}|${srcId}`;
      const idx = seen.get(key) ?? 0;
      meta.set(l, { count: counts.get(key) ?? 1, idx });
      seen.set(key, idx + 1);
    }
    return meta;
  }, [links]);

  // Gradient cache — fill + halo radial gradients keyed by status×size. Both
  // are theme-dependent (status RGB + alpha stops), so the cache is dropped
  // whenever the `theme` reference changes (light↔dark flip). The 2D Canvas
  // spec applies the current transform to a CanvasGradient at fill time, so
  // a single gradient created with raw radius `sz` works for every node of
  // that status×size — even though each node sits under a different
  // translate/scale.
  const gradientCacheRef = useRef<{
    theme: ThemeColors | null;
    fill: Map<string, CanvasGradient>;
    halo: Map<string, CanvasGradient>;
  }>({ theme: null, fill: new Map(), halo: new Map() });

  // Adaptive perf — measure rolling rendered-frame FPS, step the visual
  // budget down when the device chokes, step back up when it recovers.
  // `level` is the only authoritative source; `tier` is the static ceiling.
  //   0  full   — static tier behaviour (halo, flow dots, gradient fill, lerps).
  //   1  mid    — drop halos + flow dots (and the redraws they force).
  //   2  low    — drop gradient fill, shadow blur, in-progress pulse, anim
  //              lerps. Animation values snap to target, killing the
  //              continuous-redraw treadmill so the loop only paints when
  //              data actually changes.
  // Transitions are debounced to avoid ping-pong: escalate after 500 ms,
  // recover after 2 s of FPS > 55. The 30-frame window itself smooths the
  // input; a single hiccup never trips the level.
  const perfRef = useRef<{
    /** Recent rendered-frame timestamps (most recent last). */
    frames: number[];
    /** Active degrade level — index into the rules above. */
    level: 0 | 1 | 2;
    /** `performance.now()` of the last level transition. */
    lastChangeAt: number;
  }>({ frames: [], level: 0, lastChangeAt: 0 });

  // Label visibility scales with N — a 50-node graph can show every label
  // at default zoom without crowding; a 200-node graph cannot. Multiplier
  // climbs linearly above 60 nodes so the thresholds get stricter.
  const labelScale = useMemo(
    () => Math.max(1, 1 + (nodes.length - 60) * 0.005),
    [nodes.length],
  );

  // Connected-node set for selection highlighting. Depends on
  // `topologyVersion` (bumps once per topology rebuild) instead of the
  // `links` array reference — the simulation mutates link endpoints in
  // place but the *set* of connections stays the same across ticks, so
  // there's no point re-deriving this 60×/sec.
  const connectedSetRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!selectedNodeId) {
      connectedSetRef.current.clear();
      needsRedrawRef.current = true;
      return;
    }
    const s = new Set<string>();
    s.add(selectedNodeId);
    for (const l of links) {
      const srcId = typeof l.source === "string" ? l.source : l.source.id;
      const tgtId = typeof l.target === "string" ? l.target : l.target.id;
      if (srcId === selectedNodeId) s.add(tgtId);
      if (tgtId === selectedNodeId) s.add(srcId);
    }
    connectedSetRef.current = s;
    needsRedrawRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- links is stable across ticks; topologyVersion is the trigger.
  }, [selectedNodeId, topologyVersion]);

  // Topology rebuild → request a redraw. `hitTest` builds its quadtree
  // locally on every call (positions mutate in place during ticks/drags),
  // so there's no shared spatial index to refresh here.
  useEffect(() => {
    needsRedrawRef.current = true;
  }, [topologyVersion]);

  // Synchronous initial measurement — runs after DOM commit but before
  // browser paint, so the very first paint already has the correct size.
  // Without this, useState's default is committed → React paints once with
  // the wrong dimensions before ResizeObserver fires.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      setSize({
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    }
  }, []);

  // Live updates for subsequent layout changes (window resize, panel
  // open/close, breakpoint flip).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) {
        setSize({ width: Math.round(width), height: Math.round(height) });
        needsRedrawRef.current = true;
      }
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  // Coordinate transforms
  const screenToWorld = useCallback(
    (sx: number, sy: number): [number, number] => {
      const t = transformRef.current;
      return [(sx - t.x) / t.scale, (sy - t.y) / t.scale];
    },
    [],
  );

  // Quadtree-based hit testing — collect every node whose validated radius
  // covers the click point, then return the visually-closest one. The naive
  // `qt.find(...)` returns the single nearest centre and validates only that
  // one, which gave the "random unclickable nodes" symptom whenever two
  // nodes were near the click and the closer-by-centre had a smaller radius.
  //
  // The quadtree is rebuilt locally on every call because node positions
  // mutate in place during ticks AND drag-induced reheats — caching off
  // `topologyVersion` would point at stale positions during settling and
  // during a focused-state drag. The cost is ~1 ms for 200 nodes; hits
  // happen at human speed (one per click, throttled to rAF for hover).
  const hitTest = useCallback(
    (wx: number, wy: number): GraphNode | null => {
      const ns = nodesForFitRef.current;
      if (ns.length === 0) return null;
      const qt = quadtree<GraphNode>()
        .x((d) => d.x ?? 0)
        .y((d) => d.y ?? 0)
        .addAll(ns);
      const slop = 8;
      let best: GraphNode | null = null;
      let bestDist = Infinity;
      // Tightest possible search bound: largest visual node radius + slop.
      // For our sizing (max 22) + slop 8 = 30 in world units.
      const searchR = 32;
      qt.visit((node, x0, y0, x1, y1) => {
        // Iterate every leaf within the bounding rectangle; quadtree visit
        // returns true to skip a quadrant (used here for spatial pruning).
        type LeafNode = { data: GraphNode; next?: LeafNode };
        let leaf = node as unknown as LeafNode | undefined;
        if (!("length" in node)) {
          while (leaf) {
            const d = leaf.data;
            if (d?.x != null && d.y != null) {
              const r = getNodeSize(d, taskLinkCounts) + slop;
              const dx = d.x - wx;
              const dy = d.y - wy;
              const dist2 = dx * dx + dy * dy;
              if (dist2 <= r * r && dist2 < bestDist) {
                bestDist = dist2;
                best = d;
              }
            }
            leaf = leaf.next;
          }
        }
        return (
          x0 > wx + searchR ||
          x1 < wx - searchR ||
          y0 > wy + searchR ||
          y1 < wy - searchR
        );
      });
      return best;
    },
    [taskLinkCounts],
  );

  // Edge midpoint hit test for hover labels
  const edgeHitTest = useCallback(
    (wx: number, wy: number): GraphLink | null => {
      const threshold = 20;
      for (const l of links) {
        const src = l.source as GraphNode;
        const tgt = l.target as GraphNode;
        if (src.x == null || src.y == null || tgt.x == null || tgt.y == null)
          continue;
        const mx = (src.x + tgt.x) / 2;
        const my = (src.y + tgt.y) / 2;
        const dx = mx - wx;
        const dy = my - wy;
        if (dx * dx + dy * dy <= threshold * threshold) return l;
      }
      return null;
    },
    [links],
  );

  // Disable mirrors the inner-block disable on the lerp mutation site.
  // eslint-disable-next-line react-hooks/immutability
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = size.width;
    const h = size.height;
    const dpr = Math.min(window.devicePixelRatio || 1, tier.maxDpr);

    // DPR-aware canvas sizing
    const targetW = Math.round(w * dpr);
    const targetH = Math.round(h * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }

    ctx.resetTransform();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale(dpr, dpr);

    const t = transformRef.current;
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.scale(t.scale, t.scale);

    const hasSelection = selectedNodeId !== null;
    const connected = connectedSetRef.current;
    // Treat the rail-driven hint exactly like a canvas hover for visual purposes:
    // brighter ring + label, no dimming of the rest of the graph.
    const hovered = hoveredRef.current ?? hoveredIdHint;
    const zoomScale = t.scale;

    // Effective render config for this frame — folds the static tier with the
    // adaptive degrade level. See `perfRef` for the level definitions.
    const level = perfRef.current.level;
    const effHalo = tier.halo && level === 0;
    const effFlowDots = tier.flowDots && level === 0 && !reducedMotion;
    const effGradientFill = level < 2;
    const effShadowBlur = level < 2;
    const effShadowPulse = level < 2 && !reducedMotion;
    const effLerps = level < 2 && !reducedMotion;

    // Viewport bounds in world coords, expanded by a generous padding so
    // halos, arrows, and labels at the screen edge stay drawn. Padding has
    // a fixed world floor (covers max halo radius ≈ 55) plus a screen-pixel
    // term that grows the margin when zoomed out (where each pixel covers
    // more world units, so a lone node "off-screen" can still cast a wide
    // halo into view).
    const cullPadding = 80 + 30 / zoomScale;
    const viewLeft = -t.x / zoomScale - cullPadding;
    const viewTop = -t.y / zoomScale - cullPadding;
    const viewRight = (w - t.x) / zoomScale + cullPadding;
    const viewBottom = (h - t.y) / zoomScale + cullPadding;

    // Drop the gradient cache when the theme reference changes — RGB stops
    // bake the active status palette + halo/fill alphas, so a stale gradient
    // would render last frame's colours after a light↔dark flip.
    const gCache = gradientCacheRef.current;
    if (gCache.theme !== theme) {
      gCache.fill.clear();
      gCache.halo.clear();
      gCache.theme = theme;
    }
    // Stage → color resolver shared by the gradient caches and the node
    // body. Note nodes carry a `note:<type>` stage key so they flow through
    // the same `(stage, size)`-keyed caches as task statuses.
    const stageColor = (stage: string): string =>
      stage.startsWith("note:")
        ? noteTypeColor(stage.slice(5) as NoteType, theme)
        : statusColor(stage, theme);
    const getFillGradient = (stage: string, sz: number): CanvasGradient => {
      const key = `${stage}|${sz}`;
      let g = gCache.fill.get(key);
      if (!g) {
        const [r, gn, b] = hexToRgb(stageColor(stage));
        g = ctx.createRadialGradient(0, 0, 0, 0, 0, sz);
        g.addColorStop(0, `rgba(${r},${gn},${b},${theme.fillInnerAlpha})`);
        g.addColorStop(1, `rgba(${r},${gn},${b},${theme.fillOuterAlpha})`);
        gCache.fill.set(key, g);
      }
      return g;
    };
    const getHaloGradient = (stage: string, sz: number): CanvasGradient => {
      const key = `${stage}|${sz}`;
      let g = gCache.halo.get(key);
      if (!g) {
        const [r, gn, b] = hexToRgb(stageColor(stage));
        g = ctx.createRadialGradient(0, 0, sz * 0.5, 0, 0, sz * 2.5);
        g.addColorStop(0, `rgba(${r},${gn},${b},${theme.haloAlpha})`);
        g.addColorStop(1, `rgba(${r},${gn},${b},0)`);
        gCache.halo.set(key, g);
      }
      return g;
    };

    // Lerp fields are canvas-only and never drive React reconciliation; an
    // off-node Map would burn allocation budget on every frame for 200+ nodes.
    /* eslint-disable react-hooks/immutability */
    if (effLerps) {
      for (const n of nodes) {
        if (n._enterT < 1) n._enterT = Math.min(1, n._enterT + 0.04);

        const shouldDim = hasSelection && !connected.has(n.id);
        const dimTarget = shouldDim ? 1 : 0;
        n._dimT += (dimTarget - n._dimT) * 0.085;

        const glowTarget = n.id === selectedNodeId ? 1 : 0;
        n._selectGlow += (glowTarget - n._selectGlow) * 0.1;

        // Hover/focus scale — fires for both pointer hover and selection so the
        // selected node carries the same lift visual without an instant snap.
        const focusTarget = n.id === hovered || n.id === selectedNodeId ? 1 : 0;
        n._hoverT += (focusTarget - n._hoverT) * 0.14;
      }
    } else {
      for (const n of nodes) {
        n._enterT = 1;
        n._dimT = hasSelection && !connected.has(n.id) ? 1 : 0;
        n._selectGlow = n.id === selectedNodeId ? 1 : 0;
        n._hoverT = n.id === hovered || n.id === selectedNodeId ? 1 : 0;
      }
    }
    /* eslint-enable react-hooks/immutability */

    // --- Links ---
    for (const l of links) {
      const src = l.source as GraphNode;
      const tgt = l.target as GraphNode;
      if (src.x == null || src.y == null || tgt.x == null || tgt.y == null)
        continue;

      // Off-screen cull — skip edges whose bounding box doesn't intersect
      // the padded viewport. Cheap pre-check that buys back the gradient,
      // arrow, and flow-dot work for everything outside the visible region.
      const eMinX = src.x < tgt.x ? src.x : tgt.x;
      const eMaxX = src.x > tgt.x ? src.x : tgt.x;
      const eMinY = src.y < tgt.y ? src.y : tgt.y;
      const eMaxY = src.y > tgt.y ? src.y : tgt.y;
      if (
        eMaxX < viewLeft ||
        eMinX > viewRight ||
        eMaxY < viewTop ||
        eMinY > viewBottom
      )
        continue;

      const linkDimmed =
        hasSelection && !connected.has(src.id) && !connected.has(tgt.id);
      const enterAlpha = Math.min(
        easeOutCubic(src._enterT),
        easeOutCubic(tgt._enterT),
      );
      const dimAlpha = Math.max(src._dimT, tgt._dimT);

      const isRelates = l.type === "relates_to";
      const isDepends = l.type === "depends_on";
      // Per-relation note styling — deliberate links, mentions, and the
      // note-note web each carry their own dash/opacity/width stratum.
      const noteStyle = isNoteLinkType(l.type) ? NOTE_EDGE_STYLE[l.type] : null;
      const edgeColor =
        l.type === "note_note"
          ? theme.noteLink
          : noteStyle
            ? theme.noteEdge
            : (EDGE_COLOR[l.type] ?? "#6b7280");
      const baseAlpha =
        (1 - dimAlpha * 0.85) *
        enterAlpha *
        (noteStyle?.opacity ?? (isRelates ? RELATES_OPACITY : 1));
      ctx.globalAlpha = linkDimmed ? baseAlpha * 0.05 : baseAlpha;
      ctx.lineWidth = noteStyle?.width ?? (isRelates ? 1.5 : 2);

      const dx = tgt.x - src.x;
      const dy = tgt.y - src.y;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;

      // Edge style — depends_on gets a directional gradient (bright at
      // source, fades toward target); relates and note edges draw as muted
      // dashes (note strata tighter and quieter than relates).
      if (isRelates || noteStyle) {
        ctx.setLineDash(noteStyle ? [...noteStyle.dash] : RELATES_DASH);
        ctx.strokeStyle = edgeColor;
      } else {
        ctx.setLineDash([]);
        const [r, g, b] = hexToRgb(edgeColor);
        const lr = Math.min(255, r + 50);
        const lg = Math.min(255, g + 50);
        const lb = Math.min(255, b + 30);
        const grad = ctx.createLinearGradient(src.x, src.y, tgt.x, tgt.y);
        grad.addColorStop(0, `rgba(${lr},${lg},${lb},1)`);
        grad.addColorStop(0.7, `rgba(${r},${g},${b},0.6)`);
        grad.addColorStop(1, `rgba(${r},${g},${b},0.25)`);
        ctx.strokeStyle = grad;
      }

      const pm = parallelMeta.get(l);
      const pCount = pm?.count ?? 1;
      const pIdx = pm?.idx ?? 0;

      if (pCount === 1) {
        // Straight line for single edges
        ctx.beginPath();
        ctx.moveTo(src.x, src.y);
        ctx.lineTo(tgt.x, tgt.y);
        ctx.stroke();

        // Arrow for depends_on only
        if (isDepends) {
          const tgtR = getNodeSize(tgt, taskLinkCounts) + 4;
          const angle = Math.atan2(dy, dx);
          const ax = tgt.x - Math.cos(angle) * tgtR;
          const ay = tgt.y - Math.sin(angle) * tgtR;
          const arrowLen = 10;
          ctx.setLineDash([]);
          ctx.fillStyle = edgeColor;
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(
            ax - arrowLen * Math.cos(angle - 0.5),
            ay - arrowLen * Math.sin(angle - 0.5),
          );
          ctx.lineTo(
            ax - arrowLen * Math.cos(angle + 0.5),
            ay - arrowLen * Math.sin(angle + 0.5),
          );
          ctx.closePath();
          ctx.fill();
        }

        // Flow dots for depends_on — animate direction from source to target
        if (isDepends && !linkDimmed && effFlowDots) {
          const now = performance.now() / 1000;
          const speed = 0.25;
          const dotCount = 3;
          const dotRadius = 2.5;
          const srcR = getNodeSize(src, taskLinkCounts);
          const tgtR = getNodeSize(tgt, taskLinkCounts);
          const startT = srcR / len;
          const endT = 1 - tgtR / len;
          ctx.fillStyle = edgeColor;
          for (let i = 0; i < dotCount; i++) {
            const phase = (now * speed + i / dotCount) % 1;
            const tt = startT + phase * (endT - startT);
            const px = src.x + dx * tt;
            const py = src.y + dy * tt;
            const dotAlpha = Math.sin(phase * Math.PI) * baseAlpha * 0.8;
            ctx.globalAlpha = dotAlpha;
            ctx.beginPath();
            ctx.arc(px, py, dotRadius, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.globalAlpha = linkDimmed ? baseAlpha * 0.05 : baseAlpha;
        }
      } else {
        // Curved line for parallel edges
        const mx = (src.x + tgt.x) / 2;
        const my = (src.y + tgt.y) / 2;
        const direction = pIdx % 2 === 0 ? 1 : -1;
        const offset = pCount > 1 ? (Math.floor(pIdx / 2) + 1) * 25 : 0;
        const baseCurvature = Math.min(len * 0.18, 35);
        const curvature = (baseCurvature + offset) * direction;
        const cpx = mx + (dy / len) * curvature;
        const cpy = my - (dx / len) * curvature;

        ctx.beginPath();
        ctx.moveTo(src.x, src.y);
        ctx.quadraticCurveTo(cpx, cpy, tgt.x, tgt.y);
        ctx.stroke();

        // Arrow for depends_on only
        if (isDepends) {
          const angle = Math.atan2(tgt.y - cpy, tgt.x - cpx);
          const tgtR = getNodeSize(tgt, taskLinkCounts) + 4;
          const ax = tgt.x - Math.cos(angle) * tgtR;
          const ay = tgt.y - Math.sin(angle) * tgtR;
          const arrowLen = 10;
          ctx.setLineDash([]);
          ctx.fillStyle = edgeColor;
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(
            ax - arrowLen * Math.cos(angle - 0.5),
            ay - arrowLen * Math.sin(angle - 0.5),
          );
          ctx.lineTo(
            ax - arrowLen * Math.cos(angle + 0.5),
            ay - arrowLen * Math.sin(angle + 0.5),
          );
          ctx.closePath();
          ctx.fill();
        }

        // Flow dots for depends_on — animate along quadratic curve
        if (isDepends && !linkDimmed && effFlowDots) {
          const now = performance.now() / 1000;
          const speed = 0.25;
          const dotCount = 3;
          const dotRadius = 2.5;
          const srcR = getNodeSize(src, taskLinkCounts);
          const tgtR = getNodeSize(tgt, taskLinkCounts);
          const startT = srcR / len;
          const endT = 1 - tgtR / len;
          ctx.fillStyle = edgeColor;
          for (let i = 0; i < dotCount; i++) {
            const phase = (now * speed + i / dotCount) % 1;
            const ct = startT + phase * (endT - startT);
            const px =
              (1 - ct) * (1 - ct) * src.x +
              2 * (1 - ct) * ct * cpx +
              ct * ct * tgt.x;
            const py =
              (1 - ct) * (1 - ct) * src.y +
              2 * (1 - ct) * ct * cpy +
              ct * ct * tgt.y;
            const dotAlpha = Math.sin(phase * Math.PI) * baseAlpha * 0.8;
            ctx.globalAlpha = dotAlpha;
            ctx.beginPath();
            ctx.arc(px, py, dotRadius, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.globalAlpha = linkDimmed ? baseAlpha * 0.05 : baseAlpha;
        }
      }

      ctx.setLineDash([]);
    }

    // --- Hovered edge label (pill on hover only) ---
    const hovEdge = hoveredEdgeRef.current;
    if (hovEdge) {
      const hSrc = hovEdge.source as GraphNode;
      const hTgt = hovEdge.target as GraphNode;
      if (
        hSrc.x != null &&
        hSrc.y != null &&
        hTgt.x != null &&
        hTgt.y != null
      ) {
        const emx = (hSrc.x + hTgt.x) / 2;
        const emy = (hSrc.y + hTgt.y) / 2;
        const label = isNoteLinkType(hovEdge.type)
          ? NOTE_EDGE_STYLE[hovEdge.type].label
          : hovEdge.type === "depends_on"
            ? "depends"
            : "relates";
        const edgeColor =
          hovEdge.type === "note_note"
            ? theme.noteLink
            : isNoteLinkType(hovEdge.type)
              ? theme.noteEdge
              : (EDGE_COLOR[hovEdge.type] ?? "#6b7280");
        ctx.globalAlpha = 0.9;
        ctx.font = `700 8px "GeistMono Variable", "GeistMono", monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const tw = ctx.measureText(label).width + 8;
        ctx.fillStyle = theme.surface;
        ctx.beginPath();
        ctx.roundRect(emx - tw / 2, emy - 8, tw, 16, 4);
        ctx.fill();
        ctx.fillStyle = edgeColor;
        ctx.fillText(label, emx, emy);
      }
    }

    // --- Nodes ---
    for (const n of nodes) {
      if (n.x == null || n.y == null) continue;

      const enterProgress = easeOutCubic(n._enterT);
      if (enterProgress < 0.01) continue;

      const isSelected = n.id === selectedNodeId;
      const isHovered = n.id === hovered;
      const nodeAlpha = enterProgress * (1 - n._dimT * 0.85);

      ctx.globalAlpha = nodeAlpha;

      const entranceScale = 0.3 + 0.7 * enterProgress;
      const sz = getNodeSize(n, taskLinkCounts);

      // Off-screen cull — use the halo radius (sz * 2.5) as the AABB so a
      // node whose body is off-screen but whose halo bleeds into view stays
      // drawn. Animation lerps already ran above, so a node scrolled into
      // view still has the right `_enterT` / `_dimT` / hover state.
      const haloR = sz * 2.5;
      if (
        n.x + haloR < viewLeft ||
        n.x - haloR > viewRight ||
        n.y + haloR < viewTop ||
        n.y - haloR > viewBottom
      )
        continue;

      // Display stage — `plannable` / `ready` are derived sub-stages the
      // parent computes from edges + criteria. They paint with the planned
      // colour but the body stays hollow so the operator can spot
      // "actionable next" at a glance. Note nodes bypass the stage map and
      // key by `note:<type>` so the gradient caches stay stage-keyed.
      const isNote = n.kind === "note";
      const stage = isNote
        ? `note:${n.noteType ?? "reference"}`
        : (stageMap?.get(n.id) ?? n.status);
      const isHollowStage = stage === "plannable" || stage === "ready";
      const sc = stageColor(stage);
      const [sr, sg, sb] = hexToRgb(sc);

      ctx.save();
      ctx.translate(n.x, n.y);
      // Combine entrance + hover/focus scale so a selected node lifts
      // smoothly (1 → ~1.18) instead of snapping bigger on click.
      const focusScale = 1 + 0.18 * easeOutCubic(n._hoverT);
      const finalScale = entranceScale * focusScale;
      ctx.scale(finalScale, finalScale);

      // Ambient glow behind node — gradient is cached per (stage, sz);
      // the dim factor `(1 - n._dimT)` is applied via globalAlpha so the
      // gradient's RGBA stops stay constant and reusable.
      if (effHalo && n._dimT < 0.5) {
        ctx.globalAlpha = nodeAlpha * (1 - n._dimT);
        ctx.fillStyle = getHaloGradient(stage, sz);
        ctx.beginPath();
        ctx.arc(0, 0, sz * 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = nodeAlpha;
      }

      // Selection/hover glow — `shadowBlur` is one of the slowest 2D-canvas
      // ops, so adaptive level 2 drops it entirely. The selection ring is
      // still drawn below; we just lose the soft outer glow.
      if (effShadowBlur) {
        if (n._selectGlow > 0.01) {
          ctx.shadowColor = ACCENT;
          ctx.shadowBlur = 14 * n._selectGlow;
        } else if (isHovered) {
          ctx.shadowColor = theme.hoverGlow;
          ctx.shadowBlur = 8;
        }
      }

      // Body fill — solid faint wash for hollow stages (plannable / ready)
      // so the entrance fade still reads, otherwise the cached radial
      // gradient (or a solid fill at adaptive level 2). Gradients are
      // cached per (stage, sz); their user-space coords get mapped through
      // the current transform at fill time, so one cached gradient renders
      // correctly under every node's local translate/scale. Note nodes
      // draw a rounded square — shape discriminates entity kind, color
      // discriminates note type.
      ctx.beginPath();
      if (isNote) {
        const half = sz * 0.85;
        ctx.roundRect(-half, -half, half * 2, half * 2, sz * 0.35);
      } else {
        ctx.arc(0, 0, sz, 0, Math.PI * 2);
      }
      if (isHollowStage) {
        ctx.fillStyle = `rgba(${sr},${sg},${sb},0.06)`;
      } else if (effGradientFill) {
        ctx.fillStyle = getFillGradient(stage, sz);
      } else {
        ctx.fillStyle = `rgba(${sr},${sg},${sb},${theme.fillInnerAlpha})`;
      }
      ctx.fill();

      if (isNote) {
        // Thin solid type-colored ring — no lifecycle dash vocabulary on
        // notes; the rounded square already sets them apart. Selection
        // swaps to the shared accent ring, same as tasks.
        ctx.lineWidth = isSelected ? 2.5 : 1.5;
        ctx.strokeStyle = isSelected
          ? ACCENT
          : `rgba(${sr},${sg},${sb},${isHovered ? 1.0 : 0.85})`;
        ctx.setLineDash([]);
        ctx.stroke();
        // Fed marker — solid type-colored corner dot, echoing the "ready"
        // inner-dot convention (dot = armed). Type color, not accent: the
        // accent dot outside the node already means "pinned".
        if (n.fed) {
          const half = sz * 0.85;
          ctx.fillStyle = `rgba(${sr},${sg},${sb},1)`;
          ctx.beginPath();
          ctx.arc(half * 0.95, -half * 0.95, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
      } else {
        // Stage-specific ring. Convention across the workspace (rail, hover
        // card, structure list, canvas):
        //   dashed         → spec stage (draft, plannable, cancelled)
        //   solid          → committed plan / executing / done (planned, in_progress, done)
        //   solid + dot    → committed plan AND deps done — ready to fire (ready)
        // Hollow stages (plannable / ready) get a thicker, opaque stroke so
        // the ring pops against the hollow body.
        ctx.lineWidth = isSelected ? 2.5 : isHollowStage ? 2 : 1.5;
        ctx.strokeStyle = isSelected
          ? ACCENT
          : `rgba(${sr},${sg},${sb},${isSelected || isHovered || isHollowStage ? 1.0 : 0.8})`;

        switch (stage) {
          case "done":
            ctx.setLineDash([]);
            break;
          case "in_progress":
            ctx.setLineDash([]);
            // Pulsing glow on `in_progress` nodes — the `Math.sin(Date.now())`
            // tick guarantees a redraw every frame, so `effShadowPulse` gates
            // both the visual AND the render-loop trigger that keeps the loop
            // from going idle. At level 2 the node still reads as in-progress
            // via the solid status ring.
            if (effShadowBlur && effShadowPulse) {
              ctx.shadowColor = sc;
              ctx.shadowBlur = 6 + Math.sin(Date.now() / 400) * 3;
            }
            break;
          case "in_review":
            // Solid violet ring + filled body, no pulse — the work is done,
            // the node is calmly waiting on a human gate. Distinguished from
            // in_progress (amber + pulse) and done (green) by colour alone.
            ctx.setLineDash([]);
            break;
          case "planned":
          case "ready":
            // Solid blue ring. `ready` adds an inner filled dot below
            // (after the stroke) so it reads as "queued / all-clear" against
            // the otherwise-hollow body.
            ctx.setLineDash([]);
            break;
          case "plannable":
            // Dashed blue ring + hollow body — "draft has criteria, ready to
            // be planned". Visually similar to draft but in planned-blue.
            ctx.setLineDash([3, 4]);
            break;
          case "cancelled":
            ctx.setLineDash([4, 3]);
            ctx.globalAlpha = nodeAlpha * 0.45;
            break;
          default: // draft
            // Slightly looser dash + far less aggressive dim — the previous
            // 0.6 multiplier on a #9ca3af fill made draft nodes invisible
            // against the canvas surface in dark mode.
            ctx.setLineDash([2, 4]);
            ctx.globalAlpha = nodeAlpha * 0.85;
            break;
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;

      // Ready-stage inner dot — solid filled marker inside the otherwise
      // hollow body. Mirrors the `ring-bold` SVG glyph used by the rail,
      // hover card, and structure list so the operator sees the same
      // "queued, all-clear" cue everywhere a `ready` task appears.
      if (stage === "ready") {
        ctx.fillStyle = `rgba(${sr},${sg},${sb},1)`;
        ctx.beginPath();
        ctx.arc(0, 0, sz * 0.35, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();

      // Pinned indicator — only when the user has manually pinned by drag.
      // The selected-node pin used by the focus lifecycle is structural and
      // should not show this affordance.
      if (n.fx != null && n.fy != null && n.id !== selectedNodeId) {
        ctx.globalAlpha = nodeAlpha * 0.8;
        ctx.beginPath();
        ctx.arc(n.x + sz + 3, n.y - sz - 3, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = ACCENT;
        ctx.fill();
      }

      // Adaptive labels — always for selected/hovered. Otherwise gated by
      // zoom + connectivity, scaled by graph size: 200-node projects only
      // show hub labels at default zoom, 30-node projects show everything.
      const edgeCount = taskLinkCounts.get(n.id) ?? 0;
      const isHub = edgeCount >= 5;
      const isMidHub = edgeCount >= 3;
      const showLabel =
        isSelected ||
        isHovered ||
        zoomScale >= 0.85 * labelScale ||
        (zoomScale >= 0.55 * labelScale && isMidHub) ||
        (zoomScale >= 0.3 * labelScale && isHub);

      if (showLabel && enterProgress > 0.5) {
        const labelAlpha = nodeAlpha * Math.min(1, (enterProgress - 0.5) * 2);
        ctx.globalAlpha = labelAlpha;

        const label =
          n.title.length > 18 ? n.title.slice(0, 17) + "…" : n.title;
        ctx.font = `500 12px "Inter Variable", "Inter", sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";

        const metrics = ctx.measureText(label);
        const ly = n.y + sz * finalScale + 8;
        const pw = 5,
          ph = 3;
        const lw = metrics.width + pw * 2;
        const lh = 14 + ph * 2;

        // Pill background
        ctx.globalAlpha = labelAlpha * 0.85;
        ctx.fillStyle = theme.surface;
        ctx.beginPath();
        ctx.roundRect(n.x - lw / 2, ly - ph, lw, lh, 4);
        ctx.fill();

        // Label text
        ctx.globalAlpha = labelAlpha;
        ctx.fillStyle = theme.labelText;
        ctx.fillText(label, n.x, ly);
      }
    }

    ctx.restore();
    ctx.globalAlpha = 1;

    // Tooltip (screen-space, after ctx.restore)
    const tip = tooltipRef.current;
    if (tip) {
      ctx.save();
      ctx.font = '11px "GeistMono Variable", "GeistMono", monospace';
      const metrics = ctx.measureText(tip.text);
      const pw = 10;
      const tw = metrics.width + pw * 2;
      const th = 24;
      const tx = Math.min(tip.x + 14, w - tw - 4);
      const ty = Math.max(tip.y - th - 6, 4);
      ctx.fillStyle = theme.tooltipBg;
      ctx.beginPath();
      ctx.roundRect(tx, ty, tw, th, 5);
      ctx.fill();
      ctx.strokeStyle = theme.tooltipBorder;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = theme.tooltipText;
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      ctx.fillText(tip.text, tx + pw, ty + th / 2);
      ctx.restore();
    }
  }, [
    nodes,
    links,
    size,
    selectedNodeId,
    theme,
    taskLinkCounts,
    parallelMeta,
    hoveredIdHint,
    tier,
    reducedMotion,
    labelScale,
    stageMap,
  ]);

  // Redraw whenever the external hint changes so the highlight is responsive.
  useEffect(() => {
    needsRedrawRef.current = true;
  }, [hoveredIdHint]);

  // Stage map flips (a draft becoming plannable, a planned task gaining
  // ready) don't change topology, so the topology effect won't fire — we
  // need to flag a redraw explicitly.
  useEffect(() => {
    needsRedrawRef.current = true;
  }, [stageMap]);

  // -----------------------------------------------------------------------
  // Camera effect — single source of truth for automated viewport changes.
  //
  // Transitions:
  //   focused           → animate centre-on-selected
  //   settled           → animate fit-to-graph
  //   settling / cold   → no-op (the simulation owns the layout)
  //
  // On selection change the user override is cleared, so a click after a
  // pan still focuses correctly. Background data updates do NOT change
  // `state` and therefore do NOT move the camera — that is the whole point
  // of the lifecycle rewrite.
  // -----------------------------------------------------------------------
  const lastCamKeyRef = useRef<string>("");
  // First camera fit on mount snaps instantly — animating from the default
  // `(0, 0, 1)` transform would flash the graph through "top-left" before
  // landing on the fitted view. Subsequent fits animate normally.
  const hasFitOnceRef = useRef(false);
  useEffect(() => {
    // Selection changed — user is signalling they want camera movement.
    userOverrideRef.current = false;
  }, [selectedNodeId]);

  useEffect(() => {
    const sz = sizeRef.current;
    if (sz.width === 0 || sz.height === 0) return;
    if (state === "cold") return;
    if (userOverrideRef.current) return;

    // De-dupe: identical (state, selectedNodeId, rightInset, size) combos
    // shouldn't re-fire the animation if React happens to re-run the effect
    // for an unrelated dep change.
    const key = `${state}:${selectedNodeId ?? ""}:${rightInset}:${sz.width}x${sz.height}`;
    if (lastCamKeyRef.current === key) return;
    lastCamKeyRef.current = key;

    if (state === "focused" && selectedNodeId) {
      const node = nodesForFitRef.current.find((n) => n.id === selectedNodeId);
      if (node) {
        const targetScale = Math.max(transformRef.current.scale, 0.9);
        const target = focusTransform(node, sz, rightInset, targetScale);
        if (target) {
          if (!hasFitOnceRef.current) {
            transformRef.current = target;
            setZoomLevel(target.scale);
            needsRedrawRef.current = true;
            hasFitOnceRef.current = true;
          } else {
            animateTransform(target, 380);
            setZoomLevel(target.scale);
          }
        }
      }
      return;
    }

    // Settling: first impression starts zoomed in close to the cluster.
    // The render loop's chase camera (below) lerps the transform toward the
    // expanding bbox each frame, producing a cinematic zoom-out as the
    // simulation spreads the nodes. On `settled`, animate to the final fit
    // in case the chase didn't fully converge.
    if (state === "settling" || state === "settled") {
      const target = fitTransform(nodesForFitRef.current, sz, rightInset);
      if (target) {
        if (!hasFitOnceRef.current) {
          // Zoom in 1.3× past the natural fit so the user starts close to
          // the cluster. Pan adjusted so the centre stays put under the
          // tighter scale.
          const ZOOM_IN = 1.3;
          const cx = sz.width / 2;
          const cy = sz.height / 2;
          const startScale = Math.min(target.scale * ZOOM_IN, 2);
          transformRef.current = {
            x: cx - (cx - target.x) * (startScale / target.scale),
            y: cy - (cy - target.y) * (startScale / target.scale),
            scale: startScale,
          };
          setZoomLevel(startScale);
          needsRedrawRef.current = true;
          hasFitOnceRef.current = true;
        } else {
          animateTransform(target, state === "settled" ? 480 : 360);
          setZoomLevel(target.scale);
        }
      }
    }
  }, [state, selectedNodeId, rightInset, size, animateTransform]);

  // Disable mirrors the lerp-mutation site inside `draw()`.
  // eslint-disable-next-line react-hooks/immutability
  useEffect(() => {
    let raf: number;
    let running = true;
    /** Rolling-window size for FPS estimation. 30 frames ≈ 500 ms at 60 fps. */
    const FRAME_WINDOW = 30;
    /** Min interval between an escalation (more degrade) — anti-flap. */
    const ESCALATE_DEBOUNCE_MS = 500;
    /** Recovery hold time — must sustain healthy FPS this long before stepping back up. */
    const RECOVERY_DEBOUNCE_MS = 2000;
    /**
     * Push a frame timestamp and step the adaptive level up (degrade) or
     * down (recover) based on the rolling FPS estimate. Mutates `perfRef`
     * in place — never triggers React state updates.
     */
    const samplePerf = () => {
      const p = perfRef.current;
      const now = performance.now();
      p.frames.push(now);
      if (p.frames.length > FRAME_WINDOW) p.frames.shift();
      if (p.frames.length < FRAME_WINDOW) return;
      const span = now - p.frames[0];
      if (span <= 0) return;
      const fps = ((FRAME_WINDOW - 1) * 1000) / span;
      const sinceChange = now - p.lastChangeAt;
      if (sinceChange < ESCALATE_DEBOUNCE_MS) return;
      if (fps < 25 && p.level < 2) {
        p.level = 2;
        p.lastChangeAt = now;
      } else if (fps < 40 && p.level < 1) {
        p.level = 1;
        p.lastChangeAt = now;
      } else if (
        fps > 55 &&
        p.level > 0 &&
        sinceChange > RECOVERY_DEBOUNCE_MS
      ) {
        p.level = (p.level - 1) as 0 | 1;
        p.lastChangeAt = now;
      }
    };
    const loop = () => {
      if (!running) return;

      // Tick transform animation
      const anim = animRef.current;
      if (anim) {
        const elapsed = performance.now() - anim.startTime;
        const raw = Math.min(1, elapsed / anim.duration);
        const t = easeOutCubic(raw);
        transformRef.current = {
          x: anim.startX + (anim.endX - anim.startX) * t,
          y: anim.startY + (anim.endY - anim.startY) * t,
          scale: anim.startScale + (anim.endScale - anim.startScale) * t,
        };
        setZoomLevel(transformRef.current.scale);
        needsRedrawRef.current = true;
        if (raw >= 1) animRef.current = null;
      } else if (ticking && !userOverrideRef.current && nodes.length > 0) {
        // Chase camera — during settling, lerp the transform toward the
        // current fit-bbox each frame. Combined with the close-in initial
        // snap, this produces a cinematic zoom-out reveal: start tight on
        // the spawn cluster, widen smoothly as the simulation spreads it.
        const sz = sizeRef.current;
        if (sz.width > 0 && sz.height > 0) {
          const target = fitTransform(nodesForFitRef.current, sz, rightInset);
          if (target) {
            const tr = transformRef.current;
            // Reduced motion snaps the chase to the fit target instead of
            // gliding through the cinematic zoom-out reveal.
            const lerp = reducedMotion ? 1 : 0.04;
            const dx = target.x - tr.x;
            const dy = target.y - tr.y;
            const ds = target.scale - tr.scale;
            // Skip the lerp if we're effectively at the target — avoids
            // micro-jitter once the chase converges.
            if (
              Math.abs(dx) > 0.5 ||
              Math.abs(dy) > 0.5 ||
              Math.abs(ds) > 0.001
            ) {
              tr.x += dx * lerp;
              tr.y += dy * lerp;
              tr.scale += ds * lerp;
              setZoomLevel(tr.scale);
              needsRedrawRef.current = true;
            }
          }
        }
      }

      // Gate the loop's redraw triggers by the same adaptive booleans the
      // draw() body uses — otherwise level 2 would still wake the loop every
      // frame for `hasAnimating` / `hasFlowDots` / `hasInProgress` and never
      // actually save anything.
      const lvl = perfRef.current.level;
      const flowOn = tier.flowDots && lvl === 0 && !reducedMotion;
      const pulseOn = lvl < 2 && !reducedMotion;
      const lerpsOn = lvl < 2 && !reducedMotion;

      const hasInProgress =
        pulseOn && nodes.some((n) => n.status === "in_progress");
      const hoveredId = hoveredRef.current ?? hoveredIdHint;
      const hasAnimating =
        lerpsOn &&
        nodes.some((n) => {
          if (n._enterT < 0.99) return true;
          const dimTarget =
            selectedNodeId && !connectedSetRef.current.has(n.id) ? 1 : 0;
          if (Math.abs(n._dimT - dimTarget) > 0.01) return true;
          const glowTarget = n.id === selectedNodeId ? 1 : 0;
          if (Math.abs(n._selectGlow - glowTarget) > 0.01) return true;
          const focusTarget =
            n.id === hoveredId || n.id === selectedNodeId ? 1 : 0;
          if (Math.abs(n._hoverT - focusTarget) > 0.01) return true;
          return false;
        });
      const hasFlowDots = flowOn && links.some((l) => l.type === "depends_on");
      if (
        needsRedrawRef.current ||
        ticking ||
        hasAnimating ||
        hasInProgress ||
        hasFlowDots ||
        animRef.current
      ) {
        samplePerf();
        draw();
        needsRedrawRef.current = false;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      running = false;
      cancelAnimationFrame(raf);
    };
  }, [
    draw,
    ticking,
    nodes,
    links,
    selectedNodeId,
    hoveredIdHint,
    tier,
    reducedMotion,
    rightInset,
  ]);

  // --- Pointer events ---
  /** Cancel a pending long-press pin, if any. */
  const clearLongPress = useCallback(() => {
    if (longPressRef.current !== null) {
      clearTimeout(longPressRef.current);
      longPressRef.current = null;
    }
  }, []);
  useEffect(() => clearLongPress, [clearLongPress]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const ap = activePointersRef.current;
      ap.set(e.pointerId, { x: sx, y: sy });
      canvasRef.current?.setPointerCapture(e.pointerId);

      // Second finger down — the gesture becomes a pinch. Kill the click
      // intent and any long-press; a node mid-drag stays where it is
      // (fx/fy only set once moved, matching drag-pin semantics).
      if (ap.size === 2) {
        clearLongPress();
        const [p1, p2] = [...ap.values()];
        pinchRef.current = {
          prevDist: Math.hypot(p1.x - p2.x, p1.y - p2.y) || 1,
          prevCx: (p1.x + p2.x) / 2,
          prevCy: (p1.y + p2.y) / 2,
        };
        dragRef.current.moved = true;
        dragRef.current.active = false;
        animRef.current = null;
        userOverrideRef.current = true;
        return;
      }
      if (ap.size > 2) return;

      const [wx, wy] = screenToWorld(sx, sy);
      const hit = hitTest(wx, wy);
      dragRef.current = {
        active: true,
        nodeId: hit?.id ?? null,
        nodeKind: hit?.kind ?? null,
        panning: !hit,
        startX: sx,
        startY: sy,
        originX: sx,
        originY: sy,
        moved: false,
      };

      // Touch parity for double-click: holding a node toggles its pin.
      // `moved` is set so the subsequent pointerup doesn't also select.
      if (e.pointerType === "touch" && hit) {
        clearLongPress();
        longPressRef.current = setTimeout(() => {
          longPressRef.current = null;
          const drag = dragRef.current;
          if (
            pinchRef.current ||
            !drag.active ||
            drag.moved ||
            drag.nodeId !== hit.id
          ) {
            return;
          }
          if (hit.fx != null) {
            hit.fx = null;
            hit.fy = null;
          } else {
            hit.fx = hit.x ?? null;
            hit.fy = hit.y ?? null;
          }
          drag.moved = true;
          reheat();
          needsRedrawRef.current = true;
        }, LONG_PRESS_MS);
      }
    },
    [screenToWorld, hitTest, clearLongPress, reheat],
  );

  const pointerMoveRaf = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (pointerMoveRaf.current != null) {
        cancelAnimationFrame(pointerMoveRaf.current);
        pointerMoveRaf.current = null;
      }
    };
  }, []);
  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const ap = activePointersRef.current;
      if (ap.has(e.pointerId)) ap.set(e.pointerId, { x: sx, y: sy });

      // Pinch — zoom about the two-finger centroid (same math as the wheel
      // path) plus pan by the centroid delta. Runs before every other
      // branch; drag/pan/hover never see multi-touch moves.
      if (pinchRef.current && ap.size >= 2) {
        const [p1, p2] = [...ap.values()];
        const cx = (p1.x + p2.x) / 2;
        const cy = (p1.y + p2.y) / 2;
        const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y) || 1;
        const p = pinchRef.current;
        const t = transformRef.current;
        const newScale = Math.min(
          MAX_ZOOM,
          Math.max(MIN_ZOOM, t.scale * (dist / p.prevDist)),
        );
        t.x = cx - (cx - t.x) * (newScale / t.scale);
        t.y = cy - (cy - t.y) * (newScale / t.scale);
        t.scale = newScale;
        t.x += cx - p.prevCx;
        t.y += cy - p.prevCy;
        p.prevDist = dist;
        p.prevCx = cx;
        p.prevCy = cy;
        setZoomLevel(newScale);
        needsRedrawRef.current = true;
        return;
      }

      const drag = dragRef.current;

      if (drag.active && drag.nodeId) {
        if (!drag.moved && Math.hypot(sx - drag.originX, sy - drag.originY) < 4)
          return;
        if (!drag.moved) clearLongPress();
        drag.moved = true;
        const [wx, wy] = screenToWorld(sx, sy);
        const node = nodes.find((n) => n.id === drag.nodeId);
        if (node) {
          node.fx = wx;
          node.fy = wy;
          // Reheat on every move keeps neighbours integrating around the drag.
          // The hook's reheat preserves focused state when a selection is live.
          if (!ticking) reheat();
        }
        needsRedrawRef.current = true;
      } else if (drag.active && drag.panning) {
        if (!drag.moved && Math.hypot(sx - drag.originX, sy - drag.originY) < 2)
          return;
        drag.moved = true;
        animRef.current = null;
        userOverrideRef.current = true;
        transformRef.current.x += sx - drag.startX;
        transformRef.current.y += sy - drag.startY;
        drag.startX = sx;
        drag.startY = sy;
        needsRedrawRef.current = true;
      } else {
        if (pointerMoveRaf.current) return;
        pointerMoveRaf.current = requestAnimationFrame(() => {
          pointerMoveRaf.current = null;
          const [wx, wy] = screenToWorld(sx, sy);
          const hit = hitTest(wx, wy);
          const prevHovered = hoveredRef.current;
          hoveredRef.current = hit?.id ?? null;
          if (prevHovered !== hoveredRef.current) {
            needsRedrawRef.current = true;
            onHoverNode?.(hoveredRef.current);
          }

          // Edge hover detection
          if (!hit) {
            const prevEdge = hoveredEdgeRef.current;
            hoveredEdgeRef.current = edgeHitTest(wx, wy);
            if (prevEdge !== hoveredEdgeRef.current)
              needsRedrawRef.current = true;
          } else {
            if (hoveredEdgeRef.current) {
              hoveredEdgeRef.current = null;
              needsRedrawRef.current = true;
            }
          }

          if (hit) {
            const isPinned =
              hit.fx != null && hit.fy != null && hit.id !== selectedNodeId;
            const suffix = isPinned ? " (dbl-click to unpin)" : "";
            const typeLabel =
              hit.kind === "note" && hit.noteType
                ? ` · ${NOTE_TYPE_META[hit.noteType].label}`
                : "";
            const fedLabel =
              hit.kind === "note" && hit.fed ? " · feeds tasks" : "";
            tooltipRef.current = {
              text: `${hit.taskRef} · ${hit.title}${typeLabel}${fedLabel}${suffix}`,
              x: sx,
              y: sy,
            };
          } else {
            tooltipRef.current = null;
          }
          if (hit) needsRedrawRef.current = true;
        });
      }
    },
    [
      screenToWorld,
      hitTest,
      edgeHitTest,
      nodes,
      reheat,
      ticking,
      onHoverNode,
      selectedNodeId,
      clearLongPress,
    ],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      clearLongPress();
      const ap = activePointersRef.current;
      ap.delete(e.pointerId);
      canvasRef.current?.releasePointerCapture(e.pointerId);

      // Pinch teardown — when a finger lifts mid-pinch the gesture degrades
      // to a single-finger pan already marked `moved`, so the remaining
      // finger neither hovers nor fires a spurious click on its own up.
      if (pinchRef.current) {
        if (ap.size < 2) {
          pinchRef.current = null;
          const remaining = [...ap.values()][0];
          dragRef.current = {
            active: remaining !== undefined,
            nodeId: null,
            nodeKind: null,
            panning: remaining !== undefined,
            startX: remaining?.x ?? 0,
            startY: remaining?.y ?? 0,
            originX: remaining?.x ?? 0,
            originY: remaining?.y ?? 0,
            moved: true,
          };
        }
        needsRedrawRef.current = true;
        return;
      }

      const drag = dragRef.current;
      // Use the `moved` flag (not the rolling startX/Y, which the pan branch
      // updates each tick) to distinguish click from drag. This is the fix
      // for the "every pan deselects" bug: after a pan, drag.startX === sx,
      // so any distance-based check would misread the gesture as a click.
      if (drag.active && !drag.moved) {
        if (drag.nodeId) {
          // Note clicks route by gesture: the parent opens the in-graph
          // preview for pointer clicks and jumps straight to the notes
          // surface for touch taps.
          if (drag.nodeKind === "note") {
            onSelectNote?.(drag.nodeId, e.pointerType === "touch");
          } else {
            onSelectNode(drag.nodeId);
          }
        } else {
          onDeselect?.();
        }
      }
      dragRef.current = {
        active: false,
        nodeId: null,
        nodeKind: null,
        panning: false,
        startX: 0,
        startY: 0,
        originX: 0,
        originY: 0,
        moved: false,
      };
      needsRedrawRef.current = true;
    },
    [onSelectNode, onSelectNote, onDeselect, clearLongPress],
  );

  /**
   * Pointer cancellation (browser gesture takeover, palm rejection, tab
   * switch mid-touch): reset the gesture state machine WITHOUT the click
   * branch — a cancelled touch previously stranded `dragRef.active`.
   */
  const handlePointerCancel = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      clearLongPress();
      const ap = activePointersRef.current;
      ap.delete(e.pointerId);
      if (ap.size < 2) pinchRef.current = null;
      canvasRef.current?.releasePointerCapture(e.pointerId);
      dragRef.current = {
        active: false,
        nodeId: null,
        nodeKind: null,
        panning: false,
        startX: 0,
        startY: 0,
        originX: 0,
        originY: 0,
        moved: false,
      };
      needsRedrawRef.current = true;
    },
    [clearLongPress],
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const [wx, wy] = screenToWorld(
        e.clientX - rect.left,
        e.clientY - rect.top,
      );
      const hit = hitTest(wx, wy);
      if (hit && hit.fx != null) {
        hit.fx = null;
        hit.fy = null;
        // The hook's reheat preserves focused state when a selection is
        // live, so unpinning the focused node releases its anchor without
        // dragging the camera off it.
        reheat();
      }
    },
    [screenToWorld, hitTest, reheat],
  );

  // React's onWheel is registered as a *passive* listener so its
  // `preventDefault()` is silently ignored — the browser still scrolls the
  // page on some touchpads. Attach the wheel handler natively with
  // `{ passive: false }` so zoom intercepts the gesture cleanly.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      animRef.current = null;
      userOverrideRef.current = true;
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const t = transformRef.current;
      const factor = e.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR;
      const newScale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, t.scale * factor));
      t.x = sx - (sx - t.x) * (newScale / t.scale);
      t.y = sy - (sy - t.y) * (newScale / t.scale);
      t.scale = newScale;
      setZoomLevel(newScale);
      needsRedrawRef.current = true;
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  // --- Control callbacks ---
  const zoomIn = useCallback(() => {
    userOverrideRef.current = true;
    const t = transformRef.current;
    const cx = size.width / 2;
    const cy = size.height / 2;
    const ns = Math.min(MAX_ZOOM, t.scale * ZOOM_FACTOR);
    animateTransform(
      {
        x: cx - (cx - t.x) * (ns / t.scale),
        y: cy - (cy - t.y) * (ns / t.scale),
        scale: ns,
      },
      200,
    );
    setZoomLevel(ns);
  }, [size, animateTransform]);

  const zoomOut = useCallback(() => {
    userOverrideRef.current = true;
    const t = transformRef.current;
    const cx = size.width / 2;
    const cy = size.height / 2;
    const ns = Math.max(MIN_ZOOM, t.scale / ZOOM_FACTOR);
    animateTransform(
      {
        x: cx - (cx - t.x) * (ns / t.scale),
        y: cy - (cy - t.y) * (ns / t.scale),
        scale: ns,
      },
      200,
    );
    setZoomLevel(ns);
  }, [size, animateTransform]);

  const fitToScreen = useCallback(() => {
    userOverrideRef.current = false;
    const target = fitTransform(nodes, size, rightInset);
    if (target) {
      animateTransform(target, 400);
      setZoomLevel(target.scale);
    }
  }, [nodes, size, rightInset, animateTransform]);

  const resetView = useCallback(() => {
    userOverrideRef.current = false;
    lastCamKeyRef.current = "";
    reset();
  }, [reset]);

  const isEmpty = tasks.length === 0 && notes.length === 0;
  const allFiltered =
    !isEmpty && filteredTasks.length === 0 && visibleNotes.length === 0;

  return (
    <div ref={containerRef} className={`relative h-full w-full ${className}`}>
      {isEmpty ? (
        <div className="flex h-full w-full flex-col items-center justify-center p-8">
          <p className="text-sm text-text-secondary">No tasks to visualize</p>
          <p className="mt-1 text-xs text-text-muted">
            Add tasks to see your project graph.
          </p>
        </div>
      ) : allFiltered ? (
        <div className="flex h-full w-full flex-col items-center justify-center p-8">
          <p className="text-sm text-text-secondary">
            All tasks are hidden by filters
          </p>
          <p className="mt-1 text-xs text-text-muted">
            Toggle status filters to show tasks.
          </p>
        </div>
      ) : (
        <>
          <canvas
            ref={canvasRef}
            className="absolute inset-0 cursor-grab touch-none active:cursor-grabbing"
            style={{ width: size.width, height: size.height }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onDoubleClick={handleDoubleClick}
          />
          <GraphControls
            onZoomIn={zoomIn}
            onZoomOut={zoomOut}
            onReset={resetView}
            onFitToScreen={fitToScreen}
            zoomLevel={zoomLevel}
            rightInset={rightInset}
          />
        </>
      )}
    </div>
  );
}

export default ForceGraph;
