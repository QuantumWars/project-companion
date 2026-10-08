/**
 * Components: the architecture nodes that own work.
 *
 * The canvas already describes what the system is. This makes each node on it a
 * unit of accountability -- something with a name, an owner, a region of the
 * source, its own board and its own evidence. The architecture stops being a
 * picture of the system and becomes the way you navigate the work inside it.
 *
 * ---- the join key ----
 *
 * A component declares `paths`, exactly as a PRD feature does. That one
 * declaration is what lets everything else resolve: a commit touches files,
 * files resolve to a component, and so tasks, features, agent runs, review
 * findings and churn all land on the same node without anyone linking them by
 * hand. One rule, reused six ways.
 *
 * It inherits the rule that governs feature attribution in `git-link.ts`, for
 * the same reason: **an ambiguous match is no match**. Where two components
 * claim a file equally well, nothing is attributed. Presenting a coin-flip as
 * evidence is worse than presenting nothing, and here it would put another
 * team's work on your node.
 *
 * ---- why identity is separate from the node id ----
 *
 * React Flow node ids come from the canvas store. They survive a rename and a
 * relayout, but not a delete-and-recreate, and they mean nothing outside the
 * diagram that holds them. A component id is stamped once and never rewritten --
 * the same trick `docs/prd.md` plays with `<!-- id: -->`, and for the same
 * reason: the thing work is attached to must outlive the thing that draws it.
 *
 * When a node disappears the component is ORPHANED, never deleted. Losing a link
 * is recoverable; silently rebinding somebody's shipped work to a different
 * service is not.
 */

import { randomUUID } from "node:crypto";

import { globToRegExp } from "./git-link";

export const COMPONENT_LIFECYCLES = ["proposed", "active", "deprecated"] as const;
export type ComponentLifecycle = (typeof COMPONENT_LIFECYCLES)[number];

export type Component = {
  id: string;
  title: string;
  /** The canvas node that draws it, and the diagram that node lives on. */
  nodeId?: string;
  diagramId?: string;
  /** The `ArchNodeKind` of the node, kept so the catalog reads without the canvas. */
  kind?: string;
  /**
   * The directly responsible individual.
   *
   * Optional in the type and mandatory in practice: an unowned component is
   * reported by `catalogWarnings`, because a catalog nobody owns is the failure
   * mode every internal developer portal dies of.
   */
  owner?: string;
  /** Globs naming the source this component owns. The join key. */
  paths?: string[];
  lifecycle: ComponentLifecycle;
  /** Containment, for the C4 zoom: context holds containers hold components. */
  parentId?: string;
  /** The diagram you drill into from this node. */
  drilldownDiagramId?: string;
  /**
   * The node is gone from the canvas but work still points here. Never deleted
   * automatically; see the header.
   */
  orphaned?: boolean;
  createdAt: string;
  updatedAt: string;
};

/* --------------------------------- identity -------------------------------- */

/** Readable, because a person types it into a CLI and reads it in a diff. */
export const componentId = (title: string, taken: readonly string[]): string => {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || randomUUID().slice(0, 8);

  let id = base;
  while (taken.includes(id)) id = `${base}-${randomUUID().slice(0, 6)}`;
  return id;
};

/* -------------------------------- resolution ------------------------------- */

/**
 * How specific a glob is, as a comparable tuple.
 *
 * The measure has to be explainable, because when the tool tells somebody their
 * commit landed on `auth-service` they will want to know why it was not
 * `platform`. In order:
 *
 *   1. the literal prefix before the first wildcard  -- `lib/auth/` beats `lib/`
 *   2. total literal characters                      -- a longer pattern is a
 *                                                       narrower claim
 *   3. fewer `**`                                    -- crossing directories is
 *                                                       the vaguest thing a glob
 *                                                       can do
 *
 * Compared left to right, so a longer prefix always wins outright. That is the
 * same intuition `.gitignore` and CODEOWNERS train people to expect.
 */
export const specificity = (glob: string): [number, number, number] => {
  const firstWildcard = glob.search(/[*?]/);
  const prefix = firstWildcard === -1 ? glob.length : firstWildcard;
  const literals = glob.replace(/[*?]/g, "").length;
  const doubleStars = (glob.match(/\*\*/g) ?? []).length;
  return [prefix, literals, -doubleStars];
};

const compareSpecificity = (a: [number, number, number], b: [number, number, number]) =>
  b[0] - a[0] || b[1] - a[1] || b[2] - a[2];

/** The most specific glob on this component that matches, if any. */
const bestMatch = (path: string, component: Component): string | undefined => {
  const hits = (component.paths ?? []).filter((g) => globToRegExp(g).test(path));
  if (!hits.length) return undefined;
  return hits.sort((a, b) => compareSpecificity(specificity(a), specificity(b)))[0];
};

export type PathResolution = {
  componentId: string;
  /** The glob that won, so the UI can explain the attribution rather than assert it. */
  glob: string;
};

/**
 * Which component owns a file.
 *
 * Returns nothing when two components claim it equally well. That is not a
 * limitation to work around later -- it is the signal that the catalog is
 * wrong, and `catalogWarnings` surfaces it so somebody narrows a glob instead of
 * the tool quietly picking a side.
 */
export const resolveComponent = (
  path: string,
  components: readonly Component[],
): PathResolution | undefined => {
  const ranked = components
    .map((c) => ({ component: c, glob: bestMatch(path, c) }))
    .filter((m): m is { component: Component; glob: string } => m.glob !== undefined)
    .sort((a, b) => compareSpecificity(specificity(a.glob), specificity(b.glob)));

  if (!ranked.length) return undefined;

  if (ranked.length > 1) {
    const tie =
      compareSpecificity(specificity(ranked[0].glob), specificity(ranked[1].glob)) === 0;
    if (tie) return undefined;
  }

  return { componentId: ranked[0].component.id, glob: ranked[0].glob };
};

export type ComponentChurn = {
  componentId: string;
  insertions: number;
  deletions: number;
  files: number;
};

/**
 * Churn per component across a set of changed files.
 *
 * The mirror of `touchedBy` in `git-link.ts`, and deliberately a separate
 * question from `resolveComponent`. What a change was FOR is singular; what it
 * TOUCHED is plural and measurable, and a commit that lands the parser and the
 * git layer together should show up as evidence on both.
 */
export const componentChurn = (
  files: readonly { path: string; insertions: number; deletions: number }[],
  components: readonly Component[],
): ComponentChurn[] => {
  const totals = new Map<string, ComponentChurn>();

  for (const file of files) {
    const owner = resolveComponent(file.path, components);
    if (!owner) continue;

    const entry = totals.get(owner.componentId) ?? {
      componentId: owner.componentId,
      insertions: 0,
      deletions: 0,
      files: 0,
    };
    entry.insertions += file.insertions;
    entry.deletions += file.deletions;
    entry.files += 1;
    totals.set(owner.componentId, entry);
  }

  return Array.from(totals.values()).sort((a, b) => b.files - a.files);
};

/* ------------------------------ reconciliation ----------------------------- */

/** The little a canvas node has to expose for reconciliation to work. */
export type CanvasNode = {
  id: string;
  data: { componentId?: string; label?: string; kind?: string };
};

export type Reconciliation = {
  /** Stamped nodes with no component record yet. */
  create: { componentId: string; nodeId: string; title: string; kind?: string }[];
  /** Components on this diagram whose node has gone. */
  orphan: string[];
  /** Orphans whose node has come back -- an undo, or a branch switch. */
  restore: { componentId: string; nodeId: string; title: string }[];
  /** Components whose node was renamed or re-created under a new node id. */
  update: { componentId: string; nodeId: string; title: string }[];
};

const EMPTY: Reconciliation = { create: [], orphan: [], restore: [], update: [] };

/**
 * What the catalog should look like after a diagram was saved.
 *
 * Pure, and separate from the store on purpose: this is the rule about what a
 * canvas edit means for the catalog, and it is worth being able to state it
 * without a filesystem -- the same split `git-link.ts` and `git-view.ts` have.
 *
 * Three things it is careful about:
 *
 *   - Only components belonging to THIS diagram are candidates for orphaning.
 *     A node vanishing from one board says nothing about a component drawn on
 *     another, and orphaning on that basis would empty the catalog every time
 *     somebody opened a second canvas.
 *
 *   - A stamped node whose component is missing is CREATED, not ignored. That
 *     is how a diagram copied out of another project, or one restored from an
 *     older commit, heals itself instead of quietly losing its links.
 *
 *   - An orphan whose node reappears is restored rather than duplicated, so an
 *     undo puts the work back where it was.
 */
export const reconcile = (
  diagramId: string,
  nodes: readonly CanvasNode[],
  components: readonly Component[],
): Reconciliation => {
  const result: Reconciliation = { create: [], orphan: [], restore: [], update: [] };
  const byId = new Map(components.map((c) => [c.id, c]));
  const stamped = nodes.filter((n) => n.data.componentId);
  const claimed = new Set<string>();

  for (const node of stamped) {
    const id = node.data.componentId!;
    // Two nodes stamped with one id is a copy-paste; the first wins and the
    // second is left decorative rather than fighting over the component.
    if (claimed.has(id)) continue;
    claimed.add(id);

    const title = node.data.label?.trim() || id;
    const existing = byId.get(id);

    if (!existing) {
      result.create.push({ componentId: id, nodeId: node.id, title, kind: node.data.kind });
      continue;
    }
    if (existing.orphaned) {
      result.restore.push({ componentId: id, nodeId: node.id, title });
      continue;
    }
    if (existing.nodeId !== node.id || existing.title !== title) {
      result.update.push({ componentId: id, nodeId: node.id, title });
    }
  }

  for (const component of components) {
    if (component.diagramId !== diagramId || component.orphaned) continue;
    if (!claimed.has(component.id)) result.orphan.push(component.id);
  }

  return result;
};

/** True when reconciling would change nothing -- the common case on autosave. */
export const isNoop = (r: Reconciliation): boolean =>
  r.create.length === 0 &&
  r.orphan.length === 0 &&
  r.restore.length === 0 &&
  r.update.length === 0;

export const NO_CHANGES: Reconciliation = EMPTY;

/* ---------------------------------- tree ---------------------------------- */

export type ComponentNode = Component & { children: ComponentNode[] };

/**
 * Does walking up from here reach something with no parent?
 *
 * A dangling parent counts as reaching one -- the component is simply promoted
 * to a root. A cycle does not, which is the case that matters: if every member
 * of a cycle is attached to another member, none of them is ever a root, and the
 * entire subtree silently disappears from the tree. One bad drag on the canvas
 * is enough to cause that, so it is checked rather than assumed away.
 */
const reachesRoot = (id: string, byId: Map<string, Component>): boolean => {
  const seen = new Set<string>();
  let current: string | undefined = id;

  while (current) {
    if (seen.has(current)) return false;
    seen.add(current);
    const node = byId.get(current);
    if (!node) return true;
    current = node.parentId;
  }
  return true;
};

/**
 * The containment tree, for breadcrumbs and roll-ups.
 *
 * A parent that does not exist is treated as no parent rather than dropping the
 * component: a dangling `parentId` is a catalog problem, not a reason for
 * somebody's service to vanish from the tree. A cycle is handled the same way --
 * its members become roots, so a broken hierarchy shows up as a flat one rather
 * than as missing work.
 */
export const componentTree = (components: readonly Component[]): ComponentNode[] => {
  const byId = new Map(components.map((c) => [c.id, { ...c, children: [] as ComponentNode[] }]));
  const roots: ComponentNode[] = [];

  for (const node of Array.from(byId.values())) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    const attachable = parent && parent.id !== node.id && reachesRoot(node.id, byId);
    if (attachable) parent.children.push(node);
    else roots.push(node);
  }

  const sort = (nodes: ComponentNode[]) => {
    nodes.sort((a, b) => a.title.localeCompare(b.title));
    for (const n of nodes) sort(n.children);
  };
  sort(roots);

  return roots;
};

/**
 * A component and everything under it.
 *
 * What the workspace uses to roll a parent's board up from its children. Guards
 * against a cycle, because a `parentId` loop is one bad drag away and an
 * infinite recursion in the board is a much worse bug than a wrong tree.
 */
export const withDescendants = (
  id: string,
  components: readonly Component[],
): string[] => {
  const children = new Map<string, string[]>();
  for (const c of components) {
    if (!c.parentId) continue;
    const siblings = children.get(c.parentId) ?? [];
    siblings.push(c.id);
    children.set(c.parentId, siblings);
  }

  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (current: string) => {
    if (seen.has(current)) return;
    seen.add(current);
    out.push(current);
    for (const child of children.get(current) ?? []) walk(child);
  };
  walk(id);

  return out;
};

/** Root-first ancestry, for a breadcrumb. Stops on a cycle. */
export const ancestorsOf = (id: string, components: readonly Component[]): Component[] => {
  const byId = new Map(components.map((c) => [c.id, c]));
  const chain: Component[] = [];
  // Seeded with the start, so a cycle that leads back here stops rather than
  // listing this component as its own ancestor.
  const seen = new Set<string>([id]);

  let current = byId.get(id)?.parentId;
  while (current && !seen.has(current)) {
    seen.add(current);
    const parent = byId.get(current);
    if (!parent) break;
    chain.unshift(parent);
    current = parent.parentId;
  }

  return chain;
};

/* -------------------------------- hygiene --------------------------------- */

export type CatalogWarning = {
  componentId: string;
  kind: "unowned" | "no-paths" | "ambiguous-paths" | "orphaned" | "dangling-parent";
  detail: string;
};

export type Coverage = {
  owned: number;
  total: number;
  /** Directories with the most unclaimed files, worst first. */
  gaps: { directory: string; files: number; examples: string[] }[];
};

/**
 * How much of the source any component claims.
 *
 * The check the catalog was missing, and the one that matters most: every other
 * warning is about an entry that exists, so a catalog with three tidy
 * components covering a tenth of the codebase reported nothing wrong. Absence
 * of a complaint was being read as coverage.
 *
 * Reported by directory rather than by file. A hundred unowned files is not a
 * hundred problems -- it is usually two or three directories nobody has claimed
 * yet, and naming those is actionable where a file list is not.
 */
export const coverage = (
  files: readonly string[],
  components: readonly Component[],
): Coverage => {
  const gaps = new Map<string, string[]>();
  let owned = 0;

  for (const file of files) {
    if (resolveComponent(file, components)) {
      owned += 1;
      continue;
    }
    // Two levels is the useful grain: `lib/project` says something, `lib` does
    // not, and the full path is just the file again.
    const parts = file.split("/");
    const directory = parts.slice(0, Math.min(2, parts.length - 1)).join("/") || ".";
    const list = gaps.get(directory) ?? [];
    list.push(file);
    gaps.set(directory, list);
  }

  return {
    owned,
    total: files.length,
    gaps: Array.from(gaps.entries())
      .map(([directory, list]) => ({
        directory,
        files: list.length,
        examples: list.slice(0, 3),
      }))
      .sort((a, b) => b.files - a.files),
  };
};

/**
 * What is wrong with the catalog.
 *
 * Backstage's own lesson from years of rollouts is that catalog hygiene is the
 * single biggest predictor of whether any of this works -- an entry with no
 * owner and no paths is worse than no entry, because it looks like coverage.
 * The difference here is that most of it can be checked rather than requested:
 * a component with no paths attributes nothing, and two components claiming the
 * same file attribute nothing, and both are findable without asking anybody.
 */
export const catalogWarnings = (components: readonly Component[]): CatalogWarning[] => {
  const warnings: CatalogWarning[] = [];
  const ids = new Set(components.map((c) => c.id));

  for (const component of components) {
    if (component.orphaned) {
      warnings.push({
        componentId: component.id,
        kind: "orphaned",
        detail: "The canvas node is gone, but work still points here.",
      });
      // An orphan's other problems are noise; it needs re-attaching first.
      continue;
    }
    if (!component.owner) {
      warnings.push({
        componentId: component.id,
        kind: "unowned",
        detail: "No owner. Nobody is accountable for this component.",
      });
    }
    if (!component.paths?.length) {
      warnings.push({
        componentId: component.id,
        kind: "no-paths",
        detail: "No paths declared, so no commit will ever attribute here.",
      });
    }
    if (component.parentId && !ids.has(component.parentId)) {
      warnings.push({
        componentId: component.id,
        kind: "dangling-parent",
        detail: `Parent "${component.parentId}" does not exist.`,
      });
    }
  }

  // Two components whose globs are equally specific claim the same files and so
  // silently attribute nothing. Reported against both, because either one being
  // narrowed fixes it.
  for (let i = 0; i < components.length; i++) {
    for (let j = i + 1; j < components.length; j++) {
      const clash = equallySpecificOverlap(components[i], components[j]);
      if (!clash) continue;
      for (const component of [components[i], components[j]]) {
        warnings.push({
          componentId: component.id,
          kind: "ambiguous-paths",
          detail: `"${clash}" is claimed just as strongly by ${
            component.id === components[i].id ? components[j].id : components[i].id
          }; neither will be attributed.`,
        });
      }
    }
  }

  return warnings;
};

/** An identical glob on two components is the case that always ties. */
const equallySpecificOverlap = (a: Component, b: Component): string | undefined =>
  (a.paths ?? []).find((glob) => (b.paths ?? []).includes(glob));
