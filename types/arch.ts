/**
 * Graph model for the architecture canvas.
 *
 * Everything here round-trips through `JSON.stringify` into localStorage, so
 * it must stay plain JSON -- no `Map`, `Set`, `Date`, or class instances.
 *
 * `ArchNodeData` is a discriminated union on `kind`, and that same string is
 * the React Flow node type, so `nodeTypes[node.type]` resolves directly and a
 * narrowed `data` always matches the component rendering it.
 */

import type { Edge, Node } from "@xyflow/react";

import type { GeometryId } from "@/lib/arch/shapes";

/* --------------------------------- nodes --------------------------------- */

export type ArchNodeKind =
  | "service"
  | "group"
  | "table"
  | "c4"
  | "note"
  | "shape"
  | "umlclass";

export type CloudProvider = "aws" | "gcp" | "azure" | "cloudflare" | "vercel";

/** A single piece of the stack: a server, a queue, a datastore, a client app. */
export type ServiceData = {
  kind: "service";
  label: string;
  /**
   * Opens the diagram that details this service. Generalised from C4's
   * container-to-component link: any node worth expanding can have one.
   */
  drilldownDiagramId?: string;
  /** `TechDef` id from the catalog, e.g. "postgresql". Absent = generic box. */
  tech?: string;
  /** Secondary line under the label, e.g. "v16 - primary". */
  sublabel?: string;
  badges?: string[];
};

/**
 * A container: a frame, region, VPC, subnet, cluster, or plain trust boundary.
 *
 * The `frame` variant is what lets one canvas hold several diagrams. A frame
 * carries its own `diagramType`, so an ER frame and a flowchart frame can sit
 * side by side and each lays out under its own algorithm. Every other variant
 * is an infrastructure container and inherits the board's type.
 */
export type GroupData = {
  kind: "group";
  label: string;
  variant: "frame" | "region" | "vpc" | "subnet" | "cluster" | "boundary";
  provider?: CloudProvider;
  /**
   * Set on a frame to make it its own diagram: it selects the layout algorithm
   * for this region and biases the shape palette while something inside is
   * selected. Never restricts what can be drawn.
   */
  diagramType?: DiagramType;
  /** Opens the diagram that details this container. */
  drilldownDiagramId?: string;
};

export type Column = {
  id: string;
  name: string;
  /** Free text so any dialect's spelling survives a round-trip. */
  type: string;
  pk?: boolean;
  fk?: boolean;
  nullable?: boolean;
  unique?: boolean;
};

/** A database table. Height is driven by `columns`, so it is never fixed. */
export type TableData = {
  kind: "table";
  label: string;
  schema?: string;
  columns: Column[];
};

export type C4Element =
  | "person"
  | "system"
  | "container"
  | "component"
  | "external";

export type C4Data = {
  kind: "c4";
  label: string;
  element: C4Element;
  technology?: string;
  description?: string;
  /** Diagram id of the level below, which makes this node a drill-down link. */
  drilldownDiagramId?: string;
};

export type NoteData = {
  kind: "note";
  label: string;
};

/**
 * The generic diagram primitive.
 *
 * Flowchart, BPMN, data flow, sitemap, org chart, block and network diagrams
 * are all this node with a different `geometry` -- see `lib/arch/shapes.ts`.
 * Keeping them one type is what lets a new diagram family be a data change
 * rather than a new component.
 */
export type ShapeData = {
  kind: "shape";
  label: string;
  geometry: GeometryId;
  /** Palette token, resolved to real colours by the renderer. */
  tone?: ShapeTone;
  /**
   * Renders with a translucent fill and multiply blending. This is what makes
   * a Venn diagram work -- overlapping sets have to show their intersection.
   */
  translucent?: boolean;
};

/** A UML class box: name, attributes, operations. */
export type UmlClassData = {
  kind: "umlclass";
  label: string;
  /** Rendered above the name in guillemets, e.g. <<interface>>. */
  stereotype?: string;
  attributes: UmlMember[];
  methods: UmlMember[];
  abstract?: boolean;
};

export type UmlVisibility = "public" | "private" | "protected" | "package";

export type UmlMember = {
  id: string;
  name: string;
  /** Type for an attribute, return type for a method. */
  type?: string;
  visibility?: UmlVisibility;
  isStatic?: boolean;
};

export type ShapeTone =
  | "neutral"
  | "blue"
  | "green"
  | "amber"
  | "red"
  | "violet"
  | "cyan";

export type ArchNodeData =
  | ServiceData
  | GroupData
  | TableData
  | C4Data
  | NoteData
  | ShapeData
  | UmlClassData;

export type ArchNode = Node<ArchNodeData, ArchNodeKind>;

/* --------------------------------- edges --------------------------------- */

export type Protocol =
  | "http"
  | "https"
  | "grpc"
  | "ws"
  | "sql"
  | "amqp"
  | "kafka"
  | "s3"
  | "tcp";

/** Crow's-foot cardinality, read source-to-target. */
export type Cardinality = "1-1" | "1-n" | "n-1" | "n-m";

export type FlowEdgeData = {
  kind: "flow";
  label?: string;
  protocol?: Protocol;
  /** Renders dashed + animated: queues, events, webhooks. */
  async?: boolean;
  /** Line routing. Flowcharts want orthogonal; architecture reads better curved. */
  line?: "smoothstep" | "bezier" | "straight";
  /** Arrowheads. A plain connector has neither. */
  arrowStart?: boolean;
  arrowEnd?: boolean;
};

export type RelationEdgeData = {
  kind: "relation";
  cardinality: Cardinality;
};

export type ArchEdgeData = FlowEdgeData | RelationEdgeData;

export type ArchEdge = Edge<ArchEdgeData>;

/* -------------------------------- handles -------------------------------- */

/**
 * Side handles for service/group/c4 nodes. The canvas runs in
 * `ConnectionMode.Loose`, so each one acts as both source and target and a
 * node needs four handles rather than eight.
 */
export type HandleSide = "t" | "r" | "b" | "l";

export const HANDLE_SIDES: readonly HandleSide[] = ["t", "r", "b", "l"];

/**
 * Table nodes put a handle on each side of every column row. Encoding the
 * column id into the handle id is what makes a foreign key bind at column
 * level: the edge's `sourceHandle`/`targetHandle` *are* the join.
 */
export const columnHandleId = (columnId: string, side: "l" | "r") =>
  `col:${columnId}:${side}`;

export const parseColumnHandleId = (
  handleId: string | null | undefined,
): { columnId: string; side: "l" | "r" } | null => {
  if (!handleId) {
    return null;
  }

  const match = /^col:(.+):([lr])$/.exec(handleId);
  return match ? { columnId: match[1], side: match[2] as "l" | "r" } : null;
};

/* -------------------------------- document ------------------------------- */

export type Viewport = { x: number; y: number; zoom: number };

/**
 * The kind of diagram a board -- or a single frame on it -- holds.
 *
 * Purely a UI affordance: it biases the shape library and picks the layout
 * algorithm, and never restricts what can be drawn, because real diagrams mix
 * families constantly. A frame carries its own, which is what lets one canvas
 * hold several diagrams that each tidy up under their own rules.
 */
export const DIAGRAM_TYPE_IDS = [
  "architecture",
  "flowchart",
  "erd",
  "bpmn",
  "dfd",
  "uml",
  "network",
  "sitemap",
  "orgchart",
  "block",
  "venn",
  "mindmap",
] as const;

export type DiagramType = (typeof DIAGRAM_TYPE_IDS)[number];

/**
 * Display names for each diagram type.
 *
 * Lives beside the union rather than in the topbar, because the frame node, the
 * inspector and the type picker all need the same words for the same thing.
 */
export const DIAGRAM_TYPE_LABELS: Record<DiagramType, string> = {
  architecture: "Architecture",
  flowchart: "Flowchart",
  erd: "ER diagram",
  bpmn: "BPMN",
  dfd: "Data flow",
  uml: "UML",
  network: "Network",
  sitemap: "Sitemap",
  orgchart: "Org chart",
  block: "Block",
  venn: "Venn",
  mindmap: "Mind map",
};

/** What one architecture board persists. */
export type ArchDocument = {
  nodes: ArchNode[];
  edges: ArchEdge[];
  viewport: Viewport;
  diagramType?: DiagramType;
};

export const emptyArchDocument = (): ArchDocument => ({
  nodes: [],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  diagramType: "architecture",
});
