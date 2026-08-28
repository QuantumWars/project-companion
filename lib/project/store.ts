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
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  DEFAULT_STORE_DIR,
  emptyProject,
  emptyTasks,
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
export const findProject = (
  from?: string,
): { root: string; storeDir: string } | null => {
  let dir = resolve(from ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd());

  for (;;) {
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

export const findProjectRoot = (from?: string): string | null =>
  findProject(from)?.root ?? null;

/**
 * Which store directory to create in a repo that has none.
 *
 * If the repo already has an agent directory, the store goes inside it rather
 * than adding another top-level folder.
 */
export const chooseStoreDir = (root: string): string => {
  for (const candidate of STORE_DIRS) {
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
    cache: join(root, base, "cache"),
    gitCache: join(root, base, "cache", "git.json"),
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
  // Reuse an existing store rather than creating a second one: a repo with
  // both `.arch/` and `.claude/` must not end up with two divergent copies of
  // the same project.
  const existing = findProject(root);
  const paths = projectPaths(
    root,
    existing?.root === root ? existing.storeDir : chooseStoreDir(root),
  );

  if (existsSync(paths.project)) {
    return readJson(paths.project, emptyProject(name));
  }

  mkdirSync(paths.diagrams, { recursive: true });
  const project = emptyProject(name);
  writeJson(paths.project, project);
  writeJson(paths.tasks, emptyTasks());
  return project;
};

export const readProject = (root: string): ProjectFile =>
  readJson(projectPaths(root).project, emptyProject("Untitled project"));

const writeProject = (root: string, project: ProjectFile) =>
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

  writeProject(root, project);
};

/* -------------------------------- diagrams -------------------------------- */

export const listDiagrams = (root: string) => readProject(root).diagrams;

export const readDiagram = (root: string, id: string): DiagramFile | null => {
  const path = projectPaths(root).diagram(id);
  return existsSync(path) ? readJson<DiagramFile | null>(path, null) : null;
};

export const writeDiagram = (root: string, diagram: DiagramFile): DiagramFile => {
  const next: DiagramFile = { ...diagram, updatedAt: now() };
  writeJson(projectPaths(root).diagram(next.id), next);
  touchDiagramRef(root, next);
  return next;
};

export const createDiagram = (
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

export const deleteDiagram = (root: string, id: string): boolean => {
  const path = projectPaths(root).diagram(id);
  if (!existsSync(path)) return false;

  rmSync(path);
  const project = readProject(root);
  project.diagrams = project.diagrams.filter((d) => d.id !== id);
  writeProject(root, project);
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

  writeProject(root, project);
  return project.diagrams.length;
};

/* ------------------------------- whiteboards ------------------------------ */

export const readWhiteboard = (
  root: string,
  id: string,
): WhiteboardFile | null => {
  const path = projectPaths(root).board(id);
  return existsSync(path) ? readJson<WhiteboardFile | null>(path, null) : null;
};

export const writeWhiteboard = (
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
  writeProject(root, project);

  return next;
};

export const createWhiteboard = (root: string, title: string): WhiteboardFile => {
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

export const deleteWhiteboard = (root: string, id: string): boolean => {
  const path = projectPaths(root).board(id);
  if (!existsSync(path)) return false;

  rmSync(path);
  const project = readProject(root);
  project.diagrams = project.diagrams.filter((d) => d.id !== id);
  writeProject(root, project);
  return true;
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

/* --------------------------------- tasks ---------------------------------- */

export const readTasks = (root: string): TasksFile =>
  readJson(projectPaths(root).tasks, emptyTasks());

export const writeTasks = (root: string, tasks: TasksFile) =>
  writeJson(projectPaths(root).tasks, tasks);

export const isTaskStatus = (value: string): value is TaskStatus =>
  (TASK_STATUSES as readonly string[]).includes(value);

export type TaskInput = {
  title: string;
  description?: string;
  status?: TaskStatus;
  nodeIds?: string[];
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
  const file = readTasks(root);
  const status = input.status ?? "backlog";

  const task: Task = {
    id: taskId(file.tasks),
    title: input.title,
    description: input.description,
    status,
    nodeIds: input.nodeIds,
    diagramId: input.diagramId,
    labels: input.labels,
    assignee: input.assignee,
    featureId: input.featureId,
    phaseId: input.phaseId,
    createdAt: now(),
    updatedAt: now(),
    order: file.tasks.filter((t) => t.status === status).length,
  };

  file.tasks.push(task);
  writeTasks(root, file);
  return task;
};

/**
 * Moves a task to a position within a column, not just onto the end of it.
 *
 * The board could only ever append before this, so dragging a card between two
 * others had nowhere to record the result. Orders are repacked densely in both
 * the source and target columns so gaps do not accumulate.
 */
export const reorderTask = (
  root: string,
  id: string,
  status: TaskStatus,
  index: number,
): Task | null => {
  const file = readTasks(root);
  const task = file.tasks.find((t) => t.id === id);
  if (!task) return null;

  const from = task.status;
  task.status = status;
  task.updatedAt = now();

  const column = file.tasks
    .filter((t) => t.status === status && t.id !== id)
    .sort((a, b) => a.order - b.order);

  column.splice(Math.max(0, Math.min(index, column.length)), 0, task);
  column.forEach((t, i) => (t.order = i));

  if (from !== status) {
    file.tasks
      .filter((t) => t.status === from)
      .sort((a, b) => a.order - b.order)
      .forEach((t, i) => (t.order = i));
  }

  writeTasks(root, file);
  return task;
};

/** Tasks implementing a given feature, in board order. */
export const tasksForFeature = (root: string, featureId: string): Task[] =>
  readTasks(root)
    .tasks.filter((t) => t.featureId === featureId)
    .sort((a, b) => a.order - b.order);

/** Records commits against a task -- the strongest git attribution signal. */
export const recordCommits = (root: string, id: string, shas: string[]): Task | null => {
  const file = readTasks(root);
  const task = file.tasks.find((t) => t.id === id);
  if (!task) return null;

  const existing = task.commits ?? [];
  task.commits = existing.concat(shas.filter((sha) => !existing.includes(sha)));
  task.updatedAt = now();

  writeTasks(root, file);
  return task;
};

export const updateTask = (
  root: string,
  id: string,
  patch: Partial<Omit<Task, "id" | "createdAt">>,
): Task | null => {
  const file = readTasks(root);
  const task = file.tasks.find((t) => t.id === id);
  if (!task) return null;

  Object.assign(task, patch, { updatedAt: now() });
  writeTasks(root, file);
  return task;
};

export const moveTask = (
  root: string,
  id: string,
  status: TaskStatus,
): Task | null => {
  const file = readTasks(root);
  const task = file.tasks.find((t) => t.id === id);
  if (!task) return null;

  if (task.status !== status) {
    task.order = file.tasks.filter((t) => t.status === status).length;
    task.status = status;
  }
  task.updatedAt = now();

  writeTasks(root, file);
  return task;
};

export const deleteTask = (root: string, id: string): boolean => {
  const file = readTasks(root);
  const next = file.tasks.filter((t) => t.id !== id);
  if (next.length === file.tasks.length) return false;

  writeTasks(root, { ...file, tasks: next });
  return true;
};
