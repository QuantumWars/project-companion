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
import { existsSync, realpathSync } from "node:fs";
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

/**
 * The nearest folder at or above `real` that holds a `.git` entry: a folder in
 * the main checkout, a FILE in a linked worktree (a subagent's copy). Git shows
 * paths relative to this folder in both cases. A rule for a deleted worktree
 * (no `.git` left) can be added here as a second lookup.
 */
const checkoutTop = (real: string): string | undefined => {
  for (let dir = real; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
};

const inside = (rel: string): boolean =>
  rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);

/**
 * An absolute path becomes relative to the checkout that holds it, with
 * forward slashes. With no `.git` above it, it is made relative to `root`. A
 * relative path, a path outside both, or the top folder itself is returned
 * exactly as given: it is never rewritten with a `..` escape.
 */
export const relativeToRoot = (root: string, path: string): string => {
  if (!isAbsolute(path)) return path;
  const real = realish(resolve(path));
  const top = checkoutTop(real);
  const rel = top ? relative(top, real) : relative(realish(resolve(root)), real);
  return inside(rel) ? rel.split(sep).join("/") : path;
};
