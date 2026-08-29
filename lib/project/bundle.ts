/**
 * The `.project` file: one project, one file.
 *
 * Everything the tool owns lives here -- diagrams, whiteboards, tasks, phases,
 * feature overrides and git settings -- so a project is a single artifact you
 * can copy, share, back up or delete without hunting for the pieces.
 *
 * Two things are deliberately NOT in it, and the reasons matter:
 *
 *   docs/prd.md   The feature list is a document people read and review. It is
 *                 the one part of a project that belongs in markdown, and
 *                 folding it into a JSON blob would make it uneditable by hand
 *                 and unreadable in a pull request. `.project` records where it
 *                 lives; the document itself stays a document.
 *
 *   the git cache Derived, regenerable, and larger than everything else here
 *                 put together. Bundling a cache into the file that represents
 *                 the project would make the project mostly cache.
 *
 * Writes are a compare-and-swap on a revision counter. With one file, a canvas
 * autosave and a CLI task edit are no longer touching different files, so
 * without this the later writer would silently discard the earlier one.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type {
  DiagramFile, DiagramRef, Feature, FeatureOverride, Phase, Task, WhiteboardFile,
} from "./types";

export const BUNDLE_FILE = ".project";
export const BUNDLE_VERSION = 2;

export type ProjectBundle = {
  version: number;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** Bumped on every write; the basis of the compare-and-swap. */
  revision: number;

  /** Repo-relative path of the PRD. The document stays a document. */
  prdSource: string;

  diagrams: Record<string, DiagramFile>;
  boards: Record<string, WhiteboardFile>;
  tasks: Task[];
  roadmap: {
    phases: Phase[];
    overrides: Record<string, FeatureOverride>;
    orphans: Feature[];
  };
  git: { allowBranchCreate?: boolean };
};

export const bundlePath = (root: string): string => join(root, BUNDLE_FILE);

export const emptyBundle = (name: string): ProjectBundle => ({
  version: BUNDLE_VERSION,
  name,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  revision: 0,
  prdSource: "docs/prd.md",
  diagrams: {},
  boards: {},
  tasks: [],
  roadmap: { phases: [], overrides: {}, orphans: [] },
  git: {},
});

export class BundleConflictError extends Error {}

export const hasBundle = (root: string): boolean => existsSync(bundlePath(root));

export const readBundle = (root: string): ProjectBundle | null => {
  try {
    const parsed = JSON.parse(readFileSync(bundlePath(root), "utf8")) as ProjectBundle;
    if (!parsed || typeof parsed !== "object" || !parsed.diagrams) return null;
    // Older files may predate a field; fill rather than fail.
    return {
      ...emptyBundle(parsed.name ?? "Untitled project"),
      ...parsed,
      roadmap: {
        phases: parsed.roadmap?.phases ?? [],
        overrides: parsed.roadmap?.overrides ?? {},
        orphans: parsed.roadmap?.orphans ?? [],
      },
      git: parsed.git ?? {},
    };
  } catch {
    return null;
  }
};

/**
 * Writes the bundle, refusing if it moved underneath us.
 *
 * `expectedRevision` is what the caller read. If the file on disk has advanced
 * past it, another writer got there first and this write would erase them, so
 * it is rejected and the caller re-reads. Passing `undefined` skips the check,
 * which is only correct when creating the file.
 */
export const writeBundle = (
  root: string,
  bundle: ProjectBundle,
  expectedRevision?: number,
): ProjectBundle => {
  const path = bundlePath(root);

  if (expectedRevision !== undefined) {
    const current = readBundle(root);
    if (current && current.revision !== expectedRevision) {
      throw new BundleConflictError(
        `The project changed on disk (revision ${current.revision}, expected ${expectedRevision}).`,
      );
    }
  }

  const next: ProjectBundle = {
    ...bundle,
    version: BUNDLE_VERSION,
    revision: bundle.revision + 1,
    updatedAt: new Date().toISOString(),
  };

  // Same write-then-rename as everywhere else: a reader never sees half a file.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
  return next;
};

/* --------------------------------- locking -------------------------------- */

const LOCK_SUFFIX = ".lock";
/** A lock older than this is assumed to belong to a process that died. */
const STALE_LOCK_MS = 10_000;
const LOCK_TIMEOUT_MS = 5_000;

/**
 * An exclusive lock around the whole read-modify-write.
 *
 * A revision check alone is not enough across processes. Two writers can both
 * read revision N, both find it matches, and both write N+1 -- the second
 * erasing the first. That is a time-of-check/time-of-use race, and no amount of
 * re-checking inside the same window closes it.
 *
 * `openSync` with `wx` is atomic at the filesystem level: exactly one caller
 * creates the file and everyone else gets EEXIST. That is the primitive this
 * needs, and it works across processes, which an in-memory mutex would not.
 */
const withLock = <T>(root: string, fn: () => T): T => {
  const lock = `${bundlePath(root)}${LOCK_SUFFIX}`;
  const started = Date.now();

  for (;;) {
    try {
      // `wx` fails if the file exists, which is what makes this a lock rather
      // than a write.
      closeSync(openSync(lock, "wx"));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      // A process that crashed mid-write would otherwise wedge the project
      // permanently, so an old lock is broken rather than waited on forever.
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) {
          rmSync(lock, { force: true });
          continue;
        }
      } catch {
        // It disappeared between the check and the stat; try to take it again.
        continue;
      }

      if (Date.now() - started > LOCK_TIMEOUT_MS) {
        throw new BundleConflictError(
          "Timed out waiting for the project lock. Another process may be stuck.",
        );
      }

      // Busy-wait deliberately: these holds are sub-millisecond, and a promise
      // would make every caller async for no benefit.
      const until = Date.now() + 2;
      while (Date.now() < until) {
        /* spin */
      }
    }
  }

  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
};

/**
 * Read, change, write, once and exclusively.
 *
 * Every mutation goes through here, so the lock can never be forgotten and a
 * caller cannot write a bundle it read minutes ago. The change function is
 * given fresh state read inside the lock, which is what makes concurrent edits
 * to different parts of the project compose instead of collide.
 */
export const mutateBundle = (
  root: string,
  change: (bundle: ProjectBundle) => void,
): ProjectBundle | null =>
  withLock(root, () => {
    const bundle = readBundle(root);
    if (!bundle) return null;

    const revision = bundle.revision;
    change(bundle);
    return writeBundle(root, bundle, revision);
  });

/** The diagram index, derived rather than stored, so it cannot drift. */
export const bundleRefs = (bundle: ProjectBundle): DiagramRef[] => [
  ...Object.values(bundle.diagrams).map((d) => ({
    id: d.id,
    title: d.title,
    type: d.type,
    kind: "diagram" as const,
    updatedAt: d.updatedAt,
  })),
  ...Object.values(bundle.boards).map((b) => ({
    id: b.id,
    title: b.title,
    type: "architecture" as const,
    kind: "whiteboard" as const,
    updatedAt: b.updatedAt,
  })),
];

/** Removes the bundle. Used by project deletion. */
export const removeBundle = (root: string): boolean => {
  const path = bundlePath(root);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
};

/* -------------------------------- migration ------------------------------- */

/**
 * Converts a split store into a single `.project` file.
 *
 * Deliberately additive first: the bundle is written, verified by being read
 * back, and only then is the old directory removed. A migration that deletes
 * before it confirms is a migration that can lose a project.
 */
export const migrateToBundle = (
  root: string,
  legacy: {
    name: string;
    createdAt: string;
    prdSource: string;
    diagrams: DiagramFile[];
    boards: WhiteboardFile[];
    tasks: Task[];
    roadmap: { phases: Phase[]; overrides: Record<string, FeatureOverride>; orphans: Feature[] };
  },
): ProjectBundle => {
  const bundle: ProjectBundle = {
    ...emptyBundle(legacy.name),
    createdAt: legacy.createdAt,
    prdSource: legacy.prdSource,
    diagrams: Object.fromEntries(legacy.diagrams.map((d) => [d.id, d])),
    boards: Object.fromEntries(legacy.boards.map((b) => [b.id, b])),
    tasks: legacy.tasks,
    roadmap: legacy.roadmap,
  };

  writeBundle(root, bundle);

  const written = readBundle(root);
  if (
    !written ||
    Object.keys(written.diagrams).length !== legacy.diagrams.length ||
    Object.keys(written.boards).length !== legacy.boards.length ||
    written.tasks.length !== legacy.tasks.length
  ) {
    throw new Error("Migration verification failed; the old store was left in place.");
  }

  return written;
};
