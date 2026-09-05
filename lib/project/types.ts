/**
 * The on-disk project format.
 *
 * This is the contract between the web app and a coding agent. It lives in the
 * repository as plain JSON so that Claude Code and Codex can read and edit it
 * with ordinary file tools, and so that changes show up in a diff and in code
 * review like any other source change. localStorage cannot serve that purpose:
 * an agent runs on the filesystem and cannot see a browser's storage.
 *
 * Layout, rooted at the repository:
 *
 *   .project          diagrams, whiteboards, components, tasks, phases,
 *                     overrides and agent policy -- see `bundle.ts`
 *   .project-log/     the append-only event log, one shard per actor
 *   docs/prd.md       the feature list
 *   .project-cache/   derived data; gitignored, safe to delete
 *
 * Two things deliberately live outside `.project`. The PRD, because a product
 * document belongs in the repository where humans review it rather than inside
 * a JSON blob -- the bundle records only what markdown cannot express. And the
 * cache, because it is regenerable and larger than everything else put together.
 *
 * Some types below still describe the split layout this project used before the
 * single-file format (`.claude/project-companion/*.json`). They are kept because
 * `store.ts` still reads such a project, so somebody who never ran `migrate`
 * keeps working.
 */

import type { ArchEdge, ArchNode, DiagramType, Viewport } from "@/types/arch";
import type { Layer } from "@/types/canvas";

/**
 * Where the store lives, in discovery order.
 *
 * The data sits inside the coding agent's own project directory so the agent
 * finds it without configuration -- `.claude/` is already in Claude Code's
 * working context, `.codex/` in Codex's, and so on. Each gets an `archboard/`
 * subdirectory so nothing collides with the agent's own files (`settings.json`,
 * `agents/`, `skills/`).
 *
 * `.arch/` stays last so projects created before this change keep working.
 */
export const STORE_DIRS = [
  ".claude/project-companion",
  ".codex/project-companion",
  ".cursor/project-companion",
  ".gemini/project-companion",
  // Older names, still discovered so a project created before the rename keeps
  // working untouched. `project-companion move <dir>` relocates one when its
  // owner is ready; nothing forces it.
  ".claude/archboard",
  ".codex/archboard",
  ".cursor/archboard",
  ".gemini/archboard",
  ".arch",
] as const;

/** Store directories kept only for discovery. Never chosen for a new project. */
export const LEGACY_STORE_DIRS: readonly string[] = [
  ".claude/archboard",
  ".codex/archboard",
  ".cursor/archboard",
  ".gemini/archboard",
  ".arch",
];

/** Created by `init` when a repo has no agent directory yet. */
export const DEFAULT_STORE_DIR = STORE_DIRS[0];

export const FORMAT_VERSION = 1;

export type ProjectFile = {
  version: number;
  name: string;
  createdAt: string;
  diagrams: DiagramRef[];
};

/**
 * What kind of document a board is.
 *
 * A whiteboard stores freehand layers, not a node/edge graph, so it gets its
 * own file shape and its own directory. Both are listed in one index so a
 * person -- or an agent calling `list_diagrams` -- sees every board in the
 * project in one place.
 */
export type BoardKind = "diagram" | "whiteboard";

export type DiagramRef = {
  id: string;
  title: string;
  type: DiagramType;
  /** Absent on entries written before whiteboards existed; treat as "diagram". */
  kind?: BoardKind;
  updatedAt: string;
};

export const refKind = (ref: DiagramRef): BoardKind => ref.kind ?? "diagram";

export type DiagramFile = {
  version: number;
  id: string;
  title: string;
  type: DiagramType;
  updatedAt: string;
  nodes: ArchNode[];
  edges: ArchEdge[];
  viewport?: Viewport;
};

/**
 * A freehand whiteboard.
 *
 * Mirrors what the canvas's local room already persists: an ordered list of
 * layer ids (which is the z-order) and the layers themselves. Kept as plain
 * arrays rather than maps so it round-trips through JSON unchanged.
 */
export type WhiteboardFile = {
  version: number;
  id: string;
  title: string;
  updatedAt: string;
  layerIds: string[];
  layers: [string, Layer][];
};

/* ---------------------------------- tasks --------------------------------- */

export const TASK_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "review",
  "done",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export type Task = {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  /**
   * Architecture nodes this task touches. This is the link between "what the
   * system is" and "what is being built" -- an agent working on a service can
   * find its tasks, and a node on the canvas can show its work in flight.
   */
  nodeIds?: string[];
  /**
   * The architecture component this task belongs to.
   *
   * Distinct from `nodeIds`, which lists every node the work touches. This is
   * the one component that OWNS it -- whose board it appears on, whose review
   * gate it passes, and whose owner is accountable for it. A task touching
   * three services still belongs to one team.
   */
  componentId?: string;
  diagramId?: string;
  assignee?: string;
  /** Free-form labels; `agent` marks work an agent picked up. */
  labels?: string[];
  /** The PRD feature this task implements. */
  featureId?: string;
  /** Usually inherited from the feature; set directly for one-off work. */
  phaseId?: string;
  /** Branch opened for this task, e.g. `feat/978ce4d6-refunds`. */
  branch?: string;
  /**
   * Commits explicitly recorded against this task -- the strongest attribution
   * signal, and the only one that is a claim rather than an inference.
   */
  commits?: string[];
  createdAt: string;
  updatedAt: string;
  /** Sort position within its column. */
  order: number;
};

export type TasksFile = {
  version: number;
  tasks: Task[];
};

/* --------------------------------- roadmap -------------------------------- */

/**
 * The roadmap is split in two on purpose.
 *
 * `docs/prd.md` owns the feature list: titles, prose, and acceptance criteria.
 * It is the document people read and review, and an agent edits it with
 * ordinary file tools.
 *
 * The sidecar -- `roadmap` inside `.project`, or `roadmap.json` in a pre-bundle
 * project -- owns only what markdown cannot express: phase dates, the links from
 * a feature to architecture nodes, and status overrides. Status is otherwise
 * DERIVED from the PRD's checkboxes, so an agent that ticks a box has moved the
 * board without touching a second file, and moving a card never rewrites a
 * document humans review.
 */

export const PHASE_STATUSES = ["planned", "active", "done"] as const;

export type PhaseStatus = (typeof PHASE_STATUSES)[number];

/** A phase or sprint: an ordered, optionally time-boxed chunk of development. */
export type Phase = {
  id: string;
  name: string;
  goal?: string;
  status: PhaseStatus;
  /** ISO date, `YYYY-MM-DD`. */
  startsAt?: string;
  endsAt?: string;
  /**
   * Position in the PRD, derived from document order on every sync. Storing it
   * would mean reordering phases in the markdown was silently ignored.
   */
  order: number;
};

export type AcceptanceCriterion = {
  id: string;
  text: string;
  done: boolean;
};

/**
 * Where a feature's id came from.
 *
 * `marker` means the PRD carries `<!-- id: guest-checkout -->` and the id
 * survives any rename. `slug` means it is still derived from the heading text,
 * so renaming the heading would orphan it -- the UI surfaces these so they can
 * be stamped. Markers are backfilled lazily, only on a write that already
 * touches that feature, so reading a PRD never modifies it.
 */
export type FeatureIdSource = "marker" | "slug";

/**
 * One segment of the PRD -- the unit tracked on the board.
 *
 * Assembled from both files: `title`, `summary`, `paths` and `acceptance` are
 * parsed out of the markdown; `phaseId`, `nodeIds` and `statusOverride` come
 * from `roadmap.json`.
 */
export type Feature = {
  id: string;
  idSource: FeatureIdSource;
  title: string;
  summary?: string;
  status: TaskStatus;
  /** Set only when status was pinned by hand; otherwise status is derived. */
  statusOverride?: TaskStatus;
  phaseId?: string;
  order: number;
  /** Architecture nodes this feature touches. */
  nodeIds?: string[];
  diagramId?: string;
  /**
   * Globs naming the source this feature owns, used as the weakest git
   * attribution signal. Never promotes a commit to a task -- path overlap is a
   * guess, and a task is a specific claim.
   */
  paths?: string[];
  /**
   * A command that proves this feature works, from the PRD's `Verify:` line.
   *
   * What makes a ticked box mean something once agents are doing the ticking:
   * a criterion whose check fails is unticked, so `done` is a state the
   * repository agreed to rather than one somebody asserted.
   */
  verify?: string;
  acceptance: AcceptanceCriterion[];
  /**
   * The heading vanished from the PRD but tasks still point here. Never
   * deleted automatically: losing a link is recoverable, silently rebinding
   * work to the wrong feature is not.
   */
  orphaned?: boolean;
  createdAt: string;
  updatedAt: string;
};

/**
 * Per-feature state that markdown cannot carry. Keyed by feature id.
 *
 * Absent for most features -- a feature whose status is simply derived from its
 * checkboxes needs no entry at all.
 */
export type FeatureOverride = {
  statusOverride?: TaskStatus;
  phaseId?: string;
  nodeIds?: string[];
  diagramId?: string;
  assignee?: string;
  /** When the override was set, so a stale pin can be spotted. */
  updatedAt: string;
};

export type RoadmapFile = {
  version: number;
  /** Repo-relative path of the PRD, e.g. `docs/prd.md`. */
  source: string;
  /**
   * sha256 of the PRD's raw BYTES at the last sync.
   *
   * Bytes, not the parsed model -- the opposite of the diagram fingerprint,
   * which hashes the model because whitespace there is meaningless. Here
   * whitespace moves every anchor, so it has to be inside the guard.
   */
  sourceHash?: string;
  phases: Phase[];
  overrides: Record<string, FeatureOverride>;
  /**
   * Features whose heading is gone from the PRD, retained so their tasks keep
   * resolving. Live features are always read from the markdown.
   */
  orphans: Feature[];
};

export const DEFAULT_PRD_PATH = "docs/prd.md";

export const emptyRoadmap = (source = DEFAULT_PRD_PATH): RoadmapFile => ({
  version: FORMAT_VERSION,
  source,
  phases: [],
  overrides: {},
  orphans: [],
});

/* -------------------------------- factories ------------------------------- */

export const emptyProject = (name: string): ProjectFile => ({
  version: FORMAT_VERSION,
  name,
  createdAt: new Date().toISOString(),
  diagrams: [],
});

export const emptyTasks = (): TasksFile => ({
  version: FORMAT_VERSION,
  tasks: [],
});
