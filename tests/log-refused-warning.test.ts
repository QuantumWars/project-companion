/**
 * Unit tests for `warnLogRefused` (bug ce914d26): it prints the fixed line once per process, only for the
 * 54b4e811 refusal, and never holds event text. In-process, no child (test rules 3, 5, 8).
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LOG_REFUSED_FAILURE, LOG_REFUSED_WARNING, LogRefusedError, appendEvent, resetLogRefusedWarning, resolveActor, warnIfLogPlanted, warnLogRefused,
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

const ACTOR = { id: "a1", email: "a@b.c", name: "A", host: "h" };

/** Runs `fn` with a fresh temp project folder; always removes it. */
const inTmp = (fn: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), "pc-ce914d26-unit-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("ce914d26: warnIfLogPlanted is silent with no .project-log folder", () => {
  inTmp((dir) => eq(capture(() => warnIfLogPlanted(dir)).length, 0));
});

test("ce914d26: warnIfLogPlanted is silent for an empty .project-log", () => {
  inTmp((dir) => {
    mkdirSync(join(dir, ".project-log"));
    eq(capture(() => warnIfLogPlanted(dir)).length, 0);
  });
});

test("ce914d26: warnIfLogPlanted is silent when the own shard is a regular file", () => {
  inTmp((dir) => {
    mkdirSync(join(dir, ".project-log"));
    writeFileSync(join(dir, ".project-log", `${resolveActor(dir).id}.jsonl`), "");
    eq(capture(() => warnIfLogPlanted(dir)).length, 0);
  });
});

test("ce914d26: warnIfLogPlanted warns once when .project-log is a regular file", () => {
  inTmp((dir) => {
    writeFileSync(join(dir, ".project-log"), "x");
    const lines = capture(() => {
      warnIfLogPlanted(dir);
      warnIfLogPlanted(dir);
    });
    eq(lines.length, 1);
    eq(lines[0], LOG_REFUSED_WARNING);
  });
});

test("ce914d26: warnIfLogPlanted warns once when the own shard is a symlink", () => {
  inTmp((dir) => {
    const target = join(dir, "elsewhere.txt");
    writeFileSync(target, "OUTSIDE\n");
    mkdirSync(join(dir, ".project-log"));
    symlinkSync(target, join(dir, ".project-log", `${resolveActor(dir).id}.jsonl`));
    const lines = capture(() => warnIfLogPlanted(dir));
    eq(lines.length, 1);
    eq(lines[0], LOG_REFUSED_WARNING);
  });
});

test("ce914d26: warnIfLogPlanted never throws, even when the folder does not exist", () => {
  const lines = capture(() => warnIfLogPlanted(join(tmpdir(), "pc-ce914d26-no-such-dir", "x")));
  eq(lines.length, 0);
});

test("ce914d26: the warning words do not tell the user to delete the contents of .project-log", () => {
  ok(!/remove the planted file/i.test(LOG_REFUSED_WARNING), "old wording gone");
  eq(LOG_REFUSED_WARNING.split("\n").length, 2, "one line");
  const tail = ".project-log, or a .jsonl file in it, is a link or not a plain file or folder. Fix: delete that link or file (ls -ld .project-log, then ls -la .project-log/ to look), then run the command again.\n";
  eq(LOG_REFUSED_WARNING, "project-companion: the event log is not recording events: " + tail, "exact warning");
  eq(LOG_REFUSED_FAILURE, "project-companion: this command failed because the event log was not written: " + tail, "exact failure");
});

test("ce914d26: a refusal, a good write, then a second refusal warn twice (one per episode)", () => {
  inTmp((dir) => {
    const refuse = () => {
      try {
        appendEvent(dir, { kind: "task.created" }, ACTOR);
      } catch (error) {
        warnLogRefused(error);
      }
    };
    const lines = capture(() => {
      writeFileSync(join(dir, ".project-log"), "x");
      refuse();
      refuse(); // same episode: no second line
      rmSync(join(dir, ".project-log"));
      appendEvent(dir, { kind: "task.created" }, ACTOR); // a good write ends the episode
      rmSync(join(dir, ".project-log"), { recursive: true, force: true });
      writeFileSync(join(dir, ".project-log"), "x");
      refuse();
    });
    eq(lines.length, 2);
  });
});

runAll().then((failed) => process.exit(failed ? 1 : 0));
