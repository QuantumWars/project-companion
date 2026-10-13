/**
 * Regression test for bug 4624028a: `readShard` keeps any parsed line whose `kind` is a string,
 * with no check on `ts` or `data`. A line with a bad `ts` makes `runsFrom` throw RangeError at
 * `new Date(event.ts).toISOString()`; a line with a missing or non-object `data` makes it throw
 * TypeError at `data.to`. One bad line must not cost the rest of the history (test rule 11).
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readEvents, readShard } from "@/lib/project/events";
import { runsFrom } from "@/lib/project/run";
import { eq, test, runAll } from "./harness";

const ACTOR = "aaaabbbbcccc";

const good = (seq: number, kind: string, data: Record<string, unknown>) =>
  JSON.stringify({ id: `${ACTOR}:${seq}`, ts: 1_700_000_000_000 + seq, seq, actor: ACTOR, prev: null, kind, data });

const GOOD_START = good(0, "run.started", { runId: "run-1", actor: { kind: "agent" }, autonomy: "confirm" });
const GOOD_STATE = good(2, "run.state", { runId: "run-1", state: "done" });

/** A run-bearing line in the shape of a good one, with the field under test replaced. */
const withTs = (ts: unknown) =>
  JSON.stringify({ id: `${ACTOR}:1`, ts, seq: 1, actor: ACTOR, prev: null, kind: "run.progress", data: { runId: "run-1" } });
const withData = (data: unknown) =>
  JSON.stringify({ id: `${ACTOR}:1`, ts: 1_700_000_000_001, seq: 1, actor: ACTOR, prev: null, kind: "task.moved", data });

const BAD_LINES: Record<string, string> = {
  "ts 1e20 (out of range)": withTs(1e20),
  "ts a string": withTs("yesterday"),
  "ts null": withTs(null),
  "ts missing": JSON.stringify({ id: `${ACTOR}:1`, seq: 1, actor: ACTOR, prev: null, kind: "run.progress", data: { runId: "run-1" } }),
  "data null": withData(null),
  "data a string": withData("oops"),
  "data an array": withData([1, 2]),
  "data missing": JSON.stringify({ id: `${ACTOR}:1`, ts: 1_700_000_000_001, seq: 1, actor: ACTOR, prev: null, kind: "task.moved" }),
};

const withLog = (lines: string[], fn: (root: string) => void) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pc-4624028a-")));
  try {
    mkdirSync(join(root, ".project-log"), { recursive: true });
    writeFileSync(join(root, ".project-log", `${ACTOR}.jsonl`), lines.join("\n") + "\n");
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

for (const [name, bad] of Object.entries(BAD_LINES)) {
  test(`4624028a: readShard drops a line with ${name} and keeps the good lines`, () => {
    withLog([GOOD_START, bad, GOOD_STATE], (root) => {
      eq(readShard(root, ACTOR).map((e) => e.seq), [0, 2], "only the two good records are kept");
    });
  });

  test(`4624028a: runsFrom still reads the good run when the log holds a line with ${name}`, () => {
    withLog([GOOD_START, bad, GOOD_STATE], (root) => {
      const runs = runsFrom(readEvents(root));
      eq(runs.map((r) => r.id), ["run-1"], "the run beside the bad line must still be read");
      eq(runs[0].state, "done", "and its later good event must still apply");
    });
  });
}

runAll().then((failed) => process.exit(failed ? 1 : 0));
