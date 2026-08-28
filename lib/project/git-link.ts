/**
 * Attributing commits to features and tasks.
 *
 * Four signals, strongest first:
 *
 *   1. `task.commits[]`      recorded explicitly by the CLI or MCP
 *   2. a message trailer     `archboard: 978ce4d6`
 *   3. the branch name       `feat/978ce4d6-refunds`
 *   4. path overlap          against a feature's declared `paths` globs
 *
 * The ordering is not arbitrary. The first three are claims somebody made; the
 * fourth is an inference. So path overlap attributes to a FEATURE and never to
 * a task -- a feature is a region of the codebase, which paths can reasonably
 * describe, whereas a task is a specific piece of work, and guessing which one
 * a commit belongs to would put false evidence next to somebody's name.
 */

import { readCommits, readBranches, repoFingerprint, type GitCommit } from "./git";
import type { Feature, Task } from "./types";

export type AttributionSignal = "recorded" | "trailer" | "branch" | "paths";

export type Attribution = {
  sha: string;
  taskId?: string;
  featureId?: string;
  signal: AttributionSignal;
};

export type LinkedCommit = GitCommit & {
  taskId?: string;
  featureId?: string;
  signal?: AttributionSignal;
};

export type AttributionResult = {
  commits: LinkedCommit[];
  byTask: Record<string, LinkedCommit[]>;
  byFeature: Record<string, LinkedCommit[]>;
  unattributed: LinkedCommit[];
  /** Keys the cache; changes whenever the repository moves. */
  fingerprint: string;
};

/**
 * `archboard: <id>` on its own line is the documented convention, and the one
 * `SKILL.md` teaches. The bracketed forms are accepted because people type them
 * out of habit from other trackers.
 */
const TRAILER = /(?:^|\n)\s*archboard[:\s]+([0-9a-f]{8,12})\b/i;
const INLINE = /\[(?:#|archboard[:\s]*)([0-9a-f]{8,12})\]/i;

/** An id embedded in a branch name, delimited by a slash, dash or underscore. */
const idInBranch = (branch: string, ids: readonly string[]): string | undefined =>
  ids.find((id) => new RegExp(`(^|[/_-])${id}([/_-]|$)`).test(branch));

/* ---------------------------------- globs --------------------------------- */

/**
 * Compiles a glob to a RegExp. Two wildcards is the whole grammar, which is not
 * worth a dependency.
 *
 * `**` crosses directory separators, `*` does not -- the distinction that makes
 * `app/*.ts` mean something different from `app/**\/*.ts`.
 */
export const globToRegExp = (glob: string): RegExp => {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // A trailing `/**` should also match the directory itself.
        out += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
        i += glob[i + 2] === "/" ? 2 : 1;
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (c === "?") {
      out += "[^/]";
      continue;
    }
    out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
};

export const matchesAny = (path: string, globs: readonly string[]): boolean =>
  globs.some((g) => globToRegExp(g).test(path));

/* ------------------------------- attribution ------------------------------ */

export const attribute = (
  commits: GitCommit[],
  tasks: readonly Task[],
  features: readonly Feature[],
  branchesByCommit: Map<string, string[]>,
): Omit<AttributionResult, "fingerprint"> => {
  const taskIds = tasks.map((t) => t.id);
  const featureIds = features.map((f) => f.id);

  const recorded = new Map<string, string>();
  for (const task of tasks) {
    for (const sha of task.commits ?? []) recorded.set(sha, task.id);
  }

  const featureOfTask = new Map(tasks.map((t) => [t.id, t.featureId]));
  const withPaths = features.filter((f) => (f.paths?.length ?? 0) > 0);

  const linked: LinkedCommit[] = commits.map((commit) => {
    // 1. Recorded. Matched on both the full sha and the abbreviation, because a
    // caller passing `HEAD` gets the full one back while a human types the short.
    const byRecord = recorded.get(commit.sha) ?? recorded.get(commit.short);
    if (byRecord) {
      return { ...commit, taskId: byRecord, featureId: featureOfTask.get(byRecord), signal: "recorded" };
    }

    // 2. Trailer.
    const message = `${commit.subject}\n${commit.body}`;
    const trailer = TRAILER.exec(message)?.[1] ?? INLINE.exec(message)?.[1];
    if (trailer) {
      const id = trailer.toLowerCase();
      const task = taskIds.find((t) => t === id || id.startsWith(t));
      if (task) return { ...commit, taskId: task, featureId: featureOfTask.get(task), signal: "trailer" };
      const feature = featureIds.find((f) => f === id);
      if (feature) return { ...commit, featureId: feature, signal: "trailer" };
    }

    // 3. Branch name.
    for (const branch of branchesByCommit.get(commit.sha) ?? []) {
      const task = idInBranch(branch, taskIds);
      if (task) return { ...commit, taskId: task, featureId: featureOfTask.get(task), signal: "branch" };
      const feature = idInBranch(branch, featureIds);
      if (feature) return { ...commit, featureId: feature, signal: "branch" };
    }

    // 4. Path overlap. Feature level only, and only when exactly one feature
    // claims the commit -- an ambiguous match is no match, because presenting a
    // guess as evidence is worse than presenting nothing.
    const claiming = withPaths.filter((f) => commit.paths.some((p) => matchesAny(p, f.paths!)));
    if (claiming.length === 1) {
      return { ...commit, featureId: claiming[0].id, signal: "paths" };
    }

    return { ...commit };
  });

  const byTask: Record<string, LinkedCommit[]> = {};
  const byFeature: Record<string, LinkedCommit[]> = {};
  const unattributed: LinkedCommit[] = [];

  for (const commit of linked) {
    if (commit.taskId) (byTask[commit.taskId] ??= []).push(commit);
    if (commit.featureId) (byFeature[commit.featureId] ??= []).push(commit);
    if (!commit.taskId && !commit.featureId) unattributed.push(commit);
  }

  return { commits: linked, byTask, byFeature, unattributed };
};

/**
 * Which branch each commit actually belongs to.
 *
 * The subtlety that matters: a branch *contains* its whole ancestry, so asking
 * "which branches contain this commit" attributes the entire history to
 * whichever task branch was cut from it. The first commit of a repository would
 * be credited to the newest feature.
 *
 * So a branch claims only the commits it INTRODUCED -- those not reachable from
 * any other branch. `git log <branch> --not <every other branch>` is one
 * process per branch and gives exactly that.
 */
export const branchMembership = async (
  root: string,
  limit: number,
): Promise<Map<string, string[]>> => {
  const branches = await readBranches(root);
  const membership = new Map<string, string[]>();

  for (const branch of branches) {
    const others = branches.filter((b) => b.name !== branch.name).map((b) => b.name);
    const commits = await readCommits(root, {
      ref: branch.name,
      notRefs: others,
      limit,
    });
    for (const commit of commits) {
      const list = membership.get(commit.sha) ?? [];
      list.push(branch.name);
      membership.set(commit.sha, list);
    }
  }

  return membership;
};

export const linkRepository = async (
  root: string,
  tasks: readonly Task[],
  features: readonly Feature[],
  limit = 200,
): Promise<AttributionResult> => {
  const [commits, membership, fingerprint] = await Promise.all([
    // Every branch, not just the one checked out -- work in progress on a
    // feature branch is exactly what the board wants to show.
    readCommits(root, { limit, all: true }),
    branchMembership(root, limit),
    repoFingerprint(root),
  ]);

  return { ...attribute(commits, tasks, features, membership), fingerprint };
};
