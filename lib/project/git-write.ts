/**
 * The only two ways archboard may change a repository.
 *
 * There is no `commit`, no `push`, no `checkout`, no `reset`, no `clean` --
 * not gated behind a flag, simply absent. A tool that watches your work should
 * not be able to rewrite it, and the cheapest way to guarantee that is to have
 * no function that can express it.
 *
 * Both operations are additive and reversible: a branch that is never checked
 * out changes nothing about your working tree, and a worktree is a directory
 * you can delete.
 */

import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

import { assertRef, GitError, readBranches, readWorktrees } from "./git";

const run = promisify(execFile);

const git = async (cwd: string, args: string[]): Promise<string> => {
  try {
    const { stdout } = await run("git", args, { cwd, timeout: 10_000, windowsHide: true });
    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string })?.stderr;
    const message =
      typeof stderr === "string" && stderr.trim()
        ? stderr.trim()
        : error instanceof Error
          ? error.message
          : String(error);
    throw new GitError(message.split("\n")[0]);
  }
};

/**
 * `feat/<taskId>-<slug>`.
 *
 * The id in the name is not decoration: it is what lets every commit on this
 * branch be attributed back to the task with no further discipline from
 * whoever is working on it.
 */
export const branchNameFor = (taskId: string, title: string): string => {
  const slug = title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug ? `feat/${taskId}-${slug}` : `feat/${taskId}`;
};

/** Git's own opinion of whether a name is legal, rather than a guess at it. */
export const isValidBranchName = async (root: string, name: string): Promise<boolean> => {
  try {
    assertRef(name);
    await git(root, ["check-ref-format", "--branch", name]);
    return true;
  } catch {
    return false;
  }
};

export type BranchResult = { branch: string; created: boolean; head: string };

/**
 * Creates a branch. Never checks it out.
 *
 * Not checking out is what makes this safe to call while someone has
 * uncommitted work: their working tree is untouched, and they switch to the
 * branch when they are ready.
 */
export const createBranch = async (
  root: string,
  name: string,
  options: { from?: string } = {},
): Promise<BranchResult> => {
  assertRef(name);
  if (!(await isValidBranchName(root, name))) {
    throw new GitError(`Not a valid branch name: ${JSON.stringify(name)}`);
  }

  const existing = (await readBranches(root)).find((b) => b.name === name);
  if (existing) {
    // Idempotent rather than an error: starting a task twice is a normal thing
    // to do, and it should not fail the second time.
    return { branch: name, created: false, head: existing.head };
  }

  const args = ["branch", name];
  if (options.from) args.push(assertRef(options.from));
  await git(root, args);

  const head = (await readBranches(root)).find((b) => b.name === name)?.head ?? "";
  return { branch: name, created: true, head };
};

export type WorktreeResult = { path: string; branch: string; created: boolean };

/**
 * Adds a worktree so an agent can work on a branch without disturbing the
 * checkout a human is using.
 *
 * The path is constrained to a sibling of the repository. Allowing an arbitrary
 * destination would let a request scatter directories anywhere the server can
 * write.
 */
export const addWorktree = async (
  root: string,
  path: string,
  branch: string,
): Promise<WorktreeResult> => {
  assertRef(branch);

  const target = resolve(root, path);
  const allowed = dirname(resolve(root));
  if (!target.startsWith(`${allowed}/`) || target === resolve(root)) {
    throw new GitError(
      `A worktree must be a sibling of the repository; ${JSON.stringify(path)} is not.`,
    );
  }

  const existing = (await readWorktrees(root)).find((w) => w.path === target);
  if (existing) return { path: target, branch: existing.branch ?? branch, created: false };

  const branches = await readBranches(root);
  const args = branches.some((b) => b.name === branch)
    ? ["worktree", "add", target, branch]
    : ["worktree", "add", "-b", branch, target];

  await git(root, args);
  return { path: target, branch, created: true };
};
