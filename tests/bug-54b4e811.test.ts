/**
 * Regression test for bug 54b4e811 (SR-8 residual 3; `specs/decision-alerts/threat-model.md`,
 * TH-7 residual 3): the tracker's own files -- log shards and `.project` -- are read, and
 * write-then-renamed, with no check on what is actually at that path.
 *
 * Observed 1 (the hang): `readShard` (`lib/project/events.ts`) and `readBundle`
 * (`lib/project/bundle.ts`) call `readFileSync` the moment `existsSync`/the try block says there
 * is something there, with no check that it is a regular file first. A merged commit can replace
 * a shard or `.project` with a symlink to a device or a FIFO; opening that blocks or never
 * returns, which is the same hang SR-8 (bug d5ebde85) was opened for, reached here through a
 * different pair of files (D1 and D2, not a gate artifact).
 *
 * Reproducing the hang safely: the bug report names `/dev/zero`, but an unbounded
 * `readFileSync('/dev/zero')` allocates memory at roughly 1.5-2 GB/s on this machine (measured
 * locally with `ps`: ~1.4 GB RSS at 0.5 s, ~4.7 GB at 2 s, still climbing) before anything kills
 * it -- a timeout generous enough to tell "hung" from "a slow disk" apart would risk running the
 * CI runner or the PM's own Mac out of memory. A FIFO with no writer blocks in the same unbounded
 * way (`open()` for reading never returns while no writer exists) but allocates nothing (measured
 * locally: flat ~38 MB RSS, same as an idle `node`), so this suite symlinks at a FIFO instead of a
 * device. `mkfifo` is already this codebase's way to make one (`tests/notify.test.ts`'s TH-8), and
 * that test's own skip-if-unavailable fallback is reused here.
 *
 * Even a FIFO read must never run on the suite's own process: a regression must fail as a clear
 * assertion, not freeze `npm test`. Nothing this library exports lets a bare `node` process
 * `import "@/lib/project/events"` without esbuild's bundling and path alias, so the one cheap way
 * to get a second, killable process that still runs the exact code under test is to re-run this
 * same file (`scripts/run-tests.mjs` already produces one self-contained bundle per test file) with
 * a flag that makes it call `readShard`/`readBundle` once and exit, instead of registering tests.
 * `probe` below spawns that second process with `spawnSync`'s own `timeout`, which the parent
 * enforces without any cooperation from the (possibly hung) child.
 *
 * Observed 2 (the temp-file write): `writeBundle` (`lib/project/bundle.ts`), `writeText`
 * (`lib/project/roadmap.ts`, reached through `editPrd`) and `writeJson` (`lib/project/store.ts`)
 * all write `<path>.<pid>.tmp` with a plain `writeFileSync`, which follows a symlink already
 * sitting at that exact name. These are ordinary, fast writes -- no device, no child process
 * needed -- so they run in-process: each test plants a symlink at the temp path pointing at a file
 * outside the project, and checks that file's content is unchanged afterwards. Before the fix, the
 * write follows the symlink and overwrites it.
 */

import { spawnSync } from "node:child_process";
import {
  mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bundlePath, emptyBundle, readBundle, writeBundle } from "@/lib/project/bundle";
import { readShard } from "@/lib/project/events";
import { editPrd } from "@/lib/project/roadmap";
import { initProject, writeJson } from "@/lib/project/store";
import { eq, test, runAll } from "./harness";

const HELPER_FLAG = "--54b4e811-helper";
const PROBE_TIMEOUT_MS = 3000;

if (process.argv[2] === HELPER_FLAG) {
  // Helper mode (see the file comment): call exactly the function under test, once, and print its
  // result as JSON. No test is registered and `runAll` never runs here, so this process always
  // exits by itself -- except when the bug being tested for makes the call below never return,
  // which is exactly what the parent's timeout is for.
  const action = process.argv[3];
  const args = process.argv.slice(4);
  try {
    const value = action === "readShard" ? readShard(args[0], args[1]) : readBundle(args[0]);
    process.stdout.write(JSON.stringify({ ok: true, value }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  }
  process.exit(0);
} else {
  const tmpProject = () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "pc-54b4e811-")));
    const root = join(parent, "project");
    mkdirSync(root, { recursive: true });
    return { parent, root, cleanup: () => rmSync(parent, { recursive: true, force: true }) };
  };

  /** A FIFO at `path`; false when this machine has no `mkfifo` (callers then skip, as TH-8 does). */
  const mkfifo = (path: string): boolean => {
    const made = spawnSync("mkfifo", [path]);
    return !made.error && made.status === 0;
  };

  type ProbeResult = { timedOut: boolean; ok?: boolean; value?: unknown; error?: string };

  /** Runs `action` on `args` in a disposable second process (this file, re-run in helper mode). */
  const probe = (action: "readShard" | "readBundle", args: string[]): ProbeResult => {
    const run = spawnSync(process.execPath, [process.argv[1], HELPER_FLAG, action, ...args], {
      timeout: PROBE_TIMEOUT_MS,
      killSignal: "SIGKILL",
      encoding: "utf8",
    });
    if (run.signal || run.error) return { timedOut: true };
    try {
      return { timedOut: false, ...(JSON.parse(run.stdout) as { ok: boolean; value?: unknown; error?: string }) };
    } catch {
      return { timedOut: false, ok: false, error: `unreadable helper output: ${JSON.stringify(run.stdout)} ${run.stderr}` };
    }
  };

  /* --------------------------------- reads --------------------------------- */

  test("54b4e811: a log shard that is a symlink to a FIFO with no writer is not read", () => {
    const { parent, root, cleanup } = tmpProject();
    try {
      const fifo = join(parent, "shard.fifo");
      if (!mkfifo(fifo)) return; // no mkfifo on this machine: nothing to probe
      mkdirSync(join(root, ".project-log"), { recursive: true });
      symlinkSync(fifo, join(root, ".project-log", "deadbeefcafe.jsonl"));

      const result = probe("readShard", [root, "deadbeefcafe"]);
      eq(result.timedOut, false, "readShard must not block on a shard that is a symlink to a FIFO with no writer");
      eq(result.ok, true, `readShard must not throw: ${JSON.stringify(result)}`);
      eq(result.value, [], "a shard that is not a regular file must be treated as missing, like one that does not exist");
    } finally {
      cleanup();
    }
  });

  test("54b4e811: a .project that is a symlink to a FIFO with no writer is not read", () => {
    const { parent, root, cleanup } = tmpProject();
    try {
      const fifo = join(parent, "bundle.fifo");
      if (!mkfifo(fifo)) return; // no mkfifo on this machine: nothing to probe
      symlinkSync(fifo, bundlePath(root));

      const result = probe("readBundle", [root]);
      eq(result.timedOut, false, "readBundle must not block on a .project that is a symlink to a FIFO with no writer");
      eq(result.ok, true, `readBundle must not throw: ${JSON.stringify(result)}`);
      eq(result.value, null, "a .project that is not a regular file must be treated as missing, like one that does not exist");
    } finally {
      cleanup();
    }
  });

  /* ------------------------------ temp writes ------------------------------ */

  test("54b4e811: a symlink at .project's temp path does not redirect writeBundle's write", () => {
    const { parent, root, cleanup } = tmpProject();
    try {
      const outside = join(parent, "keep.json");
      writeFileSync(outside, "keep\n");
      symlinkSync(outside, `${bundlePath(root)}.${process.pid}.tmp`);

      writeBundle(root, emptyBundle("Demo"));

      eq(readFileSync(outside, "utf8"), "keep\n", "the file outside the root changed when the bundle was written");
    } finally {
      cleanup();
    }
  });

  test("54b4e811: a symlink at the PRD's temp path does not redirect editPrd's write", () => {
    const { parent, root, cleanup } = tmpProject();
    try {
      initProject(root, "Demo");
      mkdirSync(join(root, "docs"), { recursive: true });
      writeFileSync(join(root, "docs", "prd.md"), "# PRD\n\n## Phase: Alerts\n");

      const outside = join(parent, "keep.md");
      writeFileSync(outside, "keep\n");
      symlinkSync(outside, `${join(root, "docs", "prd.md")}.${process.pid}.tmp`);

      editPrd(root, undefined, [{ op: "addPhase", name: "New phase" }]);

      eq(readFileSync(outside, "utf8"), "keep\n", "the file outside the root changed when the PRD was written");
    } finally {
      cleanup();
    }
  });

  test("54b4e811: a symlink at a JSON temp path does not redirect writeJson's write", () => {
    const { parent, root, cleanup } = tmpProject();
    try {
      const target = join(root, "data.json");
      const outside = join(parent, "keep.json");
      writeFileSync(outside, "keep\n");
      symlinkSync(outside, `${target}.${process.pid}.tmp`);

      writeJson(target, { hello: "world" });

      eq(readFileSync(outside, "utf8"), "keep\n", "the file outside the root changed when writeJson ran");
    } finally {
      cleanup();
    }
  });

  /* -------------------------------- control -------------------------------- */

  test("54b4e811: a plain write to .project, the PRD and a JSON file still succeeds (control)", () => {
    const { root, cleanup } = tmpProject();
    try {
      initProject(root, "Demo");
      mkdirSync(join(root, "docs"), { recursive: true });
      writeFileSync(join(root, "docs", "prd.md"), "# PRD\n\n## Phase: Alerts\n");

      const updated = editPrd(root, undefined, [{ op: "addPhase", name: "New phase" }]);
      eq(updated.phases.some((p) => p.name === "New phase"), true, "the new phase landed");
      eq(readBundle(root)?.name, "Demo", "the bundle is still readable after an ordinary write");

      const target = join(root, "data.json");
      writeJson(target, { hello: "world" });
      eq(JSON.parse(readFileSync(target, "utf8")), { hello: "world" }, "writeJson still writes the file, with no symlink in the way");
    } finally {
      cleanup();
    }
  });

  runAll().then((failed) => process.exit(failed ? 1 : 0));
}
