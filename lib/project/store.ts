/**
 * Filesystem store for a project.
 *
 * Node-only -- imported by the CLI and the MCP server, never by the browser
 * bundle. Every write is atomic (write a temp file, then rename) because an
 * agent and a human can be editing the same board at the same moment, and a
 * half-written JSON file would take the canvas down.
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";

import {
  BUNDLE_FILE,
  bundleRefs,
  emptyBundle,
  mutateBundle,
  readBundle,
  removeBundle,
  migrateToBundle,
  writeBundle,
  type AgentPolicy,
  type ProjectBundle,
} from "./bundle";
import {
  componentId,
  isNoop,
  reconcile,
  type CanvasNode,
  type Component,
  type ComponentLifecycle,
  type Reconciliation,
} from "./component";
import { appendEvent, readEvents, type NewEvent } from "./events";
import {
  canTransition,
  checkBudget,
  mayWrite,
  runsFrom,
  type AgentRun,
  type BudgetVerdict,
  type RunActor,
  type RunState,
} from "./run";
import {
  DEFAULT_STORE_DIR,
  DEFAULT_PRD_PATH,
  emptyProject,
  emptyTasks,
  refKind,
  FORMAT_VERSION,
  STORE_DIRS,
  TASK_STATUSES,
  type DiagramFile,
  type ProjectFile,
  type DiagramRef,
  type Task,
  type TaskStatus,
  type TasksFile,
  type WhiteboardFile,
  LEGACY_STORE_DIRS,
} from "./types";
import type { ArchEdge, ArchNode, DiagramType } from "@/types/arch";

/* --------------------------------- paths ---------------------------------- */

/**
 * Locates the project by walking up for any known agent store directory.
 *
 * Claude Code sets `CLAUDE_PROJECT_DIR` on every stdio MCP server it spawns,
 * which is more reliable than the process cwd -- the server is a subprocess and
 * its cwd is not guaranteed to be the repo.
 *
 * Returns the store's own relative directory too, because a repo can hold more
 * than one agent directory and the caller must not have to guess which one is
 * in use.
 */
/**
 * Discovery is cached, and the cache checks itself.
 *
 * `usesBundle` calls this, and `usesBundle` runs on every read and every write
 * -- so listing tasks walked the tree once per task, stat-ing four candidate
 * paths at every level on the way up.
 *
 * The cache re-confirms its answer with a single `existsSync` rather than
 * relying on every code path that creates, moves, migrates or deletes a project
 * remembering to invalidate it. That discipline is the kind that holds until
 * somebody adds a fifth such path and does not know they have to; one stat
 * instead of four-per-level is nearly all of the win and cannot go stale.
 *
 * Only positive answers are cached. "There is no project here" has nothing to
 * re-confirm cheaply, and it is the answer most likely to stop being true --
 * `init` is precisely the act of making it false.
 *
 * Keyed by the directory asked about rather than held as one value, because a
 * long-lived process (the dev server) serves several projects through `?root=`.
 */
const discovered = new Map<string, { root: string; storeDir: string }>();

export const forgetDiscovery = () => discovered.clear();

const stillThere = (found: { root: string; storeDir: string }): boolean =>
  existsSync(
    found.storeDir === BUNDLE_FILE
      ? join(found.root, BUNDLE_FILE)
      : join(found.root, found.storeDir, "project.json"),
  );

export const findProject = (
  from?: string,
): { root: string; storeDir: string } | null => {
  const start = resolvePath(from ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd());

  const cached = discovered.get(start);
  if (cached && stillThere(cached)) return cached;
  if (cached) discovered.delete(start);

  const found = discover(start);
  if (found) discovered.set(start, found);
  return found;
};

const discover = (start: string): { root: string; storeDir: string } | null => {
  let dir = start;

  for (;;) {
    // A `.project` file is the current format and wins wherever it is found.
    if (existsSync(join(dir, BUNDLE_FILE))) {
      return { root: dir, storeDir: BUNDLE_FILE };
    }

    // The split layout is still discovered, so a project created before the
    // single-file format keeps working until its owner chooses to migrate.
    for (const candidate of STORE_DIRS) {
      if (existsSync(join(dir, candidate, "project.json"))) {
        return { root: dir, storeDir: candidate };
      }
    }

    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
};

/** True when this project still uses the pre-bundle split layout. */
export const isLegacyStore = (storeDir: string): boolean => storeDir !== BUNDLE_FILE;

export const findProjectRoot = (from?: string): string | null =>
  findProject(from)?.root ?? null;

/**
 * Which store directory to create in a repo that has none.
 *
 * If the repo already has an agent directory, the store goes inside it rather
 * than adding another top-level folder.
 */
export const chooseStoreDir = (root: string): string => {
  // Legacy names are discovered but never chosen: a project created today
  // should not land in `.arch/` just because that directory happens to exist.
  for (const candidate of STORE_DIRS) {
    if (LEGACY_STORE_DIRS.includes(candidate)) continue;
    const agentDir = candidate.split("/")[0];
    if (existsSync(join(root, agentDir))) return candidate;
  }
  return DEFAULT_STORE_DIR;
};

export const projectPaths = (root: string, storeDir?: string) => {
  const base = storeDir ?? findProject(root)?.storeDir ?? chooseStoreDir(root);

  return {
    root,
    storeDir: base,
    dir: join(root, base),
    project: join(root, base, "project.json"),
    diagrams: join(root, base, "diagrams"),
    tasks: join(root, base, "tasks.json"),
    diagram: (id: string) => join(root, base, "diagrams", `${id}.json`),
    boards: join(root, base, "boards"),
    board: (id: string) => join(root, base, "boards", `${id}.json`),
    roadmap: join(root, base, "roadmap.json"),
    /** Derived data only. Gitignored: it must always be safe to delete. */
    cache: join(root, ".project-cache"),
    gitCache: join(root, ".project-cache", "git.json"),
    /** The PRD itself lives in the repo, not the store. */
    prd: (source: string) => join(root, source),
  };
};

/* ---------------------------------- io ------------------------------------ */

export const readJson = <T,>(path: string, fallback: T): T => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
};

/** Write-then-rename so a reader never observes a partial file. */
export const writeJson = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
};

const now = () => new Date().toISOString();

/**
 * Records what just happened, without ever failing the thing that happened.
 *
 * The log is an audit trail beside the state, not the state itself: `.project`
 * is still the source of truth for what a project currently is. So a log that
 * cannot be written -- a read-only checkout, a permissions problem, a full disk
 * -- must not turn a successful task edit into an error the user has to
 * understand. It is appended after the write succeeds, so nothing is ever
 * recorded that did not actually land.
 */
const logEvent = (root: string, event: NewEvent): void => {
  try {
    appendEvent(root, event);
  } catch {
    // Deliberately silent; see above.
  }
};

/** Ids are readable so they are pleasant to type in a CLI and read in a diff. */
const slugId = (title: string): string => {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return slug || randomUUID().slice(0, 8);
};

/* -------------------------------- project --------------------------------- */

export const initProject = (root: string, name: string): ProjectFile => {
  const found = findProject(root);

  // An existing project of either shape is returned untouched. Initialising is
  // not a reason to convert somebody's store out from under them.
  if (found && found.root === root) {
    return readProject(root);
  }

  writeBundle(root, { ...emptyBundle(name) });
  return readProject(root);
};

const legacyReadProject = (root: string): ProjectFile =>
  readJson(projectPaths(root).project, emptyProject("Untitled project"));

const legacyWriteProject = (root: string, project: ProjectFile) =>
  writeJson(projectPaths(root).project, project);

/** Keeps `project.json`'s index in step with what is on disk. */
const touchDiagramRef = (root: string, diagram: DiagramFile) => {
  const project = readProject(root);
  const ref = {
    id: diagram.id,
    title: diagram.title,
    type: diagram.type,
    updatedAt: diagram.updatedAt,
  };

  const index = project.diagrams.findIndex((d) => d.id === diagram.id);
  if (index === -1) project.diagrams.push(ref);
  else project.diagrams[index] = ref;

  legacyWriteProject(root, project);
};

/* -------------------------------- diagrams -------------------------------- */

const legacyListDiagrams = (root: string) => readProject(root).diagrams;

const legacyReadDiagram = (root: string, id: string): DiagramFile | null => {
  const path = projectPaths(root).diagram(id);
  return existsSync(path) ? readJson<DiagramFile | null>(path, null) : null;
};

const legacyWriteDiagram = (root: string, diagram: DiagramFile): DiagramFile => {
  const next: DiagramFile = { ...diagram, updatedAt: now() };
  writeJson(projectPaths(root).diagram(next.id), next);
  touchDiagramRef(root, next);
  return next;
};

const legacyCreateDiagram = (
  root: string,
  title: string,
  type: DiagramType = "architecture",
): DiagramFile => {
  let id = slugId(title);
  // Two diagrams called "Auth" must not overwrite one another.
  if (existsSync(projectPaths(root).diagram(id))) {
    id = `${id}-${randomUUID().slice(0, 6)}`;
  }

  return writeDiagram(root, {
    version: FORMAT_VERSION,
    id,
    title,
    type,
    updatedAt: now(),
    nodes: [],
    edges: [],
  });
};

const legacyDeleteDiagram = (root: string, id: string): boolean => {
  const path = projectPaths(root).diagram(id);
  if (!existsSync(path)) return false;

  rmSync(path);
  const project = readProject(root);
  project.diagrams = project.diagrams.filter((d) => d.id !== id);
  legacyWriteProject(root, project);
  return true;
};

/**
 * Moves an existing store into a different agent directory.
 *
 * Explicit rather than automatic: silently relocating a directory that is
 * committed to a repository would show up as a mystery diff.
 */
export const moveStore = (
  root: string,
  toStoreDir: string,
): { from: string; to: string } | null => {
  const current = findProject(root);
  if (!current || current.root !== root) return null;
  if (current.storeDir === toStoreDir) return null;

  const from = projectPaths(root, current.storeDir);
  const to = projectPaths(root, toStoreDir);

  mkdirSync(dirname(to.dir), { recursive: true });
  renameSync(from.dir, to.dir);

  // The store is somewhere else now; a cached answer would point at the old one.
  forgetDiscovery();
  return { from: current.storeDir, to: toStoreDir };
};

/**
 * Repairs the index from what is actually on disk.
 *
 * Must walk **both** collections: whiteboards live in `boards/` and are listed
 * in the same index, so scanning only `diagrams/` would quietly drop every
 * whiteboard from the project.
 */
export const reindexDiagrams = (root: string): number => {
  const paths = projectPaths(root);
  const project = readProject(root);

  const scan = <T,>(dir: string, map: (file: T) => DiagramRef): DiagramRef[] => {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => readJson<T | null>(join(dir, f), null))
      .filter((d): d is T => d !== null)
      .map(map);
  };

  project.diagrams = [
    ...scan<DiagramFile>(paths.diagrams, (d) => ({
      id: d.id,
      title: d.title,
      type: d.type,
      kind: "diagram",
      updatedAt: d.updatedAt,
    })),
    ...scan<WhiteboardFile>(paths.boards, (b) => ({
      id: b.id,
      title: b.title,
      type: "architecture",
      kind: "whiteboard",
      updatedAt: b.updatedAt,
    })),
  ];

  legacyWriteProject(root, project);
  return project.diagrams.length;
};

/** `realpath` so a symlinked path cannot masquerade as a different root. */
const canonicalise = (path: string): string => {
  try {
    return realpathSync(resolvePath(path));
  } catch {
    return resolvePath(path);
  }
};

/**
 * Deletes a project's entire store.
 *
 * Nothing else here removes more than one file at a time, so this is
 * deliberately narrow: it resolves the store from the root it was given,
 * refuses to act unless that directory demonstrably contains a `project.json`,
 * and never touches anything above it. A store lives inside a repository full
 * of the user's source, and a delete that walked one level too far would take
 * that with it.
 *
 * Returns what was removed, so a caller can report it rather than guess.
 */
export const deleteProject = (
  root: string,
): { removed: string; diagrams: number; tasks: number } | null => {
  const found = findProject(root);
  if (!found || canonicalise(found.root) !== canonicalise(root)) return null;

  const summary = {
    removed: "",
    diagrams: listDiagrams(found.root).length,
    tasks: readTasks(found.root).tasks.length,
  };

  if (found.storeDir === BUNDLE_FILE) {
    summary.removed = join(found.root, BUNDLE_FILE);
    if (!removeBundle(found.root)) return null;
  } else {
    const paths = projectPaths(found.root, found.storeDir);
    // Only ever delete a directory that demonstrably IS a store. Without this
    // a wrong root would remove an arbitrary folder from the user's repository.
    if (!existsSync(paths.project)) return null;
    summary.removed = paths.dir;
    rmSync(paths.dir, { recursive: true, force: true });
  }

  // Derived data is not part of the project, but it should not outlive it.
  rmSync(join(found.root, ".project-cache"), { recursive: true, force: true });
  return summary;
};

/* ------------------------------- whiteboards ------------------------------ */

const legacyReadWhiteboard = (
  root: string,
  id: string,
): WhiteboardFile | null => {
  const path = projectPaths(root).board(id);
  return existsSync(path) ? readJson<WhiteboardFile | null>(path, null) : null;
};

const legacyWriteWhiteboard = (
  root: string,
  board: WhiteboardFile,
): WhiteboardFile => {
  const next: WhiteboardFile = { ...board, updatedAt: now() };
  writeJson(projectPaths(root).board(next.id), next);

  // Whiteboards share the project index with diagrams so every board in the
  // project is listed in one place.
  const project = readProject(root);
  const ref = {
    id: next.id,
    title: next.title,
    type: "architecture" as const,
    kind: "whiteboard" as const,
    updatedAt: next.updatedAt,
  };
  const index = project.diagrams.findIndex((d) => d.id === next.id);
  if (index === -1) project.diagrams.push(ref);
  else project.diagrams[index] = ref;
  legacyWriteProject(root, project);

  return next;
};

const legacyCreateWhiteboard = (root: string, title: string): WhiteboardFile => {
  let id = slugId(title);
  if (existsSync(projectPaths(root).board(id))) {
    id = `${id}-${randomUUID().slice(0, 6)}`;
  }

  return writeWhiteboard(root, {
    version: FORMAT_VERSION,
    id,
    title,
    updatedAt: now(),
    layerIds: [],
    layers: [],
  });
};

const legacyDeleteWhiteboard = (root: string, id: string): boolean => {
  const path = projectPaths(root).board(id);
  if (!existsSync(path)) return false;

  rmSync(path);
  const project = readProject(root);
  project.diagrams = project.diagrams.filter((d) => d.id !== id);
  legacyWriteProject(root, project);
  return true;
};


/**
 * Moves a split store into a single `.project` file.
 *
 * The old directory is only removed once the bundle has been written and read
 * back with the same counts.
 */
/**
 * Set by the registry at import time.
 *
 * The store cannot import the registry -- the registry already imports the
 * store -- so the dependency is inverted rather than made circular.
 */
let reregister: ((root: string) => unknown) | undefined;
export const onProjectMoved = (fn: (root: string) => unknown) => {
  reregister = fn;
};

export const migrateProject = (
  root: string,
): { diagrams: number; boards: number; tasks: number; removed: string } | null => {
  const found = findProject(root);
  if (!found || found.storeDir === BUNDLE_FILE) return null;

  const paths = projectPaths(found.root, found.storeDir);
  const project = legacyReadProject(found.root);
  const refs = legacyListDiagrams(found.root);

  const diagrams = refs
    .filter((r) => refKind(r) !== "whiteboard")
    .map((r) => legacyReadDiagram(found.root, r.id))
    .filter((d): d is DiagramFile => d !== null);
  const boards = refs
    .filter((r) => refKind(r) === "whiteboard")
    .map((r) => legacyReadWhiteboard(found.root, r.id))
    .filter((b): b is WhiteboardFile => b !== null);

  const sidecar = readJson<{
    source?: string;
    phases?: never[];
    overrides?: Record<string, never>;
    orphans?: never[];
  } | null>(paths.roadmap, null);

  // Read the counts BEFORE the old store is removed; reading them afterwards
  // reports zero for everything that was successfully migrated.
  const tasks = legacyReadTasks(found.root).tasks;

  migrateToBundle(found.root, {
    name: project.name,
    createdAt: project.createdAt,
    prdSource: sidecar?.source || DEFAULT_PRD_PATH,
    diagrams,
    boards,
    tasks,
    roadmap: {
      phases: sidecar?.phases ?? [],
      overrides: sidecar?.overrides ?? {},
      orphans: sidecar?.orphans ?? [],
    },
  });

  rmSync(paths.dir, { recursive: true, force: true });

  // The recorded storeDir just changed; without re-registering, the global
  // index still points at a directory that no longer exists.
  void reregister?.(found.root);

  return {
    diagrams: diagrams.length,
    boards: boards.length,
    tasks: tasks.length,
    removed: paths.dir,
  };
};

/* ------------------------------- dispatch --------------------------------- */

/**
 * Every public read and write goes through here.
 *
 * A project is either a single `.project` file or the older split layout, and
 * the rest of the codebase should not have to know which. Keeping the legacy
 * path working rather than forcing a migration means an existing project keeps
 * opening exactly as it did.
 */
const usesBundle = (root: string): boolean =>
  findProject(root)?.storeDir === BUNDLE_FILE;

const requireBundle = (root: string): ProjectBundle => {
  const bundle = readBundle(root);
  if (!bundle) throw new Error(`No ${BUNDLE_FILE} at ${root}`);
  return bundle;
};

export const readProject = (root: string): ProjectFile => {
  if (!usesBundle(root)) return legacyReadProject(root);
  const bundle = requireBundle(root);
  return {
    version: bundle.version,
    name: bundle.name,
    createdAt: bundle.createdAt,
    diagrams: bundleRefs(bundle),
  };
};

export const listDiagrams = (root: string): DiagramRef[] =>
  usesBundle(root) ? bundleRefs(requireBundle(root)) : legacyListDiagrams(root);

export const readDiagram = (root: string, id: string): DiagramFile | null =>
  usesBundle(root)
    ? requireBundle(root).diagrams[id] ?? null
    : legacyReadDiagram(root, id);

export const writeDiagram = (root: string, diagram: DiagramFile): DiagramFile => {
  if (!usesBundle(root)) return legacyWriteDiagram(root, diagram);
  const next = { ...diagram, updatedAt: now() };

  // The canvas and the catalog are reconciled in the same transaction as the
  // save. Doing it afterwards would leave a window where a node has been
  // deleted but its component still claims to be drawn, and the autosave that
  // window sits inside fires every time somebody drags a box.
  let changes: Reconciliation | undefined;
  mutateBundle(root, (b) => {
    b.diagrams[next.id] = next;
    changes = applyReconciliation(b, next.id, next.nodes as unknown as CanvasNode[]);
  });

  if (changes) logReconciliation(root, changes);
  return next;
};

/**
 * Brings the catalog into line with what the diagram now contains.
 *
 * Runs inside the bundle lock, so it takes the bundle rather than a root and
 * does no I/O of its own. The decision of what SHOULD change is `reconcile`,
 * which is pure and tested on its own; this only applies it.
 */
const applyReconciliation = (
  bundle: ProjectBundle,
  diagramId: string,
  nodes: readonly CanvasNode[],
): Reconciliation => {
  const changes = reconcile(diagramId, nodes, Object.values(bundle.components));
  if (isNoop(changes)) return changes;

  for (const made of changes.create) {
    bundle.components[made.componentId] = {
      id: made.componentId,
      title: made.title,
      nodeId: made.nodeId,
      diagramId,
      kind: made.kind,
      lifecycle: "active",
      createdAt: now(),
      updatedAt: now(),
    };
  }

  for (const back of changes.restore) {
    const current = bundle.components[back.componentId];
    if (!current) continue;
    // `orphaned` is cleared rather than set false, so the field is absent on a
    // healthy component and a JSON diff stays quiet.
    const { orphaned, ...rest } = current;
    bundle.components[back.componentId] = {
      ...rest,
      nodeId: back.nodeId,
      diagramId,
      title: back.title,
      updatedAt: now(),
    };
  }

  for (const moved of changes.update) {
    const current = bundle.components[moved.componentId];
    if (!current) continue;
    bundle.components[moved.componentId] = {
      ...current,
      nodeId: moved.nodeId,
      title: moved.title,
      updatedAt: now(),
    };
  }

  for (const gone of changes.orphan) {
    const current = bundle.components[gone];
    if (!current) continue;
    bundle.components[gone] = {
      ...current,
      orphaned: true,
      nodeId: undefined,
      updatedAt: now(),
    };
  }

  return changes;
};

const logReconciliation = (root: string, changes: Reconciliation): void => {
  for (const made of changes.create) {
    logEvent(root, {
      kind: "component.created",
      componentId: made.componentId,
      data: { title: made.title, via: "canvas" },
    });
  }
  for (const back of changes.restore) {
    logEvent(root, {
      kind: "component.updated",
      componentId: back.componentId,
      data: { restored: true, via: "canvas" },
    });
  }
  for (const gone of changes.orphan) {
    logEvent(root, { kind: "component.orphaned", componentId: gone, data: { via: "canvas" } });
  }
};

export const createDiagram = (
  root: string,
  title: string,
  type: DiagramType = "architecture",
): DiagramFile => {
  if (!usesBundle(root)) return legacyCreateDiagram(root, title, type);

  const bundle = requireBundle(root);
  let id = slugId(title);
  while (bundle.diagrams[id] || bundle.boards[id]) id = `${slugId(title)}-${randomUUID().slice(0, 6)}`;

  const diagram: DiagramFile = {
    version: FORMAT_VERSION,
    id,
    title,
    type,
    updatedAt: now(),
    nodes: [],
    edges: [],
  };
  mutateBundle(root, (b) => {
    b.diagrams[id] = diagram;
  });
  return diagram;
};

export const deleteDiagram = (root: string, id: string): boolean => {
  if (!usesBundle(root)) return legacyDeleteDiagram(root, id);
  let removed = false;
  mutateBundle(root, (b) => {
    removed = Boolean(b.diagrams[id]);
    delete b.diagrams[id];
    // A task pointing at a deleted diagram would dangle, so drop the link but
    // keep the task: the work is still real even if the drawing is gone.
    for (const task of b.tasks) if (task.diagramId === id) task.diagramId = undefined;
  });
  return removed;
};

export const readWhiteboard = (root: string, id: string): WhiteboardFile | null =>
  usesBundle(root)
    ? requireBundle(root).boards[id] ?? null
    : legacyReadWhiteboard(root, id);

export const writeWhiteboard = (root: string, board: WhiteboardFile): WhiteboardFile => {
  if (!usesBundle(root)) return legacyWriteWhiteboard(root, board);
  const next = { ...board, updatedAt: now() };
  mutateBundle(root, (b) => {
    b.boards[next.id] = next;
  });
  return next;
};

export const createWhiteboard = (root: string, title: string): WhiteboardFile => {
  if (!usesBundle(root)) return legacyCreateWhiteboard(root, title);

  const bundle = requireBundle(root);
  let id = slugId(title);
  while (bundle.diagrams[id] || bundle.boards[id]) id = `${slugId(title)}-${randomUUID().slice(0, 6)}`;

  const board: WhiteboardFile = {
    version: FORMAT_VERSION,
    id,
    title,
    updatedAt: now(),
    layerIds: [],
    layers: [],
  };
  mutateBundle(root, (b) => {
    b.boards[id] = board;
  });
  return board;
};

export const deleteWhiteboard = (root: string, id: string): boolean => {
  if (!usesBundle(root)) return legacyDeleteWhiteboard(root, id);
  let removed = false;
  mutateBundle(root, (b) => {
    removed = Boolean(b.boards[id]);
    delete b.boards[id];
    // Same as `deleteDiagram`: both kinds of board share one id space and one
    // `task.diagramId` field, so a whiteboard deletion left exactly the same
    // dangling pointer -- it was simply never cleaned up on this path.
    for (const task of b.tasks) if (task.diagramId === id) task.diagramId = undefined;
  });
  return removed;
};

export const readTasks = (root: string): TasksFile =>
  usesBundle(root)
    ? { version: FORMAT_VERSION, tasks: requireBundle(root).tasks }
    : legacyReadTasks(root);

/**
 * Changes the task list inside the lock.
 *
 * `readTasks` then `writeTasks` is not safe under concurrency: the read happens
 * outside the lock, so the write puts back a snapshot taken before anything
 * else landed, silently erasing it. That is not a hypothetical -- twenty
 * concurrent writes reliably produced seventeen tasks. Every task mutation goes
 * through here instead, so the change is applied to state read inside the lock.
 */
const mutateTasks = <T>(root: string, change: (tasks: Task[]) => T): T | null => {
  if (usesBundle(root)) {
    let result: T | undefined;
    const written = mutateBundle(root, (b) => {
      result = change(b.tasks);
    });
    return written ? (result as T) : null;
  }

  const file = legacyReadTasks(root);
  const result = change(file.tasks);
  legacyWriteTasks(root, file);
  return result;
};

export const writeTasks = (root: string, tasks: TasksFile): void => {
  if (!usesBundle(root)) return legacyWriteTasks(root, tasks);
  mutateBundle(root, (b) => {
    b.tasks = tasks.tasks;
  });
};

/* --------------------------- diagram mutations ---------------------------- */

export const addNode = (
  root: string,
  diagramId: string,
  node: ArchNode,
): DiagramFile | null => {
  const diagram = readDiagram(root, diagramId);
  if (!diagram) return null;

  const existing = diagram.nodes.findIndex((n) => n.id === node.id);
  if (existing === -1) diagram.nodes.push(node);
  else diagram.nodes[existing] = node;

  return writeDiagram(root, diagram);
};

/**
 * Chooses which sides an edge should leave and enter.
 *
 * An agent calling `connect_nodes` knows the two nodes, not the geometry, so
 * hardcoding right-to-left makes every edge whose target sits above, below or
 * behind the source loop back on itself. Picking from the dominant axis keeps
 * the routing readable without the caller thinking about handles at all.
 */
export const pickHandles = (
  source: ArchNode,
  target: ArchNode,
): { sourceHandle: string; targetHandle: string } => {
  const dx = target.position.x - source.position.x;
  const dy = target.position.y - source.position.y;

  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { sourceHandle: "r", targetHandle: "l" }
      : { sourceHandle: "l", targetHandle: "r" };
  }

  return dy >= 0
    ? { sourceHandle: "b", targetHandle: "t" }
    : { sourceHandle: "t", targetHandle: "b" };
};

export const addEdge = (
  root: string,
  diagramId: string,
  edge: ArchEdge,
): DiagramFile | null => {
  const diagram = readDiagram(root, diagramId);
  if (!diagram) return null;

  const source = diagram.nodes.find((n) => n.id === edge.source);
  const target = diagram.nodes.find((n) => n.id === edge.target);
  if (!source || !target) return null;

  // Fill in the sides only when the caller did not choose them.
  const resolved: ArchEdge =
    edge.sourceHandle && edge.targetHandle
      ? edge
      : { ...edge, ...pickHandles(source, target) };

  const existing = diagram.edges.findIndex((e) => e.id === edge.id);
  if (existing === -1) diagram.edges.push(resolved);
  else diagram.edges[existing] = resolved;

  return writeDiagram(root, diagram);
};

export const removeNode = (
  root: string,
  diagramId: string,
  nodeId: string,
): DiagramFile | null => {
  const diagram = readDiagram(root, diagramId);
  if (!diagram) return null;

  diagram.nodes = diagram.nodes.filter((n) => n.id !== nodeId);
  // An edge to a node that no longer exists would not render.
  diagram.edges = diagram.edges.filter(
    (e) => e.source !== nodeId && e.target !== nodeId,
  );

  return writeDiagram(root, diagram);
};

/* ------------------------------- components ------------------------------- */

/**
 * Components live only in the bundle.
 *
 * They postdate the split store entirely, so rather than growing a `legacy*`
 * twin that could never have data in it, a pre-bundle project reports none and
 * refuses to create one. `project-companion migrate` is a single command, and
 * saying so is better than half-supporting a format on its way out.
 */
const requireComponentStore = (root: string): void => {
  if (!usesBundle(root)) {
    throw new Error(
      "Components need the single-file format. Run `project-companion migrate` first.",
    );
  }
};

export const readComponents = (root: string): Component[] =>
  usesBundle(root) ? Object.values(requireBundle(root).components) : [];

export const readComponent = (root: string, id: string): Component | null =>
  (usesBundle(root) ? requireBundle(root).components[id] : undefined) ?? null;

export type ComponentInput = {
  title: string;
  nodeId?: string;
  diagramId?: string;
  kind?: string;
  owner?: string;
  paths?: string[];
  parentId?: string;
  drilldownDiagramId?: string;
  lifecycle?: ComponentLifecycle;
};

export const createComponent = (root: string, input: ComponentInput): Component => {
  requireComponentStore(root);

  let created: Component | undefined;
  mutateBundle(root, (b) => {
    const component: Component = {
      id: componentId(input.title, Object.keys(b.components)),
      title: input.title,
      nodeId: input.nodeId,
      diagramId: input.diagramId,
      kind: input.kind,
      owner: input.owner,
      paths: input.paths,
      parentId: input.parentId,
      drilldownDiagramId: input.drilldownDiagramId,
      lifecycle: input.lifecycle ?? "active",
      createdAt: now(),
      updatedAt: now(),
    };
    b.components[component.id] = component;
    created = component;
  });

  if (!created) throw new Error("No project here.");
  logEvent(root, {
    kind: "component.created",
    componentId: created.id,
    data: { title: created.title, owner: created.owner, paths: created.paths },
  });
  return created;
};

/**
 * Patches a component.
 *
 * `id` is deliberately not patchable. It is what every task, commit and run
 * points at, and the whole reason it exists is that it never changes -- a
 * rename is a title change, not a new identity.
 */
export const updateComponent = (
  root: string,
  id: string,
  patch: Partial<Omit<Component, "id" | "createdAt">>,
): Component | null => {
  requireComponentStore(root);

  let updated: Component | null = null;
  mutateBundle(root, (b) => {
    const current = b.components[id];
    if (!current) return;
    b.components[id] = { ...current, ...patch, id, updatedAt: now() };
    updated = b.components[id];
  });

  if (updated) {
    logEvent(root, {
      kind: "component.updated",
      componentId: id,
      data: { changed: Object.keys(patch) },
    });
  }
  return updated;
};

/**
 * Makes a canvas node a component: stamps the node, creates the record.
 *
 * The opt-in half of the model. Reconciliation heals a catalog that has drifted,
 * but it never decides on its own that a box on a diagram is something a team
 * owns -- that is a claim somebody makes, and this is where they make it.
 *
 * Both halves happen in one transaction. Stamping the node and writing the
 * component separately would leave a save in between where the node points at a
 * component that does not exist yet, and reconciliation running in that window
 * would create a second one.
 */
export const trackNode = (
  root: string,
  diagramId: string,
  nodeId: string,
  input: { title?: string; owner?: string; paths?: string[]; parentId?: string } = {},
): Component | null => {
  requireComponentStore(root);

  let tracked: Component | null = null;
  let created = false;

  mutateBundle(root, (b) => {
    const diagram = b.diagrams[diagramId];
    const node = diagram?.nodes.find((n) => n.id === nodeId);
    if (!node) return;

    const data = node.data as { componentId?: string; label?: string; kind?: string };

    // Already tracked: return what is there rather than making a second one.
    const existing = data.componentId ? b.components[data.componentId] : undefined;
    if (existing) {
      tracked = existing;
      return;
    }

    const id = componentId(
      input.title ?? data.label ?? nodeId,
      Object.keys(b.components),
    );
    const component: Component = {
      id,
      title: input.title ?? data.label?.trim() ?? id,
      nodeId,
      diagramId,
      kind: data.kind,
      owner: input.owner,
      paths: input.paths,
      parentId: input.parentId,
      lifecycle: "active",
      createdAt: now(),
      updatedAt: now(),
    };

    b.components[id] = component;
    data.componentId = id;
    diagram.updatedAt = now();
    tracked = component;
    created = true;
  });

  if (tracked && created) {
    logEvent(root, {
      kind: "component.created",
      componentId: (tracked as Component).id,
      data: { title: (tracked as Component).title, nodeId, diagramId, via: "track" },
    });
  }
  return tracked;
};

/**
 * Stops treating a node as a component, without discarding what it owns.
 *
 * The stamp comes off the node and the component is orphaned rather than
 * deleted, so tasks and commits attributed to it still resolve. Deleting is a
 * separate, explicit act -- see `deleteComponent`.
 */
export const untrackNode = (root: string, id: string): Component | null => {
  requireComponentStore(root);

  let untracked: Component | null = null;
  mutateBundle(root, (b) => {
    const component = b.components[id];
    if (!component) return;

    const diagram = component.diagramId ? b.diagrams[component.diagramId] : undefined;
    const node = diagram?.nodes.find((n) => n.id === component.nodeId);
    if (node && diagram) {
      delete (node.data as { componentId?: string }).componentId;
      diagram.updatedAt = now();
    }

    b.components[id] = { ...component, orphaned: true, nodeId: undefined, updatedAt: now() };
    untracked = b.components[id];
  });

  if (untracked) {
    logEvent(root, { kind: "component.orphaned", componentId: id, data: { via: "untrack" } });
  }
  return untracked;
};

/**
 * Marks a component as having lost its node, without losing the work.
 *
 * The deletion path a canvas edit should take. Tasks, commits and runs still
 * resolve; the component simply reports that nothing draws it any more, and
 * `catalogWarnings` asks somebody to re-attach it.
 */
export const orphanComponent = (root: string, id: string): Component | null => {
  const orphaned = updateComponent(root, id, { orphaned: true, nodeId: undefined });
  if (orphaned) {
    logEvent(root, { kind: "component.orphaned", componentId: id, data: {} });
  }
  return orphaned;
};

/**
 * Removes a component outright.
 *
 * Only ever from an explicit "delete this component" -- never from a canvas
 * edit, which orphans instead. Children are promoted to the deleted component's
 * parent rather than being deleted with it, because a cascade here would take
 * out an entire subtree of somebody's work on one click.
 */
export const deleteComponent = (root: string, id: string): boolean => {
  requireComponentStore(root);

  let removed = false;
  mutateBundle(root, (b) => {
    const current = b.components[id];
    if (!current) return;

    for (const child of Object.values(b.components)) {
      if (child.parentId === id) {
        b.components[child.id] = { ...child, parentId: current.parentId, updatedAt: now() };
      }
    }
    delete b.components[id];
    removed = true;
  });

  return removed;
};

/* ---------------------------------- runs ---------------------------------- */

/**
 * What an agent may do here, and how much of it.
 *
 * Resolved per component rather than per project, because the right answer
 * differs by blast radius: a utility module can take autonomous edits, billing
 * cannot. A component with no policy of its own inherits the project default,
 * and `writeGlobs` falls back to the component's declared paths -- the boundary
 * is the same declaration that drives attribution, so there is exactly one
 * place to say where a component lives.
 */
export const resolvePolicy = (
  root: string,
  componentId?: string,
): Required<Pick<AgentPolicy, "autonomy">> & AgentPolicy => {
  const bundle = usesBundle(root) ? requireBundle(root) : null;
  const agents = bundle?.agents ?? {};
  const specific = componentId ? agents.byComponent?.[componentId] : undefined;
  const component = componentId ? bundle?.components[componentId] : undefined;

  return {
    // `confirm` by default: an agent proposes and a person approves. Defaulting
    // to autonomous would make the safest setting the one nobody chose.
    autonomy: specific?.autonomy ?? agents.default?.autonomy ?? "confirm",
    budget: { ...agents.default?.budget, ...specific?.budget },
    writeGlobs: specific?.writeGlobs ?? agents.default?.writeGlobs ?? component?.paths,
  };
};

/**
 * Sets how much rope agents get in one part of the system.
 *
 * Per component, because that is where blast radius differs. Passing an empty
 * policy removes the entry rather than storing an empty object, so a component
 * that has been returned to the default looks identical to one that never
 * departed from it -- the same reason `setFeatureOverride` deletes a cleared
 * override instead of leaving a husk.
 */
export const setAgentPolicy = (
  root: string,
  componentId: string,
  policy: AgentPolicy | null,
): AgentPolicy | null => {
  requireComponentStore(root);

  mutateBundle(root, (b) => {
    const byComponent = { ...b.agents.byComponent };
    if (!policy || !Object.keys(policy).length) delete byComponent[componentId];
    else byComponent[componentId] = policy;
    b.agents = { ...b.agents, byComponent };
  });

  logEvent(root, {
    kind: "component.updated",
    componentId,
    data: { agentPolicy: policy?.autonomy ?? "default" },
  });
  return policy;
};

/**
 * Records that a feature's declared check was run, and what it said.
 *
 * The output is deliberately not kept -- a failing test run is thousands of
 * lines, the log is committed and pushed, and nobody wants a stack trace in
 * their git history. What is kept is the fact, the exit code and how long it
 * took, which is what a "was this ever actually proven" question needs.
 */
export const recordVerification = (
  root: string,
  featureId: string,
  result: { command: string; ok: boolean; code: number; ms: number },
): void => {
  logEvent(root, {
    kind: "criterion.verified",
    data: {
      featureId,
      command: result.command,
      ok: result.ok,
      code: result.code,
      ms: result.ms,
    },
  });
};

export const readRuns = (root: string): AgentRun[] => runsFrom(readEvents(root));

export const readRun = (root: string, id: string): AgentRun | null =>
  readRuns(root).find((r) => r.id === id) ?? null;

/**
 * The run a harness session belongs to.
 *
 * Hooks fire with a session id and know nothing about runs, so the session is
 * recorded on the run when it starts and looked up here. Only an unfinished run
 * matches: a session id can be reused across a resume, and attributing new work
 * to a merged run would quietly reopen it.
 */
export const runForSession = (root: string, sessionId: string): AgentRun | null =>
  readRuns(root).find(
    (r) =>
      r.sessionId === sessionId && r.state !== "merged" && r.state !== "abandoned",
  ) ?? null;

export type RunInput = {
  taskId?: string;
  componentId?: string;
  /** The harness session, so hooks can find this run again. */
  sessionId?: string;
  actor?: Partial<RunActor>;
  branch?: string;
  worktree?: string;
  /** Overrides the resolved policy. For a caller that knows better, not a default. */
  budget?: AgentPolicy["budget"];
};

/**
 * Opens a run.
 *
 * The component is taken from the task when not given, so an agent picking up a
 * card inherits that part of the system's budget and boundary without being
 * told about either. That is the point: the constraints follow the work rather
 * than having to be restated at every call site.
 */
export const startRun = (root: string, input: RunInput): AgentRun => {
  const task = input.taskId
    ? readTasks(root).tasks.find((t) => t.id === input.taskId)
    : undefined;
  const componentId = input.componentId ?? task?.componentId;
  const policy = resolvePolicy(root, componentId);
  const id = randomUUID().slice(0, 8);

  logEvent(root, {
    kind: "run.started",
    componentId,
    data: {
      runId: id,
      taskId: input.taskId,
      sessionId: input.sessionId,
      actor: { kind: "agent", ...input.actor },
      autonomy: policy.autonomy,
      budget: input.budget ?? policy.budget ?? {},
      writeGlobs: policy.writeGlobs,
      branch: input.branch,
      worktree: input.worktree,
    },
  });

  const run = readRun(root, id);
  if (!run) {
    // The log is the run, so a log that cannot be written is a run that did not
    // start. Saying so beats handing back a run object nothing will remember.
    throw new Error(
      "Could not record the run. The event log is not writable, so nothing would be tracked.",
    );
  }
  return run;
};

/**
 * Records what a run has spent, and says whether it may continue.
 *
 * The verdict is the return value rather than a thrown error because this is
 * called from a hook on every tool use: an exception there would break the
 * agent's session over a budget, which is a worse outcome than telling it to
 * stop. A run that goes over is moved to `blocked`, which is recoverable.
 */
export const reportRun = (
  root: string,
  id: string,
  progress: {
    inputTokens?: number;
    outputTokens?: number;
    toolCalls?: number;
    touched?: string[];
  },
): { run: AgentRun; verdict: BudgetVerdict; refused: string[] } | null => {
  const before = readRun(root, id);
  if (!before) return null;

  // A write outside the boundary is recorded as attempted and reported back,
  // not silently dropped: it usually means the task spans two components, and
  // that is a fact about the architecture worth seeing.
  const refused = (progress.touched ?? []).filter((path) => !mayWrite(before, path));
  const allowed = (progress.touched ?? []).filter((path) => mayWrite(before, path));

  logEvent(root, {
    kind: "run.progress",
    componentId: before.componentId,
    data: {
      runId: id,
      inputTokens: progress.inputTokens ?? 0,
      outputTokens: progress.outputTokens ?? 0,
      toolCalls: progress.toolCalls ?? 0,
      touched: allowed,
      ...(refused.length ? { refused } : {}),
    },
  });

  const run = readRun(root, id)!;
  const verdict = checkBudget(run);

  if (!verdict.ok && run.state === "running") {
    setRunState(root, id, "blocked", `Budget exhausted: ${verdict.detail}`);
    return { run: readRun(root, id)!, verdict, refused };
  }
  return { run, verdict, refused };
};

/**
 * Moves a run along its lifecycle, refusing a transition that is not allowed.
 *
 * The check happens here as well as in the projection. The projection drops an
 * illegal transition so a bad event cannot corrupt the fold; this refuses to
 * write one in the first place, so the log stays a record of what happened
 * rather than a record of what was attempted.
 */
export const setRunState = (
  root: string,
  id: string,
  state: RunState,
  reason?: string,
): AgentRun | null => {
  const run = readRun(root, id);
  if (!run) return null;
  if (!canTransition(run.state, state)) {
    throw new Error(`A ${run.state} run cannot become ${state}.`);
  }

  logEvent(root, {
    kind: "run.state",
    componentId: run.componentId,
    data: { runId: id, state, reason },
  });
  return readRun(root, id);
};

/* --------------------------------- tasks ---------------------------------- */

const legacyReadTasks = (root: string): TasksFile =>
  readJson(projectPaths(root).tasks, emptyTasks());

const legacyWriteTasks = (root: string, tasks: TasksFile) =>
  writeJson(projectPaths(root).tasks, tasks);

export const isTaskStatus = (value: string): value is TaskStatus =>
  (TASK_STATUSES as readonly string[]).includes(value);

export type TaskInput = {
  title: string;
  description?: string;
  status?: TaskStatus;
  nodeIds?: string[];
  /** The component that owns this work; whose board it appears on. */
  componentId?: string;
  diagramId?: string;
  labels?: string[];
  assignee?: string;
  /** The PRD feature this task implements. */
  featureId?: string;
  phaseId?: string;
};

/**
 * Eight hex characters, checked for collisions.
 *
 * The check matters more than the odds suggest: a task id is what a branch name
 * and a commit trailer carry, so two tasks sharing one would attribute the
 * wrong commits to the wrong work, silently.
 */
const taskId = (taken: readonly Task[]): string => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const id = randomUUID().slice(0, 8);
    if (!taken.some((t) => t.id === id)) return id;
  }
  return randomUUID().slice(0, 12);
};

export const createTask = (root: string, input: TaskInput): Task => {
  const status = input.status ?? "backlog";

  const created = mutateTasks(root, (tasks) => {
    const task: Task = {
      id: taskId(tasks),
      title: input.title,
      description: input.description,
      status,
      nodeIds: input.nodeIds,
      componentId: input.componentId,
      diagramId: input.diagramId,
      labels: input.labels,
      assignee: input.assignee,
      featureId: input.featureId,
      phaseId: input.phaseId,
      createdAt: now(),
      updatedAt: now(),
      order: tasks.filter((t) => t.status === status).length,
    };
    tasks.push(task);
    return task;
  });

  if (!created) throw new Error("No project store found");
  logEvent(root, {
    kind: "task.created",
    componentId: created.componentId,
    data: { taskId: created.id, title: created.title, status: created.status },
  });
  return created;
};
export const reorderTask = (
  root: string,
  id: string,
  status: TaskStatus,
  index: number,
): Task | null =>
  mutateTasks(root, (tasks) => {
    const task = tasks.find((t) => t.id === id);
    if (!task) return null;

    const from = task.status;
    task.status = status;
    task.updatedAt = now();

    const column = tasks
      .filter((t) => t.status === status && t.id !== id)
      .sort((a, b) => a.order - b.order);

    column.splice(Math.max(0, Math.min(index, column.length)), 0, task);
    column.forEach((t, i) => (t.order = i));

    if (from !== status) {
      tasks
        .filter((t) => t.status === from)
        .sort((a, b) => a.order - b.order)
        .forEach((t, i) => (t.order = i));
    }

    return task;
  }) ?? null;
export const tasksForFeature = (root: string, featureId: string): Task[] =>
  readTasks(root)
    .tasks.filter((t) => t.featureId === featureId)
    .sort((a, b) => a.order - b.order);

/** Records commits against a task -- the strongest git attribution signal. */
export const recordCommits = (root: string, id: string, shas: string[]): Task | null =>
  mutateTasks(root, (tasks) => {
    const task = tasks.find((t) => t.id === id);
    if (!task) return null;

    const existing = task.commits ?? [];
    task.commits = existing.concat(shas.filter((sha) => !existing.includes(sha)));
    task.updatedAt = now();
    return task;
  }) ?? null;
export const updateTask = (
  root: string,
  id: string,
  patch: Partial<Omit<Task, "id" | "createdAt">>,
): Task | null => {
  const updated =
    mutateTasks(root, (tasks) => {
      const task = tasks.find((t) => t.id === id);
      if (!task) return null;
      Object.assign(task, patch, { updatedAt: now() });
      return task;
    }) ?? null;

  if (updated) {
    logEvent(root, {
      kind: "task.updated",
      componentId: updated.componentId,
      // Which fields moved, not their contents: a description is somebody's
      // prose, and the log is committed and pushed.
      data: { taskId: id, changed: Object.keys(patch) },
    });
  }
  return updated;
};
export const moveTask = (
  root: string,
  id: string,
  status: TaskStatus,
): Task | null => {
  let from: TaskStatus | undefined;

  const moved =
    mutateTasks(root, (tasks) => {
      const task = tasks.find((t) => t.id === id);
      if (!task) return null;

      from = task.status;
      if (task.status !== status) {
        task.order = tasks.filter((t) => t.status === status).length;
        task.status = status;
      }
      task.updatedAt = now();
      return task;
    }) ?? null;

  // Only a real transition is an event. A drag that lands a card back in the
  // column it came from is not something that happened to the work, and every
  // cycle-time measurement downstream would be wrong if it counted.
  if (moved && from !== status) {
    logEvent(root, {
      kind: "task.moved",
      componentId: moved.componentId,
      data: { taskId: id, from, to: status },
    });
  }
  return moved;
};
export const deleteTask = (root: string, id: string): boolean => {
  let removed: Task | undefined;

  const ok =
    mutateTasks(root, (tasks) => {
      const at = tasks.findIndex((t) => t.id === id);
      if (at === -1) return false;
      removed = tasks[at];
      tasks.splice(at, 1);
      return true;
    }) ?? false;

  // The card is gone from the board, but the fact that it existed is not: the
  // log is the only place a deleted task leaves a trace, and "what happened to
  // that ticket" is a question somebody always asks.
  if (ok && removed) {
    logEvent(root, {
      kind: "task.deleted",
      componentId: removed.componentId,
      data: { taskId: id, title: removed.title, status: removed.status },
    });
  }
  return ok;
};
