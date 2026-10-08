import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BUNDLE_FILE, BundleConflictError, readBundle, writeBundle } from "@/lib/project/bundle";
import {
  createDiagram, createTask, createWhiteboard, deleteDiagram, deleteProject,
  deleteWhiteboard,
  findProject, initProject, listDiagrams, migrateProject, readDiagram,
  readProject, readTasks, writeDiagram,
} from "@/lib/project/store";
import { setPhase } from "@/lib/project/roadmap";
import { eq, ok, runAll, test, throws } from "./harness";

const repo = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pc-bundle-")));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

test("a new project is a single .project file", () => {
  const { dir, cleanup } = repo();
  try {
    initProject(dir, "Solo");
    ok(existsSync(join(dir, BUNDLE_FILE)), ".project exists");
    ok(!existsSync(join(dir, ".claude")), "no split store is created");
    eq(findProject(dir)?.storeDir, BUNDLE_FILE);
    eq(readProject(dir).name, "Solo");
  } finally { cleanup(); }
});

test("everything the project owns lives in that one file", () => {
  const { dir, cleanup } = repo();
  try {
    initProject(dir, "All in one");
    const diagram = createDiagram(dir, "Architecture", "architecture");
    createWhiteboard(dir, "Sketches");
    createTask(dir, { title: "Do the thing", status: "todo" });
    setPhase(dir, { id: "phase-1", name: "First", status: "active" });

    writeDiagram(dir, {
      ...diagram,
      nodes: [{ id: "n1", type: "service", position: { x: 0, y: 0 }, data: { kind: "service", label: "API" } }] as never,
    });

    const raw = JSON.parse(readFileSync(join(dir, BUNDLE_FILE), "utf8"));
    eq(Object.keys(raw.diagrams), ["architecture"]);
    eq(Object.keys(raw.boards), ["sketches"]);
    eq(raw.tasks.length, 1);
    eq(raw.roadmap.phases.length, 1);
    ok(raw.diagrams.architecture.nodes.length === 1, "diagram contents are inside the file");

    // And it all reads back through the ordinary API.
    eq(listDiagrams(dir).length, 2);
    eq(readDiagram(dir, "architecture")!.nodes.length, 1);
    eq(readTasks(dir).tasks.length, 1);
  } finally { cleanup(); }
});

test("a stale write is refused rather than silently winning", () => {
  const { dir, cleanup } = repo();
  try {
    initProject(dir, "Racy");
    const first = readBundle(dir)!;

    // Another writer gets there first.
    writeBundle(dir, { ...first, name: "Renamed by someone else" }, first.revision);

    throws(
      () => writeBundle(dir, { ...first, name: "Mine" }, first.revision),
      /changed on disk/,
      "the second write must not clobber the first",
    );
    eq(readBundle(dir)!.name, "Renamed by someone else");
  } finally { cleanup(); }
});

test("deleting a diagram unlinks the tasks that pointed at it", () => {
  const { dir, cleanup } = repo();
  try {
    initProject(dir, "Cascade");
    const d = createDiagram(dir, "Doomed", "architecture");
    const t = createTask(dir, { title: "Linked", status: "todo", diagramId: d.id });
    eq(readTasks(dir).tasks.find((x) => x.id === t.id)!.diagramId, d.id);

    deleteDiagram(dir, d.id);
    const after = readTasks(dir).tasks.find((x) => x.id === t.id)!;
    eq(after.diagramId, undefined, "the dangling link is cleared");
    ok(after.title === "Linked", "but the task survives -- the work was still real");
  } finally { cleanup(); }
});

test("deleting the project removes the file and nothing else", () => {
  const { dir, cleanup } = repo();
  try {
    initProject(dir, "Doomed");
    createDiagram(dir, "One", "architecture");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "app.ts"), "// keep\n", "utf8");

    const summary = deleteProject(dir);
    ok(summary !== null, "reports what went");
    eq(summary!.diagrams, 1);
    ok(!existsSync(join(dir, BUNDLE_FILE)), ".project is gone");
    ok(existsSync(join(dir, "src", "app.ts")), "source is untouched");
  } finally { cleanup(); }
});

test("a pre-bundle project still opens, and migrates without loss", () => {
  const { dir, cleanup } = repo();
  try {
    // Hand-build the old split layout.
    const store = join(dir, ".claude", "project-companion");
    mkdirSync(join(store, "diagrams"), { recursive: true });
    mkdirSync(join(store, "boards"), { recursive: true });
    writeFileSync(join(store, "project.json"), JSON.stringify({
      version: 1, name: "Legacy", createdAt: "2026-01-01T00:00:00.000Z",
      diagrams: [
        { id: "arch", title: "Arch", type: "architecture", updatedAt: "2026-01-01T00:00:00.000Z" },
        { id: "sketch", title: "Sketch", type: "architecture", kind: "whiteboard", updatedAt: "2026-01-01T00:00:00.000Z" },
      ],
    }), "utf8");
    writeFileSync(join(store, "diagrams", "arch.json"), JSON.stringify({
      version: 1, id: "arch", title: "Arch", type: "architecture",
      updatedAt: "2026-01-01T00:00:00.000Z",
      nodes: [{ id: "n1", type: "service", position: { x: 1, y: 2 }, data: { kind: "service", label: "Keep me" } }],
      edges: [],
    }), "utf8");
    writeFileSync(join(store, "boards", "sketch.json"), JSON.stringify({
      version: 1, id: "sketch", title: "Sketch", updatedAt: "2026-01-01T00:00:00.000Z",
      layerIds: ["l1"], layers: [["l1", { type: 0, x: 0, y: 0, width: 10, height: 10, fill: { r: 0, g: 0, b: 0 } }]],
    }), "utf8");
    writeFileSync(join(store, "tasks.json"), JSON.stringify({
      version: 1, tasks: [{ id: "aaaa1111", title: "Old task", status: "todo",
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", order: 0 }],
    }), "utf8");

    // It opens unchanged.
    eq(findProject(dir)?.storeDir, ".claude/project-companion");
    eq(readProject(dir).name, "Legacy");
    eq(listDiagrams(dir).length, 2);

    const result = migrateProject(dir);
    ok(result !== null, "migration ran");
    eq(result!.diagrams, 1);
    eq(result!.boards, 1);
    eq(result!.tasks, 1);

    // Now a bundle, with everything intact.
    eq(findProject(dir)?.storeDir, BUNDLE_FILE);
    ok(!existsSync(store), "the old store directory is gone");
    eq(readProject(dir).name, "Legacy");
    eq(readDiagram(dir, "arch")!.nodes[0].data.label, "Keep me");
    eq(readTasks(dir).tasks[0].title, "Old task");
    eq(listDiagrams(dir).length, 2);
  } finally { cleanup(); }
});

test("migrating an already-bundled project is a no-op", () => {
  const { dir, cleanup } = repo();
  try {
    initProject(dir, "Modern");
    eq(migrateProject(dir), null);
  } finally { cleanup(); }
});

test("deleting a whiteboard unlinks its tasks, exactly as a diagram does", () => {
  const { dir, cleanup } = repo();
  try {
    initProject(dir, "Symmetry");
    const board = createWhiteboard(dir, "Sketches");
    const task = createTask(dir, { title: "Sketch the flow", status: "todo", diagramId: board.id });

    eq(readTasks(dir).tasks[0].diagramId, board.id);
    ok(deleteWhiteboard(dir, board.id), "the board is gone");

    const after = readTasks(dir).tasks.find((t) => t.id === task.id)!;
    eq(after.diagramId, undefined, "the dangling link is dropped");
    eq(after.title, "Sketch the flow", "but the work survives the drawing");
  } finally { cleanup(); }
});

runAll().then((failed) => process.exit(failed ? 1 : 0));
