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
import { readJson, projectPaths, readTasks, writeJson } from "./store";
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

    let attribution: AttributionResult;
    if (cached && cached.fingerprint === fingerprint) {
      attribution = cached.attribution;
    } else {
      const tasks = readTasks(root).tasks;
      attribution = await linkRepository(repo, tasks, features, options.limit);
      writeJson(cachePath, { fingerprint, attribution } satisfies CacheFile);
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
