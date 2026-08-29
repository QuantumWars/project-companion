/**
 * The roadmap: the PRD and its sidecar, assembled.
 *
 * Two files, each owning what it is good at.
 *
 *   docs/prd.md      titles, prose, acceptance criteria -- the document people
 *                    review, and the one an agent edits with ordinary tools
 *   roadmap.json     phase dates, links to architecture nodes, status pins --
 *                    everything markdown cannot say
 *
 * Status is DERIVED from the PRD's checkboxes rather than stored, so ticking a
 * box moves the board and moving the board does not rewrite the document. Only
 * a state markdown cannot express -- `review`, an explicit `backlog`, an
 * assignee -- becomes a stored override.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  applyOps,
  hashSource,
  parsePrd,
  type ParsedFeature,
  type ParsedPhase,
  type PrdOp,
} from "./prd";
import { mutateBundle, readBundle } from "./bundle";
import { readJson, projectPaths, writeJson } from "./store";
import {
  DEFAULT_PRD_PATH,
  emptyRoadmap,
  type Feature,
  type FeatureOverride,
  type Phase,
  type RoadmapFile,
  type TaskStatus,
} from "./types";

export type Roadmap = {
  /** Whether `docs/prd.md` exists yet. */
  present: boolean;
  /** Repo-relative path of the PRD. */
  source: string;
  /** sha256 of the PRD's raw bytes; the guard for every write. */
  sourceHash: string;
  title?: string;
  phases: Phase[];
  features: Feature[];
  /** Features whose heading is gone but whose tasks still point at them. */
  orphans: Feature[];
  warnings: string[];
};

export class RoadmapConflictError extends Error {
  constructor(
    message: string,
    readonly sourceHash: string,
  ) {
    super(message);
  }
}

/* --------------------------------- reading -------------------------------- */

/**
 * Phases, overrides and orphans.
 *
 * These live inside `.project` for a bundled project and in `roadmap.json` for
 * the older layout. The shape is identical either way, so nothing above this
 * function needs to know which it is reading.
 */
const readSidecar = (root: string): RoadmapFile => {
  const bundle = readBundle(root);
  if (bundle) {
    return {
      version: bundle.version,
      source: bundle.prdSource,
      phases: bundle.roadmap.phases,
      overrides: bundle.roadmap.overrides,
      orphans: bundle.roadmap.orphans,
    };
  }
  return readJson<RoadmapFile | null>(projectPaths(root).roadmap, null) ?? emptyRoadmap();
};

const readPrdText = (root: string, source: string): string | null => {
  const path = projectPaths(root).prd(source);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/**
 * Status from the acceptance criteria, unless it was pinned by hand.
 *
 * All checked means done, some means in progress, none means todo. A feature
 * with no criteria at all has nothing to derive from, so it sits in `todo`
 * until someone says otherwise.
 */
export const deriveStatus = (
  acceptance: { done: boolean }[],
  override?: TaskStatus,
): TaskStatus => {
  if (override) return override;
  if (!acceptance.length) return "todo";
  const done = acceptance.filter((c) => c.done).length;
  if (done === acceptance.length) return "done";
  return done > 0 ? "in_progress" : "todo";
};

const toPhase = (parsed: ParsedPhase, stored?: Phase): Phase => ({
  id: parsed.id,
  name: parsed.name,
  goal: parsed.goal,
  status: stored?.status ?? "planned",
  startsAt: stored?.startsAt,
  endsAt: stored?.endsAt,
  // Derived from document position on every read: storing it would mean
  // reordering phases in the PRD was silently ignored.
  order: parsed.order,
});

const toFeature = (
  parsed: ParsedFeature,
  override: FeatureOverride | undefined,
  timestamps: { createdAt: string; updatedAt: string },
): Feature => ({
  id: parsed.id,
  idSource: parsed.idSource,
  title: parsed.title,
  summary: parsed.summary,
  status: deriveStatus(parsed.acceptance, override?.statusOverride),
  statusOverride: override?.statusOverride,
  phaseId: override?.phaseId ?? parsed.phaseId,
  order: parsed.order,
  nodeIds: override?.nodeIds,
  diagramId: override?.diagramId,
  paths: parsed.paths,
  acceptance: parsed.acceptance.map((c) => ({ id: c.id, text: c.text, done: c.done })),
  createdAt: timestamps.createdAt,
  updatedAt: timestamps.updatedAt,
});

export const readRoadmap = (root: string): Roadmap => {
  const sidecar = readSidecar(root);
  const source = sidecar.source || DEFAULT_PRD_PATH;
  const text = readPrdText(root, source);

  if (text === null) {
    return {
      present: false,
      source,
      sourceHash: "",
      phases: [],
      features: [],
      orphans: sidecar.orphans ?? [],
      warnings: [`No PRD at ${source}. Run \`project-companion prd init\` to create one.`],
    };
  }

  const parsed = parsePrd(text);
  const storedPhases = new Map((sidecar.phases ?? []).map((p) => [p.id, p]));
  const stamp = new Date().toISOString();

  const features = parsed.features.map((f) =>
    toFeature(f, sidecar.overrides?.[f.id], { createdAt: stamp, updatedAt: stamp }),
  );

  // A heading that vanished never deletes anything. The feature moves to the
  // orphan tray with its links intact, because losing a link is recoverable and
  // silently rebinding work to the wrong feature is not.
  const live = features.map((f) => f.id);
  const orphans = (sidecar.orphans ?? []).filter((o) => !live.includes(o.id));

  return {
    present: true,
    source,
    sourceHash: hashSource(text),
    title: parsed.title,
    phases: parsed.phases.map((p) => toPhase(p, storedPhases.get(p.id))),
    features,
    orphans: orphans.map((o) => ({ ...o, orphaned: true })),
    warnings: parsed.warnings,
  };
};

/* --------------------------------- writing -------------------------------- */

/**
 * Applies edits to the PRD under a compare-and-swap on the file's hash.
 *
 * `baseHash` is what the caller last saw. If the file has moved on since --
 * because an agent edited it in the terminal -- the write is refused and the
 * caller is handed the current state to re-apply against. There is deliberately
 * no `await` between the hash check and the rename.
 */
export const editPrd = (root: string, baseHash: string | undefined, ops: PrdOp[]): Roadmap => {
  const sidecar = readSidecar(root);
  const source = sidecar.source || DEFAULT_PRD_PATH;
  const text = readPrdText(root, source);

  if (text === null) {
    throw new RoadmapConflictError(`No PRD at ${source}.`, "");
  }

  const current = hashSource(text);
  if (baseHash && baseHash !== current) {
    throw new RoadmapConflictError(
      "The PRD changed on disk since you last read it.",
      current,
    );
  }

  const next = applyOps(text, ops);
  if (next !== text) {
    writeText(projectPaths(root).prd(source), next);
  }

  const roadmap = readRoadmap(root);
  writeSidecar(root, { ...sidecar, source, sourceHash: roadmap.sourceHash });
  return roadmap;
};

/** Write-then-rename, matching how every other file in the store is written. */
const writeText = (path: string, value: string) => {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, value, "utf8");
  renameSync(tmp, path);
};

const writeSidecar = (root: string, file: RoadmapFile) => {
  if (
    mutateBundle(root, (b) => {
      b.prdSource = file.source || b.prdSource;
      b.roadmap.phases = file.phases;
      b.roadmap.overrides = file.overrides;
      b.roadmap.orphans = file.orphans;
    })
  ) {
    return;
  }
  writeJson(projectPaths(root).roadmap, file);
};

/* -------------------------------- overrides ------------------------------- */

/**
 * Pins state that markdown cannot express.
 *
 * Passing `statusOverride: undefined` clears the pin and returns the feature to
 * deriving its status from its checkboxes.
 */
export const setFeatureOverride = (
  root: string,
  featureId: string,
  patch: Partial<Omit<FeatureOverride, "updatedAt">>,
): Feature | null => {
  const sidecar = readSidecar(root);
  const overrides = { ...(sidecar.overrides ?? {}) };
  const existing = overrides[featureId];

  const next: FeatureOverride = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString(),
  };

  // An override with nothing left in it is removed rather than left as a husk,
  // so `roadmap.json` stays a record of deliberate decisions.
  const meaningful =
    next.statusOverride !== undefined ||
    next.phaseId !== undefined ||
    next.assignee !== undefined ||
    next.diagramId !== undefined ||
    (next.nodeIds?.length ?? 0) > 0;

  if (meaningful) overrides[featureId] = next;
  else delete overrides[featureId];

  writeSidecar(root, { ...sidecar, overrides });
  return readRoadmap(root).features.find((f) => f.id === featureId) ?? null;
};

export const setPhase = (root: string, phase: Partial<Phase> & { id: string }): Phase | null => {
  const sidecar = readSidecar(root);
  const phases = [...(sidecar.phases ?? [])];
  const index = phases.findIndex((p) => p.id === phase.id);

  if (index === -1) {
    phases.push({
      id: phase.id,
      name: phase.name ?? phase.id,
      status: phase.status ?? "planned",
      goal: phase.goal,
      startsAt: phase.startsAt,
      endsAt: phase.endsAt,
      order: phases.length,
    });
  } else {
    phases[index] = { ...phases[index], ...phase };
  }

  writeSidecar(root, { ...sidecar, phases });
  return readRoadmap(root).phases.find((p) => p.id === phase.id) ?? null;
};

/** Points the project at a different PRD file. */
export const setPrdSource = (root: string, source: string): Roadmap => {
  writeSidecar(root, { ...readSidecar(root), source });
  return readRoadmap(root);
};
