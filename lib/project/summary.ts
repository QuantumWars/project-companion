/**
 * A read-only digest of a project, for the launcher.
 *
 * The registry stores only what it needs to find a project again -- a path, a
 * name, two counts. The launcher wants to describe it: how much of each kind of
 * data it holds, how far along the roadmap is, whether the working tree is
 * dirty. That is more expensive to compute, so it lives here rather than being
 * written into the index, where it would go stale the moment anything changed.
 *
 * Every field degrades on its own. A project whose store has been deleted, or
 * which is not in a git repository, still produces a usable row.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { BUNDLE_FILE } from "./bundle";

import { gitRoot, readStatus } from "./git";
import { readRoadmap } from "./roadmap";
import { listDiagrams, projectPaths, readTasks } from "./store";
import { refKind, TASK_STATUSES, type TaskStatus } from "./types";
import type { DiagramType } from "@/types/arch";

export type ProjectSummary = {
  path: string;
  name: string;
  storeDir: string;
  lastOpened: string;
  /** False when the store has been moved or deleted since it was indexed. */
  present: boolean;

  /** Diagram counts by type, so a project can say what KIND of thing it holds. */
  diagrams: { total: number; byType: Partial<Record<DiagramType, number>> };
  whiteboards: number;

  tasks: { total: number; byStatus: Record<TaskStatus, number> };
  features: { total: number; done: number; phases: number };

  git?: { branch?: string; ahead: number; behind: number; dirty: number };
};

const emptyByStatus = (): Record<TaskStatus, number> =>
  Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;

export const summariseProject = async (
  root: string,
  meta: { name: string; storeDir: string; lastOpened: string },
): Promise<ProjectSummary> => {
  const base: ProjectSummary = {
    path: root,
    name: meta.name,
    storeDir: meta.storeDir,
    lastOpened: meta.lastOpened,
    // Either shape counts as present. Checking only for the split layout's
    // `project.json` reported every migrated project as missing.
    present:
      meta.storeDir === BUNDLE_FILE
        ? existsSync(join(root, BUNDLE_FILE))
        : existsSync(projectPaths(root, meta.storeDir).project),
    diagrams: { total: 0, byType: {} },
    whiteboards: 0,
    tasks: { total: 0, byStatus: emptyByStatus() },
    features: { total: 0, done: 0, phases: 0 },
  };

  if (!base.present) return base;

  try {
    for (const ref of listDiagrams(root)) {
      if (refKind(ref) === "whiteboard") {
        base.whiteboards++;
        continue;
      }
      base.diagrams.total++;
      base.diagrams.byType[ref.type] = (base.diagrams.byType[ref.type] ?? 0) + 1;
    }

    const tasks = readTasks(root).tasks;
    base.tasks.total = tasks.length;
    for (const task of tasks) base.tasks.byStatus[task.status]++;

    const roadmap = readRoadmap(root);
    base.features = {
      total: roadmap.features.length,
      done: roadmap.features.filter((f) => f.status === "done").length,
      phases: roadmap.phases.length,
    };
  } catch {
    // A malformed store should still list; it just describes itself as empty.
  }

  try {
    const repo = await gitRoot(root);
    if (repo) {
      const status = await readStatus(repo);
      base.git = {
        branch: status.branch,
        ahead: status.ahead,
        behind: status.behind,
        dirty: status.dirty,
      };
    }
  } catch {
    // Not being in a repository is a normal state, not an error.
  }

  return base;
};
