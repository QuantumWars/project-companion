/**
 * Reading the repository.
 *
 * A task is `done` because someone dragged a card. This module is how the board
 * learns whether any code actually exists to back that up.
 *
 * Read-only, and deliberately without a git library: `execFile` plus the
 * porcelain commands covers everything needed here, adds no dependency, and
 * cannot be surprised by a native build. Writes live in `git-write.ts`, which
 * exposes exactly two operations and no way to express a commit.
 *
 * Two rules hold everywhere in this file:
 *
 *   1. `execFile` with an argument array. Never a shell, never interpolation.
 *   2. Any ref that came from outside is validated first. A "ref" beginning
 *      with `-` is an option, so `--upload-pack=...` in a branch name is remote
 *      code execution unless it is rejected.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Long enough for a huge history, short enough that a hang cannot wedge a request. */
const TIMEOUT_MS = 5_000;
const MAX_BUFFER = 32 * 1024 * 1024;

export type GitCommit = {
  sha: string;
  short: string;
  subject: string;
  body: string;
  author: string;
  email: string;
  /** ISO 8601, author date. */
  at: string;
  parents: string[];
  /** Branch and tag names pointing at this commit. */
  refs: string[];
  insertions: number;
  deletions: number;
  paths: string[];
};

export type GitBranch = {
  name: string;
  head: string;
  upstream?: string;
  ahead: number;
  behind: number;
  isCurrent: boolean;
  lastCommitAt: string;
};

export type GitWorktree = {
  path: string;
  head: string;
  branch?: string;
  isMain: boolean;
};

export type GitStatus = {
  branch?: string;
  head?: string;
  ahead: number;
  behind: number;
  /** Number of changed paths in the working tree, staged or not. */
  dirty: number;
  detached: boolean;
};

export class GitError extends Error {}

/* -------------------------------- validation ------------------------------ */

const REF = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,254}$/;

/**
 * Rejects anything that is not plainly a ref.
 *
 * The leading-character rule is the important half: git parses a leading `-` as
 * an option, so an unvalidated ref is an argument-injection into whatever
 * command it is passed to.
 */
export const assertRef = (ref: string): string => {
  if (!REF.test(ref) || ref.includes("..") || ref.endsWith(".lock")) {
    throw new GitError(`Not a valid git ref: ${JSON.stringify(ref)}`);
  }
  return ref;
};

const git = async (cwd: string, args: string[]): Promise<string> => {
  try {
    const { stdout } = await run("git", args, {
      cwd,
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    throw new GitError(describe(error));
  }
};

/**
 * git says what went wrong on stderr, not in the exec message.
 *
 * `error.message` is only "Command failed: git log ...", so discarding stderr
 * loses the one thing worth reading -- including the difference between a real
 * failure and an empty repository having no HEAD to log.
 */
const describe = (error: unknown): string => {
  const stderr = (error as { stderr?: string })?.stderr;
  if (typeof stderr === "string" && stderr.trim()) return stderr.trim();
  return error instanceof Error ? error.message.split("\n")[0] : String(error);
};

/* --------------------------------- probing -------------------------------- */

/**
 * The git root for a directory, which is NOT necessarily the project root.
 *
 * A project's store can sit in a subdirectory of a repo, or in no repo at all.
 * Callers must treat `null` as "git unavailable" and degrade, never error.
 */
export const gitRoot = async (from: string): Promise<string | null> => {
  try {
    return (await git(from, ["rev-parse", "--show-toplevel"])).trim() || null;
  } catch {
    return null;
  }
};

export const isRepo = async (from: string): Promise<boolean> => (await gitRoot(from)) !== null;

/* --------------------------------- commits -------------------------------- */

// ASCII record and unit separators. Chosen because they cannot appear in a
// commit message, author name, or ref -- unlike newlines, which appear in
// commit bodies constantly and defeat line-based splitting.
const RS = "\x1e";
const US = "\x1f";
const FORMAT = [
  "%H", "%h", "%P", "%an", "%ae", "%aI", "%D", "%s", "%b",
].join(US);

export type CommitQuery = {
  limit?: number;
  /** A ref or range. Validated; defaults to the current HEAD. */
  ref?: string;
  /** Every branch, not just the one checked out. */
  all?: boolean;
  /**
   * Refs to exclude, as `git log <ref> --not <these>`.
   *
   * This is what makes "commits on a branch" mean the commits that branch
   * actually introduced, rather than the whole history behind it.
   */
  notRefs?: string[];
  since?: string;
  /** Restrict to commits touching these paths. */
  paths?: string[];
};

export const readCommits = async (root: string, query: CommitQuery = {}): Promise<GitCommit[]> => {
  const limit = Math.min(Math.max(query.limit ?? 200, 1), 2000);

  const args = ["log", `--format=${RS}${FORMAT}`, "--numstat", `--max-count=${limit}`];
  if (query.since) args.push(`--since=${query.since}`);
  if (query.all) args.push("--all");
  if (query.ref) args.push(assertRef(query.ref));
  if (query.notRefs?.length) {
    args.push("--not", ...query.notRefs.map(assertRef));
  }
  // Everything after `--` is a path, so a file called `-f` cannot become a flag.
  if (query.paths?.length) args.push("--", ...query.paths);

  let stdout: string;
  try {
    stdout = await git(root, args);
  } catch (error) {
    // An empty repository has no HEAD to log. That is not a failure.
    if (error instanceof GitError && /unknown revision|does not have any commits|bad default revision/i.test(error.message)) {
      return [];
    }
    throw error;
  }

  return stdout
    .split(RS)
    .slice(1)
    .map(parseCommit)
    .filter((c): c is GitCommit => c !== null);
};

const parseCommit = (record: string): GitCommit | null => {
  const [head, ...rest] = record.split("\n");
  const fields = head.split(US);
  if (fields.length < 9 || !fields[0]) return null;

  const [sha, short, parents, author, email, at, refs, subject] = fields;
  // The body is the ninth field and may itself contain newlines, so it runs to
  // the end of the record's first logical block.
  const bodyAndStats = [fields.slice(8).join(US), ...rest].join("\n");

  const lines = bodyAndStats.split("\n");
  const body: string[] = [];
  const paths: string[] = [];
  let insertions = 0;
  let deletions = 0;
  let inStats = false;

  for (const line of lines) {
    const stat = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (stat) {
      inStats = true;
      insertions += stat[1] === "-" ? 0 : Number(stat[1]);
      deletions += stat[2] === "-" ? 0 : Number(stat[2]);
      // A rename is reported as `old => new`; record where the file ended up.
      paths.push(stat[3].includes(" => ") ? stat[3].split(" => ").pop()!.replace(/[{}]/g, "") : stat[3]);
      continue;
    }
    if (!inStats) body.push(line);
  }

  return {
    sha,
    short,
    subject,
    body: body.join("\n").trim(),
    author,
    email,
    at,
    parents: parents ? parents.split(" ").filter(Boolean) : [],
    refs: refs
      ? refs.split(", ").map((r) => r.replace(/^HEAD -> /, "").trim()).filter(Boolean)
      : [],
    insertions,
    deletions,
    paths,
  };
};

/* -------------------------------- branches -------------------------------- */

export const readBranches = async (root: string): Promise<GitBranch[]> => {
  const format = [
    "%(refname:short)", "%(objectname)", "%(upstream:short)",
    "%(upstream:track)", "%(HEAD)", "%(committerdate:iso-strict)",
  ].join(US);

  const stdout = await git(root, ["for-each-ref", `--format=${format}`, "refs/heads"]);

  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, head, upstream, track, isHead, date] = line.split(US);
      // `--upstream:track` renders as e.g. "[ahead 2, behind 1]".
      const ahead = Number(/ahead (\d+)/.exec(track ?? "")?.[1] ?? 0);
      const behind = Number(/behind (\d+)/.exec(track ?? "")?.[1] ?? 0);
      return {
        name,
        head,
        upstream: upstream || undefined,
        ahead,
        behind,
        isCurrent: isHead === "*",
        lastCommitAt: date,
      };
    });
};

/* -------------------------------- worktrees ------------------------------- */

/**
 * Worktrees matter here because an agent working on several tasks at once uses
 * them, and a branch checked out elsewhere cannot be checked out again.
 */
export const readWorktrees = async (root: string): Promise<GitWorktree[]> => {
  const stdout = await git(root, ["worktree", "list", "--porcelain"]);
  const trees: GitWorktree[] = [];
  let current: Partial<GitWorktree> = {};

  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice(9), isMain: trees.length === 0 };
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice(5);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice(7).replace(/^refs\/heads\//, "");
    } else if (line === "" && current.path) {
      trees.push(current as GitWorktree);
      current = {};
    }
  }
  if (current.path) trees.push(current as GitWorktree);

  return trees;
};

/* --------------------------------- status --------------------------------- */

export const readStatus = async (root: string): Promise<GitStatus> => {
  const stdout = await git(root, ["status", "--porcelain=v2", "--branch"]);

  let branch: string | undefined;
  let head: string | undefined;
  let ahead = 0;
  let behind = 0;
  let dirty = 0;
  let detached = false;

  for (const line of stdout.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      const value = line.slice(14).trim();
      if (value === "(detached)") detached = true;
      else branch = value;
    } else if (line.startsWith("# branch.oid ")) {
      head = line.slice(13).trim();
    } else if (line.startsWith("# branch.ab ")) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      ahead = Number(m?.[1] ?? 0);
      behind = Number(m?.[2] ?? 0);
    } else if (/^[12u?] /.test(line)) {
      dirty++;
    }
  }

  return { branch, head, ahead, behind, dirty, detached };
};

/** A cheap fingerprint of repository state, for keying a derived cache. */
export const repoFingerprint = async (root: string): Promise<string> => {
  const stdout = await git(root, ["for-each-ref", "--format=%(objectname)", "refs/heads"]);
  const heads = stdout.split("\n").filter(Boolean).sort().join("");
  const status = await readStatus(root);
  return `${status.head ?? "none"}:${heads.length}:${heads.slice(0, 64)}`;
};
