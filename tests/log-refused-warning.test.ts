/**
 * Unit tests for `warnLogRefused` (bug ce914d26): it prints the fixed line once per process, only for the
 * 54b4e811 refusal, and never holds event text. In-process, no child (test rules 3, 5, 8).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LOG_REFUSED_WARNING, LogRefusedError, appendEvent, resetLogRefusedWarning, warnLogRefused,
} from "../lib/project/events";
import { eq, ok, runAll, test } from "./harness";

/** Runs `fn` with process.stderr.write captured; always restores it. */
const capture = (fn: () => void): string[] => {
  const lines: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = original;
    resetLogRefusedWarning();
  }
  return lines;
};

test("ce914d26: warnLogRefused prints the fixed line once for the refusal, not twice", () => {
  const lines = capture(() => {
    warnLogRefused(new LogRefusedError("x"));
    warnLogRefused(new LogRefusedError("y"));
  });
  eq(lines.length, 1);
  eq(lines[0], LOG_REFUSED_WARNING);
  eq(lines[0].split("\n").length, 2, "one line, ending in a newline");
});

test("ce914d26: warnLogRefused prints nothing for other errors", () => {
  const lines = capture(() => {
    warnLogRefused(Object.assign(new Error("EROFS: read-only"), { code: "EROFS" }));
    warnLogRefused(new Error("Refused to write the event log: not a regular file"));
    warnLogRefused("text");
    warnLogRefused(undefined);
  });
  eq(lines.length, 0);
});

test("ce914d26: a non-refusal error does not use up the once-per-process flag", () => {
  const lines = capture(() => {
    warnLogRefused(new Error("ENOSPC"));
    warnLogRefused(new LogRefusedError("x"));
  });
  eq(lines.length, 1);
});

test("ce914d26: the warning holds no event text, path or message of the error", () => {
  const dir = mkdtempSync(join(tmpdir(), "pc-ce914d26-unit-"));
  try {
    const secret = "SECRET-ce914d26";
    const lines = capture(() => warnLogRefused(new LogRefusedError(`Refused ${dir} ${secret}`)));
    eq(lines.length, 1);
    ok(!lines[0].includes(secret) && !lines[0].includes(dir), "no text or path from the error");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ce914d26: appendEvent throws the dedicated class for a log folder that is a file", () => {
  const dir = mkdtempSync(join(tmpdir(), "pc-ce914d26-unit-"));
  try {
    // A regular file where the folder should be.
    writeFileSync(join(dir, ".project-log"), "x");
    let caught: unknown;
    try {
      appendEvent(dir, { kind: "task.created" }, { id: "a1", email: "a@b.c", name: "A", host: "h" });
    } catch (error) {
      caught = error;
    }
    ok(caught instanceof LogRefusedError, "expected LogRefusedError");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

runAll().then((failed) => process.exit(failed ? 1 : 0));
