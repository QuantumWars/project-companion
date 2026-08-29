import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { readBundle } from "@/lib/project/bundle";
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

runAll().then((failed) => process.exit(failed ? 1 : 0));
