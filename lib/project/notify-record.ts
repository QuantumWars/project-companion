/**
 * The notification record (DA-04): one line of JSON for each decision that the CLI tried to notify. It lives in
 * `.project-notify/`, which git ignores, so it stays on this Mac. This module never writes the event log (TH-16).
 * `appendRecord` is design 3.3, "Record write": it refuses symlinks (TH-21) and writes the folder's own `.gitignore`
 * before the first line (TH-13).
 */

import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

export type NotifyOutcome = "sent" | "off" | "unsupported" | "failed";

type LineBase = { id: string; at: string; title: string | null; command: string | null };
export type RecordLine =
  | (LineBase & { outcome: Exclude<NotifyOutcome, "failed"> })
  | (LineBase & { outcome: "failed"; reason: string });

export const NOTIFY_DIR = ".project-notify";
export const NOTIFY_RECORD = ".project-notify/record.jsonl";
export const recordPath = (root: string): string => join(root, NOTIFY_RECORD);

/** A failed record step. It holds only the error code and the path that this code passed (never `error.path`). */
export class RecordError extends Error {
  constructor(readonly code: string, readonly target: string) {
    super(`${code} ${target}`);
    this.name = "RecordError";
  }
}

const codeOf = (error: unknown): string => {
  const { code, name } = (error ?? {}) as { code?: unknown; name?: unknown };
  return typeof code === "string" ? code : typeof name === "string" ? name : "Error";
};

/** Runs `run`. An error with the code `allowed` gives null; any other error is thrown. */
const unless = <T>(allowed: string, run: () => T): T | null => {
  try {
    return run();
  } catch (error) {
    if (codeOf(error) === allowed) return null;
    throw error;
  }
};

/** Throws a RecordError on the first failure, and writes nothing after it. */
export const appendRecord = (root: string, line: RecordLine): void => {
  const folder = join(root, NOTIFY_DIR);
  const ignore = join(folder, ".gitignore");
  const record = recordPath(root);
  let target = folder; // the path that the current step passes
  try {
    // 1. The folder must be a real directory: a symlink or a file gives ENOTDIR.
    let stat = unless("ENOENT", () => lstatSync(folder));
    if (!stat) {
      try {
        mkdirSync(folder, { mode: 0o700 });
      } catch (error) {
        if (codeOf(error) !== "EEXIST") throw error;
        stat = lstatSync(folder); // another process made it at the same time: lstat once more
      }
    }
    if (stat && !stat.isDirectory()) throw new RecordError("ENOTDIR", folder);
    // 2. The ignore file comes before the first append. `wx` never follows a symlink.
    target = ignore;
    unless("EEXIST", () => writeFileSync(ignore, "*\n", { flag: "wx" }));
    // 3. A symlink at the record gives ELOOP. Windows has no O_NOFOLLOW: only step 1 guards there.
    target = record;
    const fd = openSync(record, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
    // 4. One line, with the keys in the design's order and `reason` only on `failed`.
    const { id, at, title, command, outcome } = line;
    const ordered = line.outcome === "failed" ? { id, at, title, command, outcome, reason: line.reason } : { id, at, title, command, outcome };
    try {
      writeSync(fd, JSON.stringify(ordered) + "\n");
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    throw error instanceof RecordError ? error : new RecordError(codeOf(error), target);
  }
};

/** The record's lines, for tests and the metric. A line that is not valid JSON is skipped. */
export const readRecord = (root: string): RecordLine[] =>
  (unless("ENOENT", () => readFileSync(recordPath(root), "utf8")) ?? "").split("\n").flatMap((raw) => {
    try {
      return raw ? [JSON.parse(raw) as RecordLine] : [];
    } catch {
      return [];
    }
  });
