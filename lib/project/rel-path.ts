/**
 * One rule for how a run's touched path is compared with a commit's path.
 *
 * A harness reports the absolute path it wrote; `git` reports paths relative
 * to the top of the checkout that holds the file. Both `reportRun` (on write)
 * and `linkRepository` (on read, for runs logged before the fix) call
 * `relativeToRoot`. The result depends on the path and the folders around it
 * (the nearest `.git`), not on which root the caller holds, so the two sides
 * agree: they cannot drift.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Real path of the deepest part that exists; the rest is appended as given. */
const realish = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(realish(parent), basename(path));
  }
};

/** The nearest folder at or above `real` that holds a `.git` entry (folder or file). */
const nearestGit = (real: string): string | undefined => {
  for (let dir = real; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
};

/**
 * The git common directory of the checkout at `top`, without a subprocess. A
 * main checkout has a `.git` folder: that is it. A linked worktree has a `.git`
 * file pointing at a folder with a `commondir` file; a submodule's folder has
 * none, so its own folder is its common directory.
 */
const commonDir = (top: string): string | undefined => {
  try {
    const dotGit = join(top, ".git");
    if (statSync(dotGit).isDirectory()) return realpathSync(dotGit);
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"));
    if (!match) return undefined;
    const gitdir = resolve(top, match[1]);
    const file = join(gitdir, "commondir");
    return realpathSync(existsSync(file) ? resolve(gitdir, readFileSync(file, "utf8").trim()) : gitdir);
  } catch {
    return undefined;
  }
};

/**
 * The checkout top that git shows paths relative to, kept only when it belongs
 * to THIS repository (same common directory as the repository that holds
 * `root`). Returns `undefined` when no `.git` is above `real` (fall back to
 * `root`), and `null` when the checkout is another repository's: the caller
 * keeps the path as given. A deleted worktree is handled by `deletedWorktree`.
 */
const checkoutTop = (real: string, root: string): string | null | undefined => {
  const top = nearestGit(real);
  if (!top) return undefined;
  const rootTop = nearestGit(root);
  if (!rootTop) return null;
  const mine = commonDir(rootTop);
  return mine !== undefined && mine === commonDir(top) ? top : null;
};

const inside = (rel: string): boolean =>
  rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);

/**
 * A path in a worktree folder that was deleted: `<root>/.claude/worktrees/<name>/<rest>`.
 * Git shows the file as `<rest>`. Only this project's own folder counts, and only
 * when `<name>` is one part and `<rest>` is not empty; the folders themselves give `null` (keep the path). A live checkout (a `.git`
 * inside the worktree folder, so `top` lies in the folder) wins and is not handled here.
 */
const deletedWorktree = (real: string, realRoot: string, top: string | undefined): string | null | undefined => {
  const base = join(realRoot, ".claude", "worktrees");
  if (top !== undefined && inside(relative(base, top))) return undefined;
  const rel = relative(base, real);
  if (rel === "") return null;
  if (!inside(rel)) return undefined;
  const parts = rel.split(sep);
  return parts.length >= 2 ? parts.slice(1).join("/") : null;
};

/**
 * An absolute path becomes relative to the checkout that holds it, with
 * forward slashes. A path in another repository stays absolute. With no `.git` above it, it is made relative to `root`. A
 * relative path, a path outside both, or the top folder itself is returned
 * exactly as given: it is never rewritten with a `..` escape.
 */
export const relativeToRoot = (root: string, path: string): string => {
  if (!isAbsolute(path)) return path;
  const real = realish(resolve(path));
  const realRoot = realish(resolve(root));
  const top = checkoutTop(real, realRoot);
  if (top === null) return path;
  const gone = deletedWorktree(real, realRoot, top);
  if (gone === null) return path;
  if (gone !== undefined) return gone;
  const rel = relative(top ?? realRoot, real);
  return inside(rel) ? rel.split(sep).join("/") : path;
};
