import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCollide,
  forceX,
  forceY,
} from "d3-force";
import type { Simulation } from "d3-force";
import { useEffect, useEffectEvent, useRef, useState, useCallback, useMemo } from "react";
import type { TaskEdge } from "@/lib/db/schema";
import type { TaskGraphSlim } from "@/lib/data/views";
import type { GraphNode, GraphLink } from "./graphConstants";
import { getNodeSize, buildLinkCounts } from "./graphConstants";

/** Slim task record used for graph rendering — heavy fields are not needed. */
type GraphTask = TaskGraphSlim;

// ---------------------------------------------------------------------------
// Link distance per edge type
// ---------------------------------------------------------------------------

const LINK_DISTANCE: Record<string, number> = {
  depends_on: 120,
  relates_to: 100,
};

// ---------------------------------------------------------------------------
// Graph building + deterministic initial layout
// ---------------------------------------------------------------------------

/**
 * Build GraphNode and GraphLink arrays from tasks and edges.
 * @param taskList - Task records.
 * @param edges - TaskEdge records.
 * @param cx - Center X.
 * @param cy - Center Y.
 * @param savedPositions - Previously saved positions for continuity.
 * @returns nodes and links.
 */
function buildGraph(
  taskList: GraphTask[],
  edges: TaskEdge[],
  cx: number,
  cy: number,
  savedPositions: Map<string, { x: number; y: number }>,
): { nodes: GraphNode[]; links: GraphLink[] } {
  const nodes: GraphNode[] = [];
  const nodeIds = new Set<string>();

  const radius = Math.max(80, taskList.length * 25);
  for (let i = 0; i < taskList.length; i++) {
    const t = taskList[i];
    const angle = (2 * Math.PI * i) / Math.max(taskList.length, 1) - Math.PI / 2;
    const saved = savedPositions.get(t.id);
    nodes.push({
      id: t.id,
      title: t.title,
      taskRef: t.taskRef,
      status: t.status,
      tags: t.tags ?? [],
      x: saved?.x ?? cx + Math.cos(angle) * radius,
      y: saved?.y ?? cy + Math.sin(angle) * radius,
      _enterT: saved ? 1 : 0,
      _dimT: 0,
      _selectGlow: 0,
      _hoverT: 0,
    });
    nodeIds.add(t.id);
  }

  const links: GraphLink[] = [];
  for (const e of edges) {
    if (nodeIds.has(e.sourceTaskId) && nodeIds.has(e.targetTaskId)) {
      links.push({ source: e.sourceTaskId, target: e.targetTaskId, type: e.edgeType });
    }
  }

  return { nodes, links };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/** Return value of the useForceSimulation hook. */
interface UseForceSimulationReturn {
  nodes: GraphNode[];
  links: GraphLink[];
  /** Reheat the simulation (e.g. after drag). */
  reheat: () => void;
  /** Reset: scatter nodes to circle + full reheat with animation. */
  reset: () => void;
  /** Whether the simulation is actively ticking (drives rAF). */
  ticking: boolean;
}

/**
 * Custom hook wrapping a d3-force simulation for the project graph.
 * @param taskList - Task records to visualize.
 * @param edges - TaskEdge records defining relationships.
 * @param width - Canvas width in pixels.
 * @param height - Canvas height in pixels.
 * @param onSettle - Called when simulation finishes settling.
 * @returns Simulation state.
 */
export function useForceSimulation(
  taskList: GraphTask[],
  edges: TaskEdge[],
  width: number,
  height: number,
  onSettle?: () => void,
): UseForceSimulationReturn {
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [links, setLinks] = useState<GraphLink[]>([]);
  const [ticking, setTicking] = useState(false);
  const simulationRef = useRef<Simulation<GraphNode, GraphLink> | null>(null);
  const positionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const dimensionsRef = useRef({ width, height });
  const onSettleEvent = useEffectEvent(() => { onSettle?.(); });
  const [prevEmpty, setPrevEmpty] = useState(taskList.length === 0);

  useEffect(() => { dimensionsRef.current = { width, height }; }, [width, height]);

  const isEmpty = taskList.length === 0;
  if (isEmpty !== prevEmpty) {
    setPrevEmpty(isEmpty);
    if (isEmpty) {
      setNodes([]);
      setLinks([]);
      setTicking(false);
    }
  }

  const dataFingerprint = useMemo(() => {
    const tIds = taskList.map((t) => t.id).sort().join(",");
    const eIds = edges.map((e) => `${e.sourceTaskId}-${e.targetTaskId}-${e.edgeType}`).sort().join(",");
    const statuses = taskList.map((t) => t.status).join(",");
    return `${tIds}|${eIds}|${statuses}`;
  }, [taskList, edges]);

  const reheat = useCallback(() => {
    const sim = simulationRef.current;
    if (sim) {
      sim.alpha(0.3).restart();
      setTicking(true);
    }
  }, []);

  const nodesRef = useRef<GraphNode[]>([]);

  const reset = useCallback(() => {
    const sim = simulationRef.current;
    const currentNodes = nodesRef.current;
    if (!sim || currentNodes.length === 0) return;
    const w = dimensionsRef.current.width;
    const h = dimensionsRef.current.height;
    const radius = Math.max(80, currentNodes.length * 25);
    for (let i = 0; i < currentNodes.length; i++) {
      const angle = (2 * Math.PI * i) / Math.max(currentNodes.length, 1) - Math.PI / 2;
      currentNodes[i].x = w / 2 + Math.cos(angle) * radius;
      currentNodes[i].y = h / 2 + Math.sin(angle) * radius;
      currentNodes[i].vx = 0;
      currentNodes[i].vy = 0;
      currentNodes[i].fx = null;
      currentNodes[i].fy = null;
    }
    positionsRef.current.clear();
    sim.alpha(1).restart();
    setTicking(true);
  }, []);

  // Effect A -- Topology: rebuild simulation on data change
  useEffect(() => {
    const tsks = taskList;
    const edgs = edges;
    const w = dimensionsRef.current.width;
    const h = dimensionsRef.current.height;
    const { nodes: newNodes, links: newLinks } = buildGraph(
      tsks, edgs, w / 2, h / 2, positionsRef.current,
    );

    if (newNodes.length === 0) {
      simulationRef.current?.stop();
      simulationRef.current = null;
      nodesRef.current = [];
      return;
    }

    simulationRef.current?.stop();

    // Build link counts for node sizing in collide force
    const linkCounts = buildLinkCounts(newLinks);

    // Disjoint force-directed graph pattern (d3 recommended):
    // forceX + forceY instead of forceCenter — pulls each node individually
    // toward center, naturally handles disconnected components.
    const sim = forceSimulation<GraphNode, GraphLink>(newNodes)
      .force(
        "link",
        forceLink<GraphNode, GraphLink>(newLinks)
          .id((n) => n.id)
          .distance((l) => LINK_DISTANCE[l.type] ?? 60)
          .iterations(2),
      )
      .force("charge", forceManyBody<GraphNode>().strength(Math.max(-1000, -100 - newNodes.length * 10)))
      .force(
        "collide",
        forceCollide<GraphNode>()
          .radius((n) => getNodeSize(n.id, linkCounts) + 20),
      )
      .force("x", forceX<GraphNode>(w / 2).strength(0.04))
      .force("y", forceY<GraphNode>(h / 2).strength(0.04))
      .alphaDecay(0.02)
      .velocityDecay(0.2);

    // Attach live tick handler — drives visible animation
    let halfwayFired = false;
    sim.on("tick", () => {
      for (const n of newNodes) {
        if (n._enterT < 1) n._enterT = Math.min(1, n._enterT + 0.04);
      }
      for (const n of newNodes) {
        if (n.x != null && n.y != null) positionsRef.current.set(n.id, { x: n.x, y: n.y });
      }
      // Auto-fit at halfway point (alpha ~0.03)
      if (!halfwayFired && sim.alpha() < 0.03) {
        halfwayFired = true;
        onSettleEvent();
      }
      setTicking(true);
      setNodes([...newNodes]);
      setLinks([...newLinks]);
    });

    sim.on("end", () => {
      setTicking(false);
    });

    // Start with visible animation
    sim.alpha(1).restart();

    nodesRef.current = newNodes;
    simulationRef.current = sim;

    return () => { sim.stop(); };
  }, [dataFingerprint, taskList, edges]);

  // Effect B -- Dimensions: update center force without reheating.
  useEffect(() => {
    const sim = simulationRef.current;
    if (!sim) return;
    sim.force("x", forceX<GraphNode>(width / 2));
    sim.force("y", forceY<GraphNode>(height / 2));
  }, [width, height]);

  return { nodes, links, reheat, reset, ticking };
}
