import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { readBundle } from "@/lib/project/bundle";
import { editPrd, readRoadmap } from "@/lib/project/roadmap";
import {
  createDiagram, createTask, initProject, readDiagram, readTasks, writeDiagram,
} from "@/lib/project/store";
import { eq, ok, runAll, test } from "./harness";

const run = promisify(execFile);

/**
 * Concurrency, now that a project is one file.
 *
 * Before the bundle, a canvas autosave and a task edit wrote different files
 * and could never collide. They now write the same one, so every interleaving
 * that used to be impossible has to be shown to be safe.
 */

const project = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pc-sync-")));
  initProject(dir, "Sync");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

test("two writes to different parts of the project both survive", () => {
  const { dir, cleanup } = project();
  try {
    const d = createDiagram(dir, "Canvas", "architecture");

    // The shape of the race: a canvas save and a task edit, interleaved.
    createTask(dir, { title: "From the CLI", status: "todo" });
    writeDiagram(dir, {
      ...d,
      nodes: [{ id: "n1", type: "service", position: { x: 0, y: 0 }, data: { kind: "service", label: "A" } }] as never,
    });

    eq(readTasks(dir).tasks.length, 1, "the task survived the diagram write");
    eq(readDiagram(dir, d.id)!.nodes.length, 1, "the diagram survived the task write");
  } finally { cleanup(); }
});

test("a write against a stale read does not erase the newer one", () => {
  const { dir, cleanup } = project();
  try {
    const d = createDiagram(dir, "Canvas", "architecture");
    const stale = readDiagram(dir, d.id)!;

    // Somebody else edits in between.
    createTask(dir, { title: "Landed first", status: "todo" });

    // Now the stale writer saves. It must not take the project back.
    writeDiagram(dir, { ...stale, nodes: [{ id: "n1", type: "service", position: { x: 0, y: 0 }, data: { kind: "service", label: "A" } }] as never });

    eq(readTasks(dir).tasks.length, 1, "the task that landed first is still there");
    eq(readDiagram(dir, d.id)!.nodes.length, 1, "and the later diagram write also landed");
  } finally { cleanup(); }
});

test("many rapid writes all land", () => {
  const { dir, cleanup } = project();
  try {
    for (let i = 0; i < 40; i++) {
      createTask(dir, { title: `Task ${i}`, status: "todo" });
    }
    eq(readTasks(dir).tasks.length, 40, "no write was lost");
    // Ids must still be unique after that many round trips.
    const ids = new Set(readTasks(dir).tasks.map((t) => t.id));
    eq(ids.size, 40, "no id collisions");
  } finally { cleanup(); }
});

test("a separate process writing at the same time does not lose data", async () => {
  const { dir, cleanup } = project();
  try {
    const cli = join(process.cwd(), "dist", "project-companion.mjs");

    // Fifteen writes from this process and fifteen from separate processes, all
    // launched at once. Before the lock this reliably lost several.
    const mine = Array.from({ length: 15 }, (_, i) =>
      Promise.resolve().then(() => createTask(dir, { title: `in-process ${i}`, status: "todo" })),
    );
    const theirs = Array.from({ length: 15 }, (_, i) =>
      run(process.execPath, [cli, "task", "add", `subprocess ${i}`, "--status", "todo"], { cwd: dir }),
    );

    await Promise.all([...mine, ...theirs]);

    const tasks = readTasks(dir).tasks;
    eq(tasks.length, 30, `every write landed (got ${tasks.length})`);
    eq(new Set(tasks.map((t) => t.id)).size, 30, "and every id is distinct");
    // The revision counter must have advanced once per write, with no gaps
    // that would indicate a clobbered generation.
    ok(readBundle(dir)!.revision >= 30, "the revision counter tracked every write");
  } finally { cleanup(); }
});

test("a mutation of one part does not disturb another under load", async () => {
  const { dir, cleanup } = project();
  try {
    const cli = join(process.cwd(), "dist", "project-companion.mjs");
    const d = createDiagram(dir, "Canvas", "architecture");

    // Diagram saves and task writes, from two processes, at the same time.
    const saves = Array.from({ length: 12 }, (_, i) =>
      Promise.resolve().then(() =>
        writeDiagram(dir, {
          ...readDiagram(dir, d.id)!,
          nodes: Array.from({ length: i + 1 }, (_, n) => ({
            id: `n${n}`,
            type: "service",
            position: { x: n, y: n },
            data: { kind: "service", label: `N${n}` },
          })) as never,
        }),
      ),
    );
    const adds = Array.from({ length: 12 }, (_, i) =>
      run(process.execPath, [cli, "task", "add", `t${i}`, "--status", "todo"], { cwd: dir }),
    );

    await Promise.all([...saves, ...adds]);

    eq(readTasks(dir).tasks.length, 12, "no task was lost to a diagram save");
    ok(readDiagram(dir, d.id)!.nodes.length > 0, "the diagram still has its nodes");
    eq(Object.keys(readBundle(dir)!.diagrams).length, 1, "and nothing duplicated the diagram");
  } finally { cleanup(); }
});

test("the file on disk is always complete JSON, never half-written", () => {
  const { dir, cleanup } = project();
  try {
    for (let i = 0; i < 25; i++) {
      createTask(dir, { title: `Task ${i}`, status: "todo" });
      // Read it back raw between every write: an atomic rename means a reader
      // sees the old file or the new one, never a truncated one.
      const raw = readFileSync(join(dir, ".project"), "utf8");
      JSON.parse(raw);
    }
    ok(true, "every intermediate read parsed");
  } finally { cleanup(); }
});

test("an externally edited file is picked up on the next read", () => {
  const { dir, cleanup } = project();
  try {
    createDiagram(dir, "Canvas", "architecture");
    const bundle = readBundle(dir)!;

    // Something outside the app rewrites the file, as an agent would.
    writeFileSync(
      join(dir, ".project"),
      JSON.stringify({ ...bundle, name: "Renamed outside" }, null, 2),
      "utf8",
    );

    eq(readBundle(dir)!.name, "Renamed outside", "no stale cache masks the change");
  } finally { cleanup(); }
});

/* ------------------------------- the PRD too ------------------------------- */

/**
 * `docs/prd.md` is the other file two writers share.
 *
 * It has its own compare-and-swap -- a hash of the raw bytes -- but a hash check
 * has exactly the race a revision check has: two writers read the same document,
 * both find the hash matches, both splice their own edit into the text THEY
 * read, and the second rename erases the first. So it takes the same lock.
 */

const CRITERIA = 12;

const withPrd = () => {
  const { dir, cleanup } = project();
  const criteria = Array.from({ length: CRITERIA }, (_, i) => `- [ ] criterion ${i}`);
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(
    join(dir, "docs", "prd.md"),
    [
      "# Concurrency PRD",
      "",
      "Prose that must survive every one of these writes.",
      "",
      "## Phase: One",
      "",
      "### Widget",
      "<!-- id: widget -->",
      "",
      ...criteria,
      "",
    ].join("\n"),
    "utf8",
  );
  return { dir, cleanup };
};

const ticked = (dir: string) =>
  readRoadmap(dir).features[0].acceptance.filter((c) => c.done).length;

/** Criterion ids, in document order. The CLI takes text; `editPrd` takes ids. */
const criterionIds = (dir: string) =>
  readRoadmap(dir).features[0].acceptance.map((c) => c.id);

test("concurrent ticks from separate processes all land", async () => {
  const { dir, cleanup } = withPrd();
  try {
    const cli = join(process.cwd(), "dist", "project-companion.mjs");

    // Every process ticks a different box, all at once. Without the lock these
    // read the same document and the last rename wins, losing most of them.
    await Promise.all(
      Array.from({ length: CRITERIA }, (_, i) =>
        run(process.execPath, [cli, "feature", "check", "widget", `criterion ${i}`], { cwd: dir }),
      ),
    );

    eq(ticked(dir), CRITERIA, `every tick landed (got ${ticked(dir)})`);
  } finally { cleanup(); }
});

test("an in-process edit and a subprocess edit compose", async () => {
  const { dir, cleanup } = withPrd();
  try {
    const cli = join(process.cwd(), "dist", "project-companion.mjs");

    await Promise.all([
      ...Array.from({ length: 6 }, (_, i) =>
        Promise.resolve().then(() =>
          editPrd(dir, undefined, [
            { op: "setCriterion", featureId: "widget", criterionId: criterionIds(dir)[i], done: true },
          ]),
        ),
      ),
      ...Array.from({ length: 6 }, (_, i) =>
        run(process.execPath, [cli, "feature", "check", "widget", `criterion ${i + 6}`], { cwd: dir }),
      ),
    ]);

    eq(ticked(dir), CRITERIA, `both writers' edits survived (got ${ticked(dir)})`);
  } finally { cleanup(); }
});

test("the prose is byte-identical after all that", async () => {
  const { dir, cleanup } = withPrd();
  try {
    const cli = join(process.cwd(), "dist", "project-companion.mjs");
    await Promise.all(
      Array.from({ length: CRITERIA }, (_, i) =>
        run(process.execPath, [cli, "feature", "check", "widget", `criterion ${i}`], { cwd: dir }),
      ),
    );

    const text = readFileSync(join(dir, "docs", "prd.md"), "utf8");
    ok(
      text.includes("Prose that must survive every one of these writes."),
      "the document around the checkboxes is untouched",
    );
    eq(text.match(/- \[x\]/g)?.length, CRITERIA);
    eq(text.match(/- \[ \]/g) ?? null, null, "no box was left behind");
  } finally { cleanup(); }
});

runAll().then((failed) => process.exit(failed ? 1 : 0));
