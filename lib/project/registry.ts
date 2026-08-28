/**
 * Global index of every project on this machine.
 *
 * Project data lives inside each repository's agent directory, which makes it
 * portable and reviewable but leaves nothing to answer "what projects exist?".
 * This index does: a single file recording each project's path so the app can
 * list them, switch between them, and an agent in one repository can find
 * another.
 *
 * It is a cache, never the truth. The per-project files are authoritative;
 * every read prunes entries whose store has since disappeared, so a deleted or
 * moved repository falls out on its own.
 *
 * The index also acts as an **allowlist**: the HTTP API will only read a root
 * that appears here, so a crafted `?root=` cannot reach arbitrary paths on
 * disk.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { STORE_DIRS } from "./types";
import { findProject, listDiagrams, readProject, readTasks } from "./store";

/**
 * Canonical form of a project path.
 *
 * `/tmp` and `/var` are symlinks on macOS, and a user may well open a project
 * through a symlinked checkout. Without this the same project registers under
 * two paths -- which means duplicate entries, and an allowlist check that
 * fails for a project that is genuinely indexed.
 */
const canonical = (path: string): string => {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
};

export type RegisteredProject = {
  path: string;
  name: string;
  storeDir: string;
  lastOpened: string;
  diagrams: number;
  tasks: number;
};

type IndexFile = {
  version: number;
  projects: RegisteredProject[];
};

const INDEX_VERSION = 1;

/**
 * Mirrors the per-project convention: the index sits in whichever agent
 * directory the user already has in their home, defaulting to `~/.claude`.
 */
export const globalIndexPath = (): string => {
  const home = homedir();

  for (const candidate of STORE_DIRS) {
    const agentDir = candidate.split("/")[0];
    if (agentDir !== ".arch" && existsSync(join(home, agentDir))) {
      return join(home, agentDir, "project-companion", "index.json");
    }
  }

  return join(home, ".claude", "project-companion", "index.json");
};

/**
 * Where the index lived before the rename.
 *
 * Read as a fallback so a machine that already knows about several projects
 * does not silently forget them all. The index is a cache and rebuilds itself
 * as projects are touched, but losing it means the dashboard goes blank and
 * `?root=` stops resolving until every project is visited again.
 */
const legacyIndexPath = (): string => {
  const home = homedir();

  for (const candidate of STORE_DIRS) {
    const agentDir = candidate.split("/")[0];
    if (agentDir !== ".arch" && existsSync(join(home, agentDir))) {
      return join(home, agentDir, "archboard", "index.json");
    }
  }

  return join(home, ".claude", "archboard", "index.json");
};

const parseIndex = (path: string): IndexFile | null => {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as IndexFile;
    return Array.isArray(parsed?.projects) ? parsed : null;
  } catch {
    return null;
  }
};

const readIndex = (): IndexFile =>
  parseIndex(globalIndexPath()) ??
  parseIndex(legacyIndexPath()) ?? { version: INDEX_VERSION, projects: [] };

const writeIndex = (index: IndexFile) => {
  const path = globalIndexPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(index, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
  } catch {
    // A machine-level cache is not worth failing a command over.
  }
};

/** Counts come from the project's own files, so the index never goes stale. */
const describe = (root: string, storeDir: string): RegisteredProject => ({
  path: root,
  name: readProject(root).name,
  storeDir,
  lastOpened: new Date().toISOString(),
  diagrams: listDiagrams(root).length,
  tasks: readTasks(root).tasks.length,
});

/** Records a project, or refreshes what is already recorded. */
export const registerProject = (root: string): RegisteredProject | null => {
  const found = findProject(root);
  if (!found || canonical(found.root) !== canonical(root)) return null;

  const entry = {
    ...describe(found.root, found.storeDir),
    path: canonical(found.root),
  };
  const index = readIndex();

  writeIndex({
    version: INDEX_VERSION,
    projects: [
      entry,
      ...index.projects.filter((p) => p.path !== entry.path),
    ],
  });

  return entry;
};

/** Every known project, most recently opened first, minus any that vanished. */
export const listProjects = (): RegisteredProject[] => {
  const index = readIndex();

  const alive = index.projects.filter((p) =>
    existsSync(join(p.path, p.storeDir, "project.json")),
  );

  if (alive.length !== index.projects.length) {
    writeIndex({ version: INDEX_VERSION, projects: alive });
  }

  return alive;
};

export const forgetProject = (path: string): boolean => {
  const index = readIndex();
  const target = canonical(path);
  const next = index.projects.filter((p) => canonical(p.path) !== target);
  if (next.length === index.projects.length) return false;

  writeIndex({ version: INDEX_VERSION, projects: next });
  return true;
};

/**
 * Whether a root may be served over HTTP.
 *
 * Only registered projects qualify: without this a crafted `?root=` could ask
 * the API to read any directory the server process can reach.
 */
export const isKnownProject = (root: string): boolean => {
  const target = canonical(root);
  return listProjects().some((p) => canonical(p.path) === target);
};
