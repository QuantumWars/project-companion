/**
 * The repository as the board sees it, with a cache in front.
 *
 * Attribution walks every branch's history, which is fast but not free, and the
 * answer only changes when the repository does. The cache is keyed on a
 * fingerprint of HEAD plus every branch tip, so it invalidates itself on any
 * commit, branch, or checkout.
 *
 * It is a cache and never a source of truth: deleting `cache/git.json` must
 * change nothing except how long the next request takes. That property is what
 * makes it safe to gitignore.
 */

import {
  gitRoot,
  readBranches,
  readStatus,
  readTags,
  readWorktrees,
  repoFingerprint,
} from "./git";
import { linkRepository, type AttributionResult } from "./git-link";
import { readJson, projectPaths, readRuns, readTasks, writeJson } from "./store";
import type { Feature } from "./types";

export type GitView = {
  available: boolean;
  /** Absent when the project is not inside a repository at all. */
  root?: string;
  reason?: string;
  status?: Awaited<ReturnType<typeof readStatus>>;
  branches?: Awaited<ReturnType<typeof readBranches>>;
  worktrees?: Awaited<ReturnType<typeof readWorktrees>>;
  tags?: Awaited<ReturnType<typeof readTags>>;
  attribution?: AttributionResult;
};

type CacheFile = { fingerprint: string; attribution: AttributionResult };

/**
 * Turns over whenever a run could change an answer.
 *
 * Count, plus the newest update stamp: a new run, a file added to one, or a run
 * ending all move it. Cheap, and it does not need to be a hash of everything --
 * a cache key only has to change when the answer might.
 */
const runFingerprint = (runs: readonly { updatedAt: string }[]): string =>
  `${runs.length}:${runs.map((r) => r.updatedAt).sort().at(-1) ?? "none"}`;

export const readGitView = async (
  root: string,
  features: readonly Feature[],
  options: { limit?: number; refresh?: boolean } = {},
): Promise<GitView> => {
  const repo = await gitRoot(root);
  if (!repo) {
    return {
      available: false,
      reason: "This project is not inside a git repository.",
    };
  }

  try {
    const [status, branches, worktrees, tags, fingerprint] = await Promise.all([
      readStatus(repo),
      readBranches(repo),
      readWorktrees(repo),
      readTags(repo),
      repoFingerprint(repo),
    ]);

    const cachePath = projectPaths(root).gitCache;
    const cached = options.refresh ? null : readJson<CacheFile | null>(cachePath, null);

    // Runs are an attribution input that changes without the repository
    // changing: an agent edits for ten minutes and the heads are identical
    // throughout. Keying only on the repo would serve an attribution computed
    // before any of that was known, so the run state is part of the key.
    const runs = readRuns(root);
    const key = `${fingerprint}:${runFingerprint(runs)}`;

    let attribution: AttributionResult;
    if (cached && cached.fingerprint === key) {
      attribution = cached.attribution;
    } else {
      const tasks = readTasks(root).tasks;
      attribution = await linkRepository(repo, tasks, features, options.limit, runs);
      writeJson(cachePath, { fingerprint: key, attribution } satisfies CacheFile);
    }

    return { available: true, root: repo, status, branches, worktrees, tags, attribution };
  } catch (error) {
    // A repository that exists but cannot be read is still a degraded state,
    // not a broken page.
    return {
      available: false,
      root: repo,
      reason: error instanceof Error ? error.message : "Could not read the repository.",
    };
  }
};
