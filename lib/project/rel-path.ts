/**
 * One rule for how a run's touched path is compared with a commit's path.
 *
 * A harness reports the absolute path it wrote; `git` reports paths relative to
 * the repository root. Both `reportRun` (on write) and `linkRepository` (on
 * read, for runs logged before the fix) use this, so the two cannot drift.
 */
import { realpathSync } from "node:fs";
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
 * An absolute path inside `root` becomes relative with forward slashes. A
 * relative path, a path outside `root`, or `root` itself is returned exactly as
 * given: it is never rewritten with a `..` escape.
 */
export const relativeToRoot = (root: string, path: string): string => {
  if (!isAbsolute(path)) return path;
  const rel = relative(realish(resolve(root)), realish(resolve(path)));
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return path;
  return rel.split(sep).join("/");
};
