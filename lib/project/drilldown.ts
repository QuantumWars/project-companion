/**
 * Where a diagram sits in the drill-down hierarchy.
 *
 * C4's zoom is a tree -- context holds containers hold components -- but the
 * link is stored pointing DOWN: a node carries `drilldownDiagramId`, naming the
 * diagram inside it. Nothing points up. So the trail back is found by asking
 * which diagram contains a node pointing here, which is a scan rather than a
 * lookup.
 *
 * That is the right trade. Storing a parent id on every diagram would be a
 * second copy of the same fact, and the two would drift the first time somebody
 * repointed a node -- leaving a breadcrumb that walks you to a diagram that no
 * longer contains you.
 */

export type DrilldownSource = {
  id: string;
  title: string;
  nodes: readonly { id: string; data: unknown }[];
};

export type TrailStep = {
  diagramId: string;
  title: string;
  /** The node you came through, so the parent can highlight it on arrival. */
  nodeId?: string;
};

const drilldownOf = (data: unknown): string | undefined =>
  typeof data === "object" && data !== null
    ? (data as { drilldownDiagramId?: string }).drilldownDiagramId
    : undefined;

/** The diagram whose node opens `diagramId`, if any. */
export const parentOf = (
  diagramId: string,
  diagrams: readonly DrilldownSource[],
): TrailStep | undefined => {
  for (const diagram of diagrams) {
    if (diagram.id === diagramId) continue;
    const node = diagram.nodes.find((n) => drilldownOf(n.data) === diagramId);
    if (node) return { diagramId: diagram.id, title: diagram.title, nodeId: node.id };
  }
  return undefined;
};

/**
 * The ancestry of a diagram, outermost first.
 *
 * Stops on a cycle rather than following it. Two nodes can point at each
 * other's diagrams -- nothing forbids it, and a breadcrumb is not the place to
 * find out -- so a visited set bounds the walk. What comes back is still a
 * usable trail, just a truncated one.
 */
export const trailTo = (
  diagramId: string,
  diagrams: readonly DrilldownSource[],
): TrailStep[] => {
  const trail: TrailStep[] = [];
  const seen = new Set<string>([diagramId]);

  let current = diagramId;
  for (;;) {
    const parent = parentOf(current, diagrams);
    if (!parent || seen.has(parent.diagramId)) break;
    seen.add(parent.diagramId);
    trail.unshift(parent);
    current = parent.diagramId;
  }

  return trail;
};
