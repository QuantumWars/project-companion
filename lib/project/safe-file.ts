/**
 * Reads and writes of the tracker's own files that a merged commit cannot redirect (SR-8, bug 54b4e811).
 *
 * A merge can put a symlink, a folder, a device or a FIFO where a log shard, `.project` or a gate artifact
 * should be. A read takes only a regular file inside the root. A write never opens what is already at its
 * temp path. This module imports nothing from the project, so `events.ts` and `bundle.ts` can use it.
 */

import { realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

/** Whether the real path `file` is the real path `base` or inside it (SR-8). */
export const isInside = (base: string, file: string): boolean => {
  const rel = relative(base, file);
  return !isAbsolute(rel) && rel.split(sep)[0] !== "..";
};

/**
 * The real path of `path` when it is a regular file inside `root`; null otherwise (SR-8).
 *
 * A merged log names the path, so a `..` escape, a symlink out of the root, a
 * folder, a device or a FIFO counts as missing. Nothing here opens the file.
 * The roadmap's PRD source read uses it too.
 */
export const regularFileIn = (root: string, path: string): string | null => {
  try {
    const base = realpathSync(root);
    const file = realpathSync(join(base, path));
    if (!isInside(base, file)) return null;
    return statSync(file).isFile() ? file : null;
  } catch {
    return null; // as existsSync did: a path that cannot be resolved is missing
  }
};

/**
 * Writes `text` to `<path>.<pid>.tmp`, then renames it to `path`, so a reader never sees half a file.
 *
 * `wx` never follows a symlink and never opens a file that is already there (O_EXCL). On EEXIST the
 * temp path is removed -- unlink removes a symlink, never its target -- and written again with `wx`.
 */
export const replaceFile = (path: string, text: string): void => {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    unlinkSync(tmp);
    writeFileSync(tmp, text, { encoding: "utf8", flag: "wx" });
  }
  renameSync(tmp, path);
};
