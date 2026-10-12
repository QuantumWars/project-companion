/**
 * Bug 54b4e811, security review F1: `appendEvent` when the actor's own shard, or `.project-log`
 * itself, is not what it should be.
 *
 * `readShard` treats a shard that is not a regular file inside the root as missing. Before this fix,
 * `appendEvent` then took the actor's own refused shard for a new one: it wrote `actor.identified`
 * with `appendFileSync`, which follows a symlink, and called itself again. `readShard` still said
 * "missing", so it never stopped: unbounded lines in a file outside the root, a stack overflow on
 * `/dev/null`, or an open that waits for ever on a FIFO with no reader.
 *
 * Each case can loop or block on a regression, so it runs in a second process (this file, re-run with
 * a helper flag, as `bug-54b4e811.test.ts` does) with a timeout. A regression then fails as an
 * assertion, never as a stuck suite (test rules 3 and 4).
 */

import { spawnSync } from "node:child_process";
import {
  closeSync, constants, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendEvent, readShard, verifyShard, writeRecords } from "@/lib/project/events";
import { eq, ok, runAll, test, throws } from "./harness";

const HELPER_FLAG = "--append-shard-helper";
const TIMEOUT_MS = 3000;
const ACTOR = { id: "deadbeefcafe", email: "dev@example.com", name: "Dev", host: "test-host" };

if (process.argv[2] === HELPER_FLAG) {
  // Helper mode: one append, its outcome as JSON, then exit. With a FIFO as argv[4], hold it open for
  // reading first (O_NONBLOCK, so this open never waits), so the append meets a FIFO that has a reader.
  const [root, fifo] = process.argv.slice(3);
  const reader = fifo ? openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK) : null;
  try {
    appendEvent(root, { kind: "task.created", data: { id: "t1" } }, ACTOR);
    process.stdout.write(JSON.stringify({ ok: true }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  }
  if (reader !== null) closeSync(reader);
  process.exit(0);
} else {
  const tmpProject = () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "pc-append-shard-")));
    const root = join(parent, "project");
    mkdirSync(join(root, ".project-log"), { recursive: true });
    const shard = join(root, ".project-log", `${ACTOR.id}.jsonl`);
    return { parent, root, shard, cleanup: () => rmSync(parent, { recursive: true, force: true }) };
  };

  /** A FIFO at `path`; false when this machine has no `mkfifo` (the test then skips, as TH-8 does). */
  const mkfifo = (path: string): boolean => {
    const made = spawnSync("mkfifo", [path]);
    return !made.error && made.status === 0;
  };

  type Outcome = { timedOut: boolean; ok?: boolean; error?: string };

  /** One `appendEvent` in a second process that is killed after TIMEOUT_MS. */
  const append = (root: string, readerFifo?: string): Outcome => {
    const run = spawnSync(process.execPath, [process.argv[1], HELPER_FLAG, root, ...(readerFifo ? [readerFifo] : [])], {
      timeout: TIMEOUT_MS,
      killSignal: "SIGKILL",
      encoding: "utf8",
    });
    if (run.signal || run.error) return { timedOut: true };
    try {
      return { timedOut: false, ...(JSON.parse(run.stdout) as { ok: boolean; error?: string }) };
    } catch {
      return { timedOut: false, ok: false, error: `unreadable helper output: ${JSON.stringify(run.stdout)} ${run.stderr}` };
    }
  };

  /** The append ended by itself, with the clear refusal. */
  const refused = (outcome: Outcome, what: string, match: RegExp) => {
    eq(outcome.timedOut, false, `appendEvent must not loop or block when ${what}`);
    eq(outcome.ok, false, `appendEvent must throw when ${what}`);
    ok(match.test(outcome.error ?? ""), `appendEvent must refuse clearly when ${what}, not with ${JSON.stringify(outcome.error)}`);
  };

  const NOT_A_FILE = /is not a regular file/;

  test("54b4e811 F1: an own shard that is a symlink to /dev/null makes appendEvent throw, not loop", () => {
    const { root, shard, cleanup } = tmpProject();
    try {
      symlinkSync("/dev/null", shard);
      refused(append(root), "the own shard is a symlink to /dev/null", NOT_A_FILE);
    } finally {
      cleanup();
    }
  });

  test("54b4e811 F1: an own shard that is a symlink to a file outside the root leaves that file unchanged", () => {
    const { parent, root, shard, cleanup } = tmpProject();
    try {
      const outside = join(parent, "outside.jsonl");
      writeFileSync(outside, "keep\n");
      const before = readFileSync(outside);
      symlinkSync(outside, shard);

      refused(append(root), "the own shard is a symlink to a file outside the root", NOT_A_FILE);
      ok(readFileSync(outside).equals(before), "the file outside the root changed");
    } finally {
      cleanup();
    }
  });

  test("54b4e811 F1: an own shard that is a symlink to a FIFO with no reader makes appendEvent throw, not block", () => {
    const { parent, root, shard, cleanup } = tmpProject();
    try {
      const fifo = join(parent, "shard.fifo");
      if (!mkfifo(fifo)) return; // no mkfifo on this machine: nothing to probe
      symlinkSync(fifo, shard);
      refused(append(root), "the own shard is a symlink to a FIFO with no reader", NOT_A_FILE);
    } finally {
      cleanup();
    }
  });

  test("54b4e811 F1: an own shard that is a FIFO, with no reader (ENXIO) or with one (fstat), makes appendEvent throw", () => {
    const { root, shard, cleanup } = tmpProject();
    try {
      if (!mkfifo(shard)) return; // no mkfifo on this machine: nothing to probe
      refused(append(root), "the own shard is a FIFO with no reader", NOT_A_FILE);
      refused(append(root, shard), "the own shard is a FIFO with a reader", NOT_A_FILE);
    } finally {
      cleanup();
    }
  });

  test("54b4e811 F1: a .project-log that is a symlink to a folder outside the root gets no shard", () => {
    const { parent, root, cleanup } = tmpProject();
    try {
      const elsewhere = join(parent, "elsewhere");
      mkdirSync(elsewhere);
      rmSync(join(root, ".project-log"), { recursive: true });
      symlinkSync(elsewhere, join(root, ".project-log"));

      refused(append(root), ".project-log is a symlink to a folder outside the root", /is not a real folder/);
      eq(readdirSync(elsewhere), [], "a shard was created in the folder outside the root");
    } finally {
      cleanup();
    }
  });

  // The cases below cannot block (a folder, a long name and a missing folder never wait), so they run in-process.

  test("54b4e811 F1: an own shard that is a folder (EISDIR) makes appendEvent refuse clearly", () => {
    const { root, shard, cleanup } = tmpProject();
    try {
      mkdirSync(join(shard, "inside"), { recursive: true }); // what a merged `<shard>/inside/x` leaves
      throws(() => appendEvent(root, { kind: "task.created" }, ACTOR), NOT_A_FILE, "a folder at the shard's name");
    } finally {
      cleanup();
    }
  });

  test("54b4e811 F1: any other open or lstat error passes through unchanged", () => {
    const { parent, root, cleanup } = tmpProject();
    try {
      const longActor = { ...ACTOR, id: "a".repeat(300) }; // a shard name longer than any filesystem allows
      throws(() => appendEvent(root, { kind: "task.created" }, longActor), /ENAMETOOLONG/, "the open error");
      const fileRoot = join(parent, "not-a-folder");
      writeFileSync(fileRoot, "");
      throws(() => appendEvent(fileRoot, { kind: "task.created" }, ACTOR), /ENOTDIR/, "the lstat error");
    } finally {
      cleanup();
    }
  });

  test("54b4e811 F1: a plain shard still opens with the identity, then each event, in one chain (control)", () => {
    const { root, cleanup } = tmpProject();
    try {
      eq(append(root), { timedOut: false, ok: true }, "the first append to a new shard");
      appendEvent(root, { kind: "task.moved", data: { id: "t1" } }, ACTOR);
      const shard = readShard(root, ACTOR.id);
      eq(shard.map((e) => [e.seq, e.kind]), [[0, "actor.identified"], [1, "task.created"], [2, "task.moved"]]);
      ok(shard[1].ts > shard[0].ts, "the event sorts after the identity");
      eq(verifyShard(root, ACTOR.id), [], "the hash chain is intact");
    } finally {
      cleanup();
    }
  });

  // Windows has no O_NOFOLLOW. These tests run writeRecords with noFollow false to model it (N2, task 97012dae).
  const NO_NOFOLLOW = false;
  const rec = { id: `${ACTOR.id}:0`, ts: 1, seq: 0, actor: ACTOR.id, prev: null, kind: "actor.identified", data: {} } as never;

  test("54b4e811 N2: without O_NOFOLLOW, a shard that is a symlink to a regular file is refused, target unchanged", () => {
    const { parent, root, shard, cleanup } = tmpProject();
    try {
      const outside = join(parent, "outside.sh");
      writeFileSync(outside, "keep\n");
      const before = readFileSync(outside);
      symlinkSync(outside, shard);
      throws(() => writeRecords(root, ACTOR.id, [rec], NO_NOFOLLOW), NOT_A_FILE);
      ok(readFileSync(outside).equals(before), "the symlink target changed");
    } finally {
      cleanup();
    }
  });

  test("54b4e811 N2: without O_NOFOLLOW, a missing shard is created", () => {
    const { root, shard, cleanup } = tmpProject();
    try {
      writeRecords(root, ACTOR.id, [rec], NO_NOFOLLOW);
      eq(readFileSync(shard, "utf8").split("\n").length, 2, "one line and a final newline");
    } finally {
      cleanup();
    }
  });

  test("54b4e811 N2: without O_NOFOLLOW, a regular shard is appended to", () => {
    const { root, shard, cleanup } = tmpProject();
    try {
      writeFileSync(shard, "old\n");
      writeRecords(root, ACTOR.id, [rec], NO_NOFOLLOW);
      ok(readFileSync(shard, "utf8").startsWith("old\n{"), "old line kept, new line after it");
    } finally {
      cleanup();
    }
  });

  test("54b4e811 N2: without O_NOFOLLOW, an ENOTDIR on the shard path reaches the caller", () => {
    const { root, cleanup } = tmpProject();
    try {
      rmSync(join(root, ".project-log"), { recursive: true });
      writeFileSync(join(root, ".project-log"), "not a folder"); // a path below a file gives ENOTDIR
      throws(() => writeRecords(root, ACTOR.id, [rec], NO_NOFOLLOW), /ENOTDIR/);
    } finally {
      cleanup();
    }
  });

  runAll().then((failed) => process.exit(failed ? 1 : 0));
}
