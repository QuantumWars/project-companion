"use client";

/**
 * Auto-layout via ELK.
 *
 * ELK is used rather than dagre because this canvas needs two things dagre
 * cannot do: nested compound nodes (a service inside a VPC inside a region)
 * and orthogonal edge routing.
 *
 * `elkjs` is ~7.7 MB, so it is pulled in by a dynamic import and never lands in
 * the route bundle. Layout runs on the main thread: for the tens-of-nodes
 * diagrams this canvas is built for it completes in a few milliseconds. If that
 * stops being true, `elkjs/lib/elk-worker.min.js` is the drop-in upgrade --
 * pass a `workerFactory` to the ELK constructor.
 *
 * Licence note: elkjs is EPL-2.0 / GPL-3.0, not MIT. It is used unmodified as a
 * dependency under the EPL arm; do not vendor or patch its source.
 */

import type { ArchEdge, ArchNode, DiagramType } from "@/types/arch";

export type LayoutDirection = "RIGHT" | "DOWN";

/**
 * Which ELK algorithm suits a diagram family.
 *
 * `layered` is right for anything with a flow direction. Hierarchies read far
 * better as a real tree, and a mind map is radial by definition -- using
 * `layered` for those produces a technically-correct but unrecognisable shape.
 */
export type LayoutAlgorithm = "layered" | "mrtree" | "radial";

export const algorithmFor = (diagramType: string): LayoutAlgorithm => {
  switch (diagramType) {
    case "orgchart":
    case "sitemap":
      return "mrtree";
    case "mindmap":
      return "radial";
    default:
      return "layered";
  }
};

/** Fallbacks for nodes React Flow has not measured yet. */
const FALLBACK_NODE = { width: 190, height: 56 };
const FALLBACK_GROUP = { width: 320, height: 220 };

type ElkNode = {
  id: string;
  width?: number;
  height?: number;
  children?: ElkNode[];
  layoutOptions?: Record<string, string>;
  x?: number;
  y?: number;
};

const baseOptions = (
  direction: LayoutDirection,
  algorithm: LayoutAlgorithm,
): Record<string, string> => {
  const common: Record<string, string> = {
    "elk.algorithm": algorithm,
    "elk.spacing.nodeNode": "48",
    // Lay out the contents of each container too, and grow it to fit.
    "elk.hierarchyHandling": "INCLUDE_CHILDREN",
    "elk.padding": "[top=44,left=20,bottom=20,right=20]",
  };

  if (algorithm === "mrtree") {
    return { ...common, "elk.direction": direction, "elk.spacing.nodeNode": "40" };
  }

  if (algorithm === "radial") {
    return { ...common, "elk.radial.radius": "220", "elk.spacing.nodeNode": "36" };
  }

  return {
    ...common,
    "elk.direction": direction,
    "elk.edgeRouting": "ORTHOGONAL",
    "elk.layered.spacing.nodeNodeBetweenLayers": "90",
    "elk.spacing.edgeNode": "32",
    "elk.layered.spacing.edgeNodeBetweenLayers": "32",
  };
};

const sizeOf = (node: ArchNode) => {
  const measured = node.measured;
  const fallback = node.type === "group" ? FALLBACK_GROUP : FALLBACK_NODE;

  return {
    width: measured?.width ?? (node.width as number | undefined) ?? fallback.width,
    height: measured?.height ?? (node.height as number | undefined) ?? fallback.height,
  };
};

/**
 * Runs ELK over the graph and returns the nodes with new positions.
 *
 * Child positions come back relative to their parent, which is exactly what
 * React Flow expects for a node with `parentId` -- no conversion needed.
 */
/**
 * How one compound node should be laid out.
 *
 * Returning `undefined` means "inherit the graph's settings", which is what
 * every container except a frame does.
 */
export type LayoutOverride = { direction?: LayoutDirection; algorithm?: LayoutAlgorithm };

/**
 * A frame is its own diagram, so it is laid out under its own rules.
 *
 * `orgchart` and `sitemap` read as trees flowing downward; a mind map is radial
 * by definition; everything else has a direction of flow and wants `layered`.
 * This is the same decision the board makes for itself, applied per region.
 */
export const overrideForDiagramType = (type: DiagramType): LayoutOverride => ({
  algorithm: algorithmFor(type),
  direction: type === "orgchart" || type === "sitemap" ? "DOWN" : "RIGHT",
});

export const layoutGraph = async (
  nodes: ArchNode[],
  edges: ArchEdge[],
  direction: LayoutDirection = "RIGHT",
  algorithm: LayoutAlgorithm = "layered",
  /**
   * Per-container overrides, keyed by node id. Supplied for frames so an ER
   * frame and a flowchart frame on one canvas do not both get flattened into
   * whatever the board's type happens to be.
   */
  overrides?: Map<string, LayoutOverride>,
): Promise<ArchNode[]> => {
  if (nodes.length === 0) {
    return nodes;
  }

  const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
  const elk = new ELK();

  // Rebuild the parent/child tree ELK expects from React Flow's flat list.
  const byParent = new Map<string | undefined, ArchNode[]>();
  for (const node of nodes) {
    const key = node.parentId ?? undefined;
    const list = byParent.get(key) ?? [];
    list.push(node);
    byParent.set(key, list);
  }

  const toElk = (node: ArchNode): ElkNode => {
    const children = byParent.get(node.id) ?? [];
    const { width, height } = sizeOf(node);

    const override = overrides?.get(node.id);

    return {
      id: node.id,
      width,
      height,
      ...(children.length
        ? {
            children: children.map(toElk),
            layoutOptions: baseOptions(
              override?.direction ?? direction,
              override?.algorithm ?? algorithm,
            ),
          }
        : {}),
    };
  };

  const graph = {
    id: "root",
    layoutOptions: baseOptions(direction, algorithm),
    children: (byParent.get(undefined) ?? []).map(toElk),
    // ELK rejects edges whose endpoints it has never seen.
    edges: edges
      .filter((e) => nodes.some((n) => n.id === e.source) && nodes.some((n) => n.id === e.target))
      .map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };

  const laid = await elk.layout(graph);

  type Laid = { x: number; y: number; width?: number; height?: number };
  const result = new Map<string, Laid>();
  const walk = (elkNode: ElkNode) => {
    for (const child of elkNode.children ?? []) {
      result.set(child.id, {
        x: child.x ?? 0,
        y: child.y ?? 0,
        width: child.width,
        height: child.height,
      });
      walk(child);
    }
  };
  walk(laid as ElkNode);

  return nodes.map((node) => {
    const laidOut = result.get(node.id);
    if (!laidOut) {
      return node;
    }

    const next: ArchNode = { ...node, position: { x: laidOut.x, y: laidOut.y } };

    // Containers must take the size ELK computed for them. Without this a
    // group keeps whatever size it was drawn at, and children laid out beyond
    // that box get clipped by `extent: "parent"` -- they simply vanish.
    if (node.type === "group" && laidOut.width && laidOut.height) {
      next.width = Math.round(laidOut.width);
      next.height = Math.round(laidOut.height);
      next.style = {
        ...node.style,
        width: Math.round(laidOut.width),
        height: Math.round(laidOut.height),
      };
    }

    return next;
  });
};
