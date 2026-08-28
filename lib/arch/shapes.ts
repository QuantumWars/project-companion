/**
 * Geometry catalog for the generic shape node.
 *
 * Most diagram families -- flowchart, BPMN, data flow, sitemap, org chart,
 * block, network -- are the same primitive with different geometry and a
 * different default palette. Rather than a node type per family, there is one
 * `shape` node whose outline is looked up here, which is what lets a new
 * diagram type be a data change instead of a new component.
 *
 * Every outline is an SVG path built from the node's measured width/height, so
 * shapes stay correct at any size.
 */

export type DiagramFamily =
  | "flowchart"
  | "bpmn"
  | "dfd"
  | "uml"
  | "network"
  | "sitemap"
  | "orgchart"
  | "block"
  | "venn"
  | "mindmap";

export type GeometryId =
  | "rectangle"
  | "rounded"
  | "stadium"
  | "diamond"
  | "ellipse"
  | "circle"
  | "parallelogram"
  | "trapezoid"
  | "hexagon"
  | "cylinder"
  | "document"
  | "predefined"
  | "manual-input"
  | "data-store"
  | "triangle"
  | "note"
  | "cloud"
  | "double-circle"
  | "venn-set";

export type Geometry = {
  id: GeometryId;
  label: string;
  /** Which palettes this appears in, and under what name. */
  families: DiagramFamily[];
  defaultSize: { w: number; h: number };
  /** First path is the filled outline; any others are detail strokes. */
  paths: (w: number, h: number) => string[];
  /** Extra padding so the label clears a slanted or pointed outline. */
  inset?: (w: number, h: number) => { x: number; y: number };
  /** Venn sets default to a translucent fill so overlaps read as intersections. */
  translucent?: boolean;
};

const r = (n: number) => Math.round(n * 100) / 100;

const roundedPath = (w: number, h: number, radius: number) => {
  const rad = Math.min(radius, w / 2, h / 2);
  return `M${rad},0 H${r(w - rad)} A${rad},${rad} 0 0 1 ${w},${rad} V${r(h - rad)} A${rad},${rad} 0 0 1 ${r(w - rad)},${h} H${rad} A${rad},${rad} 0 0 1 0,${r(h - rad)} V${rad} A${rad},${rad} 0 0 1 ${rad},0 Z`;
};

const ellipsePath = (w: number, h: number) =>
  `M0,${r(h / 2)} A${r(w / 2)},${r(h / 2)} 0 1 0 ${w},${r(h / 2)} A${r(w / 2)},${r(h / 2)} 0 1 0 0,${r(h / 2)} Z`;

export const GEOMETRIES: Geometry[] = [
  {
    id: "rectangle",
    label: "Process",
    families: ["flowchart", "block", "dfd", "sitemap", "orgchart", "uml", "network", "mindmap"],
    defaultSize: { w: 160, h: 72 },
    paths: (w, h) => [`M0,0 H${w} V${h} H0 Z`],
  },
  {
    id: "rounded",
    label: "Task",
    families: ["bpmn", "flowchart", "block", "mindmap"],
    defaultSize: { w: 160, h: 72 },
    paths: (w, h) => [roundedPath(w, h, 10)],
  },
  {
    id: "stadium",
    label: "Terminator",
    families: ["flowchart", "mindmap"],
    defaultSize: { w: 150, h: 56 },
    paths: (w, h) => [roundedPath(w, h, h / 2)],
  },
  {
    id: "diamond",
    label: "Decision",
    families: ["flowchart", "bpmn"],
    defaultSize: { w: 150, h: 100 },
    paths: (w, h) => [
      `M${r(w / 2)},0 L${w},${r(h / 2)} L${r(w / 2)},${h} L0,${r(h / 2)} Z`,
    ],
    // A diamond's corners are empty, so text needs to stay near the middle.
    inset: (w, h) => ({ x: w * 0.22, y: h * 0.22 }),
  },
  {
    id: "ellipse",
    label: "Ellipse",
    families: ["flowchart", "dfd", "venn"],
    defaultSize: { w: 150, h: 90 },
    paths: (w, h) => [ellipsePath(w, h)],
    inset: (w, h) => ({ x: w * 0.12, y: h * 0.1 }),
  },
  {
    id: "circle",
    label: "Event",
    families: ["bpmn", "flowchart", "venn"],
    defaultSize: { w: 88, h: 88 },
    paths: (w, h) => [ellipsePath(w, h)],
    inset: (w, h) => ({ x: w * 0.14, y: h * 0.14 }),
  },
  {
    id: "double-circle",
    label: "End event",
    families: ["bpmn"],
    defaultSize: { w: 88, h: 88 },
    paths: (w, h) => [
      ellipsePath(w, h),
      `M${r(w * 0.1)},${r(h / 2)} A${r(w * 0.4)},${r(h * 0.4)} 0 1 0 ${r(w * 0.9)},${r(h / 2)} A${r(w * 0.4)},${r(h * 0.4)} 0 1 0 ${r(w * 0.1)},${r(h / 2)} Z`,
    ],
    inset: (w, h) => ({ x: w * 0.18, y: h * 0.18 }),
  },
  {
    id: "parallelogram",
    label: "Input / Output",
    families: ["flowchart", "dfd"],
    defaultSize: { w: 170, h: 70 },
    paths: (w, h) => [`M${r(w * 0.18)},0 H${w} L${r(w * 0.82)},${h} H0 Z`],
    inset: (w) => ({ x: w * 0.2, y: 0 }),
  },
  {
    id: "trapezoid",
    label: "Manual operation",
    families: ["flowchart"],
    defaultSize: { w: 170, h: 70 },
    paths: (w, h) => [`M${r(w * 0.15)},0 H${r(w * 0.85)} L${w},${h} H0 Z`],
    inset: (w) => ({ x: w * 0.16, y: 0 }),
  },
  {
    id: "hexagon",
    label: "Preparation",
    families: ["flowchart", "block"],
    defaultSize: { w: 165, h: 74 },
    paths: (w, h) => [
      `M${r(w * 0.16)},0 H${r(w * 0.84)} L${w},${r(h / 2)} L${r(w * 0.84)},${h} H${r(w * 0.16)} L0,${r(h / 2)} Z`,
    ],
    inset: (w) => ({ x: w * 0.18, y: 0 }),
  },
  {
    id: "cylinder",
    label: "Database",
    families: ["flowchart", "dfd", "network", "block"],
    defaultSize: { w: 130, h: 100 },
    paths: (w, h) => {
      const ry = Math.min(h * 0.18, 22);
      return [
        `M0,${r(ry)} A${r(w / 2)},${r(ry)} 0 0 1 ${w},${r(ry)} V${r(h - ry)} A${r(w / 2)},${r(ry)} 0 0 1 0,${r(h - ry)} Z`,
        `M0,${r(ry)} A${r(w / 2)},${r(ry)} 0 0 0 ${w},${r(ry)}`,
      ];
    },
    inset: (_, h) => ({ x: 0, y: h * 0.16 }),
  },
  {
    id: "document",
    label: "Document",
    families: ["flowchart", "dfd"],
    defaultSize: { w: 155, h: 84 },
    paths: (w, h) => [
      `M0,0 H${w} V${r(h * 0.8)} Q${r(w * 0.75)},${h} ${r(w / 2)},${r(h * 0.88)} Q${r(w * 0.25)},${r(h * 0.76)} 0,${r(h * 0.94)} Z`,
    ],
    inset: (_, h) => ({ x: 0, y: h * 0.1 }),
  },
  {
    id: "predefined",
    label: "Subprocess",
    families: ["flowchart", "bpmn"],
    defaultSize: { w: 170, h: 72 },
    paths: (w, h) => [
      `M0,0 H${w} V${h} H0 Z`,
      `M${r(w * 0.12)},0 V${h}`,
      `M${r(w * 0.88)},0 V${h}`,
    ],
    inset: (w) => ({ x: w * 0.14, y: 0 }),
  },
  {
    id: "manual-input",
    label: "Manual input",
    families: ["flowchart"],
    defaultSize: { w: 160, h: 74 },
    paths: (w, h) => [`M0,${r(h * 0.22)} L${w},0 V${h} H0 Z`],
    inset: (_, h) => ({ x: 0, y: h * 0.14 }),
  },
  {
    id: "data-store",
    label: "Data store",
    families: ["dfd"],
    defaultSize: { w: 175, h: 60 },
    // Open-ended on the right: the Gane-Sarson data store.
    paths: (w, h) => [`M${w},0 H0 V${h} H${w}`, `M${r(w * 0.2)},0 V${h}`],
    inset: (w) => ({ x: w * 0.12, y: 0 }),
  },
  {
    id: "triangle",
    label: "Triangle",
    families: ["block"],
    defaultSize: { w: 130, h: 110 },
    paths: (w, h) => [`M${r(w / 2)},0 L${w},${h} H0 Z`],
    inset: (w, h) => ({ x: w * 0.26, y: h * 0.34 }),
  },
  {
    id: "note",
    label: "Note",
    families: ["uml", "flowchart", "block"],
    defaultSize: { w: 150, h: 86 },
    paths: (w, h) => {
      const fold = Math.min(w * 0.22, 26);
      return [
        `M0,0 H${r(w - fold)} L${w},${r(fold)} V${h} H0 Z`,
        `M${r(w - fold)},0 V${r(fold)} H${w}`,
      ];
    },
    inset: () => ({ x: 0, y: 6 }),
  },
  {
    id: "venn-set",
    label: "Set",
    families: ["venn"],
    defaultSize: { w: 200, h: 200 },
    paths: (w, h) => [ellipsePath(w, h)],
    inset: (w, h) => ({ x: w * 0.16, y: h * 0.16 }),
    translucent: true,
  },
  {
    id: "cloud",
    label: "Cloud",
    families: ["network", "block"],
    defaultSize: { w: 170, h: 100 },
    paths: (w, h) => [
      `M${r(w * 0.25)},${r(h * 0.78)} A${r(w * 0.17)},${r(h * 0.22)} 0 0 1 ${r(w * 0.18)},${r(h * 0.42)} A${r(w * 0.19)},${r(h * 0.26)} 0 0 1 ${r(w * 0.46)},${r(h * 0.2)} A${r(w * 0.2)},${r(h * 0.26)} 0 0 1 ${r(w * 0.8)},${r(h * 0.36)} A${r(w * 0.16)},${r(h * 0.22)} 0 0 1 ${r(w * 0.76)},${r(h * 0.78)} Z`,
    ],
    inset: (w, h) => ({ x: w * 0.2, y: h * 0.28 }),
  },
];

export const GEOMETRY_BY_ID = new Map(GEOMETRIES.map((g) => [g.id, g]));

/**
 * Always returns a geometry. Persisted boards and imported graphs can name a
 * geometry this build does not have, and a missing outline must not be able to
 * take the canvas down.
 */
export const getGeometry = (id: GeometryId | undefined): Geometry =>
  (id && GEOMETRY_BY_ID.get(id)) || GEOMETRIES[0];

export const FAMILY_LABELS: Record<DiagramFamily, string> = {
  flowchart: "Flowchart",
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

export const FAMILY_ORDER: DiagramFamily[] = [
  "flowchart",
  "bpmn",
  "dfd",
  "uml",
  "network",
  "block",
  "sitemap",
  "orgchart",
  "venn",
  "mindmap",
];

export const geometriesFor = (family: DiagramFamily): Geometry[] =>
  GEOMETRIES.filter((g) => g.families.includes(family));
