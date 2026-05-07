"use client";

import { useRef, useEffect, useCallback, useState, useMemo } from "react";
import { quadtree } from "d3-quadtree";
import type { TaskEdge } from "@/lib/db/schema";
import type { TaskGraphSlim } from "@/lib/data/views";
import type { EdgeType } from "@/lib/types";
import { useForceSimulation } from "./useForceSimulation";
import { GraphControls } from "./GraphControls";
import {
  type GraphNode,
  type GraphLink,
  EDGE_COLOR,
  RELATES_DASH,
  RELATES_OPACITY,
  ACCENT,
  ZOOM_FACTOR,
  MIN_ZOOM,
  MAX_ZOOM,
  getCanvasTheme,
  statusColor,
  hexToRgb,
  easeOutCubic,
  getNodeSize,
  buildLinkCounts,
} from "./graphConstants";

/** Props for the ForceGraph component. */
interface ForceGraphProps {
  /** @param tasks - Slim task records (augmented with taskRef) to visualize. */
  tasks: TaskGraphSlim[];
  /** @param edges - TaskEdge records defining relationships. */
  edges: TaskEdge[];
  /** @param selectedNodeId - Currently selected node ID, or null. */
  selectedNodeId: string | null;
  /** @param onSelectNode - Called when a graph node is clicked. */
  onSelectNode: (nodeId: string) => void;
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
   * @param rightInset - Pixels on the right edge of the canvas that are
   *   obscured by an overlay (e.g. a detail slide-over). Drives both the
   *   re-centre target (so the focused node sits inside the visible region)
   *   and the floating GraphControls position (so the controls ride the
   *   overlay edge instead of getting hidden beneath it).
   */
  rightInset?: number;
  /** @param className - Additional CSS classes. */
  className?: string;
}

/** Empty set fallback used when no filter prop is provided. */
const EMPTY_STATUS_SET: ReadonlySet<string> = new Set();
/** Empty set fallback used when no edge filter prop is provided. */
const EMPTY_EDGE_SET: ReadonlySet<EdgeType> = new Set();

/**
 * Detect if light mode is active by checking the HTML class.
 * @returns true if light mode.
 */
function isLightMode(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.classList.contains("light");
}

/**
 * Canvas-based force-directed graph showing tasks with their relationships.
 * Uses live animated layout, smooth animations, and DPR-aware rendering.
 * @param props - Graph data, selection state, and callbacks.
 * @returns Rendered canvas element with graph controls overlay.
 */
export function ForceGraph({
  tasks,
  edges,
  selectedNodeId,
  onSelectNode,
  onDeselect,
  hoveredIdHint = null,
  onHoverNode,
  hiddenStatuses,
  hiddenEdgeTypes,
  rightInset = 0,
  className = "",
}: ForceGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [light, setLight] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(1);

  const statusFilter = hiddenStatuses ?? EMPTY_STATUS_SET;
  const edgeFilter = hiddenEdgeTypes ?? EMPTY_EDGE_SET;

  // Filter tasks/edges by hidden statuses + hidden edge types
  const filteredTasks = useMemo(
    () => tasks.filter(t => !statusFilter.has(t.status)),
    [tasks, statusFilter],
  );
  const filteredTaskIds = useMemo(
    () => new Set(filteredTasks.map(t => t.id)),
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

  // Theme detection with mutation observer
  useEffect(() => {
    setLight(isLightMode());
    const observer = new MutationObserver(() => setLight(isLightMode()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- light triggers re-read of CSS vars
  const theme = useMemo(() => getCanvasTheme(), [light]);

  // Transform state (pan/zoom)
  const transformRef = useRef({ x: 0, y: 0, scale: 1 });
  const transformApplied = useRef(false);
  const dragRef = useRef<{
    active: boolean;
    nodeId: string | null;
    startX: number;
    startY: number;
    panning: boolean;
  }>({ active: false, nodeId: null, startX: 0, startY: 0, panning: false });
  const hoveredRef = useRef<string | null>(null);
  const hoveredEdgeRef = useRef<GraphLink | null>(null);
  const tooltipRef = useRef<{ text: string; x: number; y: number } | null>(null);
  const needsRedrawRef = useRef(true);
  const quadtreeRef = useRef<ReturnType<typeof quadtree<GraphNode>> | null>(null);
  // True until user manually pans/zooms — gates auto-fit on settle
  const shouldAutoFitRef = useRef(true);

  // --- Animated transform transitions ---
  const animRef = useRef<{
    startX: number; startY: number; startScale: number;
    endX: number; endY: number; endScale: number;
    startTime: number; duration: number;
  } | null>(null);

  /**
   * Animate transform from current to target over duration ms.
   * @param target - Target transform {x, y, scale}.
   * @param duration - Animation duration in ms.
   */
  const animateTransform = useCallback((target: { x: number; y: number; scale: number }, duration = 500) => {
    const cur = transformRef.current;
    animRef.current = {
      startX: cur.x, startY: cur.y, startScale: cur.scale,
      endX: target.x, endY: target.y, endScale: target.scale,
      startTime: performance.now(), duration,
    };
    needsRedrawRef.current = true;
  }, []);

  /**
   * Compute the fit-to-screen target transform for a set of nodes.
   * @param nodesArr - Nodes to fit.
   * @param sizeObj - Canvas size.
   * @returns Target transform or null if empty.
   */
  const computeFitTransform = useCallback((nodesArr: GraphNode[], sizeObj: { width: number; height: number }) => {
    if (nodesArr.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodesArr) {
      const x = n.x ?? 0;
      const y = n.y ?? 0;
      const r = 50;
      if (x - r < minX) minX = x - r;
      if (y - r < minY) minY = y - r;
      if (x + r > maxX) maxX = x + r;
      if (y + r > maxY) maxY = y + r;
    }
    const pad = 60;
    const gw = maxX - minX || 1;
    const gh = maxY - minY || 1;
    const scale = Math.min((sizeObj.width - pad * 2) / gw, (sizeObj.height - pad * 2) / gh, 2);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    return {
      x: sizeObj.width / 2 - cx * scale,
      y: sizeObj.height / 2 - cy * scale,
      scale,
    };
  }, []);

  const nodesForFitRef = useRef<GraphNode[]>([]);
  const sizeRef = useRef(size);
  sizeRef.current = size;

  const handleSettle = useCallback(() => {
    if (!shouldAutoFitRef.current) return;
    const target = computeFitTransform(nodesForFitRef.current, sizeRef.current);
    if (target) {
      animateTransform(target, 600);
      transformApplied.current = true;
      setZoomLevel(target.scale);
    }
  }, [computeFitTransform, animateTransform]);

  const { nodes, links, reheat, reset, ticking } = useForceSimulation(
    filteredTasks, filteredEdges, size.width, size.height, handleSettle,
  );

  // Keep ref current for settle callback
  nodesForFitRef.current = nodes;

  // Topology key -- reset auto-fit when graph structure changes
  const topologyKey = useMemo(() => {
    return filteredTasks.map((t) => t.id).sort().join(",");
  }, [filteredTasks]);

  useEffect(() => {
    transformApplied.current = false;
    shouldAutoFitRef.current = true;
  }, [topologyKey]);

  // Link counts for node sizing
  const linkCounts = useMemo(() => buildLinkCounts(links), [links]);

  // Connected-node set for selection highlighting
  const connectedSetRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!selectedNodeId) { connectedSetRef.current.clear(); needsRedrawRef.current = true; return; }
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
  }, [selectedNodeId, links]);

  // Rebuild quadtree when nodes change
  useEffect(() => {
    if (nodes.length === 0) { quadtreeRef.current = null; return; }
    quadtreeRef.current = quadtree<GraphNode>()
      .x((d) => d.x ?? 0)
      .y((d) => d.y ?? 0)
      .addAll(nodes);
    needsRedrawRef.current = true;
  }, [nodes]);

  // ResizeObserver for container
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
  const screenToWorld = useCallback((sx: number, sy: number): [number, number] => {
    const t = transformRef.current;
    return [(sx - t.x) / t.scale, (sy - t.y) / t.scale];
  }, []);

  // Quadtree-based hit testing O(log n)
  const hitTest = useCallback((wx: number, wy: number): GraphNode | null => {
    const qt = quadtreeRef.current;
    if (!qt) return null;
    const maxR = 40;
    const found = qt.find(wx, wy, maxR);
    if (!found) return null;
    const r = getNodeSize(found.id, linkCounts);
    const dx = (found.x ?? 0) - wx;
    const dy = (found.y ?? 0) - wy;
    if (dx * dx + dy * dy <= (r + 5) * (r + 5)) return found;
    return null;
  }, [linkCounts]);

  // Edge midpoint hit test for hover labels
  const edgeHitTest = useCallback((wx: number, wy: number): GraphLink | null => {
    const threshold = 20;
    for (const l of links) {
      const src = l.source as GraphNode;
      const tgt = l.target as GraphNode;
      if (src.x == null || src.y == null || tgt.x == null || tgt.y == null) continue;
      const mx = (src.x + tgt.x) / 2;
      const my = (src.y + tgt.y) / 2;
      const dx = mx - wx;
      const dy = my - wy;
      if (dx * dx + dy * dy <= threshold * threshold) return l;
    }
    return null;
  }, [links]);

  // -----------------------------------------------------------------------
  // Drawing
  // -----------------------------------------------------------------------
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = size.width;
    const h = size.height;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

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

    // Advance per-node animations — gentle lerps for buttery transitions.
    for (const n of nodes) {
      const shouldDim = hasSelection && !connected.has(n.id);
      const dimTarget = shouldDim ? 1 : 0;
      n._dimT += (dimTarget - n._dimT) * 0.085;

      const glowTarget = n.id === selectedNodeId ? 1 : 0;
      n._selectGlow += (glowTarget - n._selectGlow) * 0.10;

      // Hover/focus scale — fires for both pointer hover and selection so the
      // selected node carries the same lift visual without an instant snap.
      const focusTarget = n.id === hovered || n.id === selectedNodeId ? 1 : 0;
      n._hoverT += (focusTarget - n._hoverT) * 0.14;
    }

    // --- Parallel edge index ---
    const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
    const parallelCount = new Map<string, number>();
    for (const l of links) {
      const src = l.source as GraphNode;
      const tgt = l.target as GraphNode;
      const key = edgeKey(src.id, tgt.id);
      parallelCount.set(key, (parallelCount.get(key) ?? 0) + 1);
    }
    const parallelSeen = new Map<string, number>();

    // --- Links ---
    for (const l of links) {
      const src = l.source as GraphNode;
      const tgt = l.target as GraphNode;
      if (src.x == null || src.y == null || tgt.x == null || tgt.y == null) continue;

      const linkDimmed = hasSelection && !connected.has(src.id) && !connected.has(tgt.id);
      const enterAlpha = Math.min(easeOutCubic(src._enterT), easeOutCubic(tgt._enterT));
      const dimAlpha = Math.max(src._dimT, tgt._dimT);

      const isRelates = l.type === "relates_to";
      const edgeColor = EDGE_COLOR[l.type as EdgeType] ?? "#6b7280";
      const baseAlpha = (1 - dimAlpha * 0.85) * enterAlpha * (isRelates ? RELATES_OPACITY : 1);
      ctx.globalAlpha = linkDimmed ? baseAlpha * 0.05 : baseAlpha;
      ctx.lineWidth = isRelates ? 1.5 : 2;

      const dx = tgt.x - src.x;
      const dy = tgt.y - src.y;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;

      // Edge style — depends_on gets a directional gradient (bright at source, fades toward target)
      if (isRelates) {
        ctx.setLineDash(RELATES_DASH);
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

      const pKey = edgeKey(src.id, tgt.id);
      const pCount = parallelCount.get(pKey) ?? 1;
      const pIdx = parallelSeen.get(pKey) ?? 0;
      parallelSeen.set(pKey, pIdx + 1);

      if (pCount === 1) {
        // Straight line for single edges
        ctx.beginPath();
        ctx.moveTo(src.x, src.y);
        ctx.lineTo(tgt.x, tgt.y);
        ctx.stroke();

        // Arrow for depends_on only
        if (!isRelates) {
          const tgtR = getNodeSize(tgt.id, linkCounts) + 4;
          const angle = Math.atan2(dy, dx);
          const ax = tgt.x - Math.cos(angle) * tgtR;
          const ay = tgt.y - Math.sin(angle) * tgtR;
          const arrowLen = 10;
          ctx.setLineDash([]);
          ctx.fillStyle = edgeColor;
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(ax - arrowLen * Math.cos(angle - 0.5), ay - arrowLen * Math.sin(angle - 0.5));
          ctx.lineTo(ax - arrowLen * Math.cos(angle + 0.5), ay - arrowLen * Math.sin(angle + 0.5));
          ctx.closePath();
          ctx.fill();
        }

        // Flow dots for depends_on — animate direction from source to target
        if (!isRelates && !linkDimmed) {
          const now = performance.now() / 1000;
          const speed = 0.25;
          const dotCount = 3;
          const dotRadius = 2.5;
          const srcR = getNodeSize(src.id, linkCounts);
          const tgtR = getNodeSize(tgt.id, linkCounts);
          const startT = srcR / len;
          const endT = 1 - tgtR / len;
          ctx.fillStyle = edgeColor;
          for (let i = 0; i < dotCount; i++) {
            const phase = (now * speed + i / dotCount) % 1;
            const t = startT + phase * (endT - startT);
            const px = src.x + dx * t;
            const py = src.y + dy * t;
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
        if (!isRelates) {
          const angle = Math.atan2(tgt.y - cpy, tgt.x - cpx);
          const tgtR = getNodeSize(tgt.id, linkCounts) + 4;
          const ax = tgt.x - Math.cos(angle) * tgtR;
          const ay = tgt.y - Math.sin(angle) * tgtR;
          const arrowLen = 10;
          ctx.setLineDash([]);
          ctx.fillStyle = edgeColor;
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(ax - arrowLen * Math.cos(angle - 0.5), ay - arrowLen * Math.sin(angle - 0.5));
          ctx.lineTo(ax - arrowLen * Math.cos(angle + 0.5), ay - arrowLen * Math.sin(angle + 0.5));
          ctx.closePath();
          ctx.fill();
        }

        // Flow dots for depends_on — animate along quadratic curve
        if (!isRelates && !linkDimmed) {
          const now = performance.now() / 1000;
          const speed = 0.25;
          const dotCount = 3;
          const dotRadius = 2.5;
          const srcR = getNodeSize(src.id, linkCounts);
          const tgtR = getNodeSize(tgt.id, linkCounts);
          const startT = srcR / len;
          const endT = 1 - tgtR / len;
          ctx.fillStyle = edgeColor;
          for (let i = 0; i < dotCount; i++) {
            const phase = (now * speed + i / dotCount) % 1;
            const ct = startT + phase * (endT - startT);
            const px = (1 - ct) * (1 - ct) * src.x + 2 * (1 - ct) * ct * cpx + ct * ct * tgt.x;
            const py = (1 - ct) * (1 - ct) * src.y + 2 * (1 - ct) * ct * cpy + ct * ct * tgt.y;
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
      if (hSrc.x != null && hSrc.y != null && hTgt.x != null && hTgt.y != null) {
        const emx = (hSrc.x + hTgt.x) / 2;
        const emy = (hSrc.y + hTgt.y) / 2;
        const label = hovEdge.type === "depends_on" ? "depends" : "relates";
        const edgeColor = EDGE_COLOR[hovEdge.type as EdgeType] ?? "#6b7280";
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
      const sz = getNodeSize(n.id, linkCounts);
      const sc = statusColor(n.status, theme);
      const [sr, sg, sb] = hexToRgb(sc);

      ctx.save();
      ctx.translate(n.x, n.y);
      // Combine entrance + hover/focus scale so a selected node lifts
      // smoothly (1 → ~1.18) instead of snapping bigger on click.
      const focusScale = 1 + 0.18 * easeOutCubic(n._hoverT);
      const finalScale = entranceScale * focusScale;
      ctx.scale(finalScale, finalScale);

      // Ambient glow behind node
      if (n._dimT < 0.5) {
        const glowGrad = ctx.createRadialGradient(0, 0, sz * 0.5, 0, 0, sz * 2.5);
        glowGrad.addColorStop(0, `rgba(${sr},${sg},${sb},${theme.haloAlpha * (1 - n._dimT)})`);
        glowGrad.addColorStop(1, `rgba(${sr},${sg},${sb},0)`);
        ctx.fillStyle = glowGrad;
        ctx.beginPath();
        ctx.arc(0, 0, sz * 2.5, 0, Math.PI * 2);
        ctx.fill();
      }

      // Selection/hover glow
      if (n._selectGlow > 0.01) {
        ctx.shadowColor = ACCENT;
        ctx.shadowBlur = 14 * n._selectGlow;
      } else if (isHovered) {
        ctx.shadowColor = theme.hoverGlow;
        ctx.shadowBlur = 8;
      }

      // Radial gradient fill
      ctx.beginPath();
      ctx.arc(0, 0, sz, 0, Math.PI * 2);
      const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, sz);
      grad.addColorStop(0, `rgba(${sr},${sg},${sb},${theme.fillInnerAlpha})`);
      grad.addColorStop(1, `rgba(${sr},${sg},${sb},${theme.fillOuterAlpha})`);
      ctx.fillStyle = grad;
      ctx.fill();

      // Status-specific ring
      ctx.lineWidth = isSelected ? 2.5 : 1.5;
      ctx.strokeStyle = isSelected ? ACCENT : `rgba(${sr},${sg},${sb},${(isSelected || isHovered) ? 1.0 : 0.8})`;

      switch (n.status) {
        case "done":
          ctx.setLineDash([]);
          break;
        case "in_progress":
          ctx.setLineDash([]);
          ctx.shadowColor = sc;
          ctx.shadowBlur = 6 + Math.sin(Date.now() / 400) * 3;
          break;
        case "planned":
          ctx.setLineDash([3, 4]);
          break;
        case "cancelled":
          ctx.setLineDash([4, 3]);
          ctx.globalAlpha = nodeAlpha * 0.45;
          break;
        default: // draft
          ctx.setLineDash([1, 3]);
          ctx.globalAlpha = nodeAlpha * 0.6;
          break;
      }
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;

      ctx.restore();

      // Pinned indicator
      if (n.fx != null && n.fy != null) {
        ctx.globalAlpha = nodeAlpha * 0.8;
        ctx.beginPath();
        ctx.arc(n.x + sz + 3, n.y - sz - 3, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = ACCENT;
        ctx.fill();
      }

      // Adaptive labels
      const edgeCount = linkCounts.get(n.id) ?? 0;
      const isHub = edgeCount >= 5;
      const showLabel =
        isSelected || isHovered ||
        (zoomScale >= 0.6) ||
        (zoomScale >= 0.3 && isHub);

      if (showLabel && enterProgress > 0.5) {
        const labelAlpha = nodeAlpha * Math.min(1, (enterProgress - 0.5) * 2);
        ctx.globalAlpha = labelAlpha;

        const label = n.title.length > 18
          ? n.title.slice(0, 17) + "\u2026"
          : n.title;
        ctx.font = `500 12px "Inter Variable", "Inter", sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";

        const metrics = ctx.measureText(label);
        const ly = n.y + sz * finalScale + 8;
        const pw = 5, ph = 3;
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
  }, [nodes, links, size, selectedNodeId, theme, linkCounts, hoveredIdHint]);

  // Redraw whenever the external hint changes so the highlight is responsive.
  useEffect(() => {
    needsRedrawRef.current = true;
  }, [hoveredIdHint]);

  // Recenter the camera on the newly-selected node. Fires on selection change
  // and when the right-edge padding changes (e.g. a detail overlay slides in
  // and the visible canvas region shifts left).
  const prevSelectedRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevSelectedRef.current;
    prevSelectedRef.current = selectedNodeId;

    if (selectedNodeId) {
      const raf = requestAnimationFrame(() => {
        const node = nodesForFitRef.current.find((n) => n.id === selectedNodeId);
        if (!node || node.x == null || node.y == null) return;
        const sz = sizeRef.current;
        const visibleW = Math.max(120, sz.width - rightInset);
        const cx = visibleW / 2;
        const cy = sz.height / 2;
        // Gentle zoom-in only — never zoom out from the user's current scale.
        const targetScale = Math.max(transformRef.current.scale, 0.9);
        shouldAutoFitRef.current = false;
        animateTransform(
          {
            x: cx - node.x * targetScale,
            y: cy - node.y * targetScale,
            scale: targetScale,
          },
          380,
        );
      });
      return () => cancelAnimationFrame(raf);
    }

    // Transitioned from selection → no selection: breathe back to a full-graph
    // fit so the operator sees the whole project again instead of remaining
    // zoomed in on the last task.
    if (prev !== null) {
      const raf = requestAnimationFrame(() => {
        const target = computeFitTransform(nodesForFitRef.current, sizeRef.current);
        if (target) {
          animateTransform(target, 480);
          shouldAutoFitRef.current = true;
        }
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [selectedNodeId, rightInset, animateTransform, computeFitTransform]);

  // --- Render loop with idle detection ---
  useEffect(() => {
    let raf: number;
    let running = true;
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
      }

      const hasInProgress = nodes.some((n) => n.status === "in_progress");
      const hoveredId = hoveredRef.current ?? hoveredIdHint;
      const hasAnimating = nodes.some((n) => {
        if (n._enterT < 0.99) return true;
        const dimTarget = selectedNodeId && !connectedSetRef.current.has(n.id) ? 1 : 0;
        if (Math.abs(n._dimT - dimTarget) > 0.01) return true;
        const glowTarget = n.id === selectedNodeId ? 1 : 0;
        if (Math.abs(n._selectGlow - glowTarget) > 0.01) return true;
        const focusTarget = n.id === hoveredId || n.id === selectedNodeId ? 1 : 0;
        if (Math.abs(n._hoverT - focusTarget) > 0.01) return true;
        return false;
      });
      const hasFlowDots = links.some((l) => l.type === "depends_on");
      if (needsRedrawRef.current || ticking || hasAnimating || hasInProgress || hasFlowDots || animRef.current) {
        draw();
        needsRedrawRef.current = false;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { running = false; cancelAnimationFrame(raf); };
  }, [draw, ticking, nodes, links, selectedNodeId, hoveredIdHint]);

  // --- Pointer events ---
  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const [wx, wy] = screenToWorld(sx, sy);
    const hit = hitTest(wx, wy);
    if (hit) {
      dragRef.current = { active: true, nodeId: hit.id, startX: sx, startY: sy, panning: false };
    } else {
      dragRef.current = { active: true, nodeId: null, startX: sx, startY: sy, panning: true };
    }
    canvasRef.current?.setPointerCapture(e.pointerId);
  }, [screenToWorld, hitTest]);

  const pointerMoveRaf = useRef<number | null>(null);
  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const drag = dragRef.current;

    if (drag.active && drag.nodeId) {
      if (Math.hypot(sx - drag.startX, sy - drag.startY) < 4) return;
      const [wx, wy] = screenToWorld(sx, sy);
      const node = nodes.find((n) => n.id === drag.nodeId);
      if (node) {
        node.fx = wx;
        node.fy = wy;
        if (!ticking) reheat();
      }
      needsRedrawRef.current = true;
    } else if (drag.active && drag.panning) {
      animRef.current = null;
      shouldAutoFitRef.current = false;
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
          if (prevEdge !== hoveredEdgeRef.current) needsRedrawRef.current = true;
        } else {
          if (hoveredEdgeRef.current) { hoveredEdgeRef.current = null; needsRedrawRef.current = true; }
        }

        if (hit) {
          const isPinned = hit.fx != null && hit.fy != null;
          const suffix = isPinned ? " (dbl-click to unpin)" : "";
          tooltipRef.current = { text: `${hit.taskRef} · ${hit.title}${suffix}`, x: sx, y: sy };
        } else {
          tooltipRef.current = null;
        }
        if (hit) needsRedrawRef.current = true;
      });
    }
  }, [screenToWorld, hitTest, edgeHitTest, nodes, reheat, ticking, onHoverNode]);

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (drag.active && rect) {
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const wasClick = Math.hypot(sx - drag.startX, sy - drag.startY) < 4;
      if (wasClick) {
        if (drag.nodeId) {
          onSelectNode(drag.nodeId);
        } else {
          onDeselect?.();
        }
      }
    }
    dragRef.current = { active: false, nodeId: null, startX: 0, startY: 0, panning: false };
    canvasRef.current?.releasePointerCapture(e.pointerId);
    needsRedrawRef.current = true;
  }, [onSelectNode, onDeselect]);

  const handleDoubleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const [wx, wy] = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    const hit = hitTest(wx, wy);
    if (hit) { hit.fx = null; hit.fy = null; reheat(); }
  }, [screenToWorld, hitTest, reheat]);

  const handleWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    animRef.current = null;
    shouldAutoFitRef.current = false;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
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
  }, []);

  // --- Control callbacks ---
  const zoomIn = useCallback(() => {
    shouldAutoFitRef.current = false;
    const t = transformRef.current;
    const cx = size.width / 2;
    const cy = size.height / 2;
    const ns = Math.min(MAX_ZOOM, t.scale * ZOOM_FACTOR);
    animateTransform({
      x: cx - (cx - t.x) * (ns / t.scale),
      y: cy - (cy - t.y) * (ns / t.scale),
      scale: ns,
    }, 200);
    setZoomLevel(ns);
  }, [size, animateTransform]);

  const zoomOut = useCallback(() => {
    shouldAutoFitRef.current = false;
    const t = transformRef.current;
    const cx = size.width / 2;
    const cy = size.height / 2;
    const ns = Math.max(MIN_ZOOM, t.scale / ZOOM_FACTOR);
    animateTransform({
      x: cx - (cx - t.x) * (ns / t.scale),
      y: cy - (cy - t.y) * (ns / t.scale),
      scale: ns,
    }, 200);
    setZoomLevel(ns);
  }, [size, animateTransform]);

  const fitToScreen = useCallback(() => {
    const target = computeFitTransform(nodes, size);
    if (target) {
      animateTransform(target, 400);
      setZoomLevel(target.scale);
    }
  }, [nodes, size, computeFitTransform, animateTransform]);

  const resetView = useCallback(() => {
    shouldAutoFitRef.current = true;
    reset();
  }, [reset]);

  const isEmpty = filteredTasks.length === 0 && tasks.length === 0;
  const allFiltered = filteredTasks.length === 0 && tasks.length > 0;

  return (
    <div ref={containerRef} className={`relative h-full w-full ${className}`}>
      {isEmpty ? (
        <div className="flex h-full w-full flex-col items-center justify-center p-8">
          <p className="text-sm text-text-secondary">No tasks to visualize</p>
          <p className="mt-1 text-xs text-text-muted">Add tasks to see your project graph.</p>
        </div>
      ) : allFiltered ? (
        <div className="flex h-full w-full flex-col items-center justify-center p-8">
          <p className="text-sm text-text-secondary">All tasks are hidden by filters</p>
          <p className="mt-1 text-xs text-text-muted">Toggle status filters to show tasks.</p>
        </div>
      ) : (
        <>
          <canvas
            ref={canvasRef}
            className="absolute inset-0 cursor-grab active:cursor-grabbing"
            style={{ width: size.width, height: size.height }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onDoubleClick={handleDoubleClick}
            onWheel={handleWheel}
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
