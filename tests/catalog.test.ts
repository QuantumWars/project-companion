import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BUNDLE_FILE } from "@/lib/project/bundle";
import { readEvents } from "@/lib/project/events";
import {
  createComponent, createDiagram, createTask, deleteComponent, deleteTask,
  initProject, moveTask, orphanComponent, readComponent, readComponents,
  readDiagram, trackNode, untrackNode, updateComponent, updateTask, writeDiagram,
} from "@/lib/project/store";
import { eq, ok, runAll, test, throws } from "./harness";

/** A real repository, because the log reads its actor out of git config. */
const project = (name = "Catalog") => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pc-catalog-")));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString();

  git("init", "-q", "-b", "main");
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "A Dev");
  git("config", "commit.gpgsign", "false");
  initProject(dir, name);

  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

const kinds = (dir: string) =>
  readEvents(dir).filter((e) => e.kind !== "actor.identified").map((e) => e.kind);

/* ------------------------------- persistence ------------------------------- */

test("a component lands in the one project file", () => {
  const { dir, cleanup } = project();
  try {
    const auth = createComponent(dir, {
      title: "Auth Service",
      owner: "grace@example.com",
      paths: ["lib/auth/**"],
    });

    eq(auth.id, "auth-service");
    eq(auth.lifecycle, "active", "components are active unless told otherwise");

    const raw = JSON.parse(readFileSync(join(dir, BUNDLE_FILE), "utf8"));
    eq(Object.keys(raw.components), ["auth-service"]);
    eq(readComponent(dir, "auth-service")?.owner, "grace@example.com");
  } finally { cleanup(); }
});

test("two components of the same name get distinct ids", () => {
  const { dir, cleanup } = project();
  try {
    const first = createComponent(dir, { title: "Gateway" });
    const second = createComponent(dir, { title: "Gateway" });
    ok(first.id !== second.id, "the second is suffixed rather than overwriting");
    eq(readComponents(dir).length, 2);
  } finally { cleanup(); }
});

test("the id is not patchable, because everything points at it", () => {
  const { dir, cleanup } = project();
  try {
    createComponent(dir, { title: "Auth Service" });
    const renamed = updateComponent(dir, "auth-service", {
      title: "Identity Service",
    } as never);

    eq(renamed?.id, "auth-service", "a rename is a title change, not a new identity");
    eq(renamed?.title, "Identity Service");
  } finally { cleanup(); }
});

test("patching an unknown component reports nothing rather than creating one", () => {
  const { dir, cleanup } = project();
  try {
    eq(updateComponent(dir, "nope", { owner: "x" }), null);
    eq(readComponents(dir).length, 0);
  } finally { cleanup(); }
});

/* -------------------------------- orphaning -------------------------------- */

test("losing the canvas node orphans the component, keeping the work", () => {
  const { dir, cleanup } = project();
  try {
    createComponent(dir, { title: "Auth", nodeId: "n1", diagramId: "arch", paths: ["lib/auth/**"] });
    createTask(dir, { title: "Rotate keys", status: "todo" });

    const orphaned = orphanComponent(dir, "auth");
    eq(orphaned?.orphaned, true);
    eq(orphaned?.nodeId, undefined, "the dead node reference is dropped");
    eq(orphaned?.paths, ["lib/auth/**"], "but the paths still attribute commits");
    ok(readComponent(dir, "auth"), "the component itself survives");
  } finally { cleanup(); }
});

test("deleting a component promotes its children rather than taking them with it", () => {
  const { dir, cleanup } = project();
  try {
    createComponent(dir, { title: "Platform" });
    createComponent(dir, { title: "API", parentId: "platform" });
    createComponent(dir, { title: "Handlers", parentId: "api" });

    eq(deleteComponent(dir, "api"), true);
    eq(readComponent(dir, "api"), null);
    eq(readComponent(dir, "handlers")?.parentId, "platform", "the grandchild is adopted");
  } finally { cleanup(); }
});

test("deleting a component that is not there is not an error", () => {
  const { dir, cleanup } = project();
  try {
    eq(deleteComponent(dir, "ghost"), false);
  } finally { cleanup(); }
});

test("a pre-bundle project is told to migrate rather than half-supported", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pc-catalog-legacy-")));
  try {
    // A store of the old shape: a directory, with no `.project` beside it.
    execFileSync("mkdir", ["-p", join(dir, ".claude", "project-companion")]);
    execFileSync("sh", [
      "-c",
      `printf '%s' '{"version":1,"name":"Old","createdAt":"2026-01-01T00:00:00.000Z","diagrams":[]}' > ${join(dir, ".claude", "project-companion", "project.json")}`,
    ]);

    eq(readComponents(dir), [], "reads report none rather than throwing");
    throws(
      () => createComponent(dir, { title: "Auth" }),
      /migrate/,
      "a write says exactly which command fixes it",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/* ---------------------------------- the log -------------------------------- */

test("creating a component is recorded, scoped to itself", () => {
  const { dir, cleanup } = project();
  try {
    createComponent(dir, { title: "Auth", owner: "grace", paths: ["lib/auth/**"] });

    const [event] = readEvents(dir).filter((e) => e.kind === "component.created");
    eq(event.componentId, "auth");
    eq(event.data.title, "Auth");
    eq(event.data.paths, ["lib/auth/**"]);
  } finally { cleanup(); }
});

test("a task's whole life is in the log, including its deletion", () => {
  const { dir, cleanup } = project();
  try {
    const task = createTask(dir, { title: "Rotate keys", status: "todo" });
    moveTask(dir, task.id, "in_progress");
    moveTask(dir, task.id, "done");
    deleteTask(dir, task.id);

    eq(kinds(dir), ["task.created", "task.moved", "task.moved", "task.deleted"]);

    const deleted = readEvents(dir).find((e) => e.kind === "task.deleted");
    eq(deleted?.data.title, "Rotate keys", "the title survives the card");
  } finally { cleanup(); }
});

test("a move that changes nothing is not an event", () => {
  const { dir, cleanup } = project();
  try {
    const task = createTask(dir, { title: "Stay put", status: "todo" });
    moveTask(dir, task.id, "todo");
    moveTask(dir, task.id, "todo");

    eq(kinds(dir), ["task.created"], "dragging a card back where it was is not history");
  } finally { cleanup(); }
});

test("a move records where it came from, so cycle time is measurable", () => {
  const { dir, cleanup } = project();
  try {
    const task = createTask(dir, { title: "Ship it", status: "todo" });
    moveTask(dir, task.id, "review");

    const moved = readEvents(dir).find((e) => e.kind === "task.moved");
    eq(moved?.data.from, "todo");
    eq(moved?.data.to, "review");
  } finally { cleanup(); }
});

test("an update logs which fields moved, not their contents", () => {
  const { dir, cleanup } = project();
  try {
    const task = createTask(dir, { title: "Draft", status: "todo" });
    updateTask(dir, task.id, { description: "Something private about a customer" });

    const updated = readEvents(dir).find((e) => e.kind === "task.updated");
    eq(updated?.data.changed, ["description"]);

    // The log is committed and pushed; prose must not leak into it.
    const shard = readFileSync(
      join(dir, ".project-log", readEvents(dir)[0].actor + ".jsonl"),
      "utf8",
    );
    ok(!shard.includes("customer"), "the description itself stays out of the log");
  } finally { cleanup(); }
});

test("a task carries its component into the log", () => {
  const { dir, cleanup } = project();
  try {
    createComponent(dir, { title: "Auth", paths: ["lib/auth/**"] });
    const task = createTask(dir, { title: "Rotate keys", status: "todo" });
    updateTask(dir, task.id, { componentId: "auth" });
    moveTask(dir, task.id, "done");

    const moved = readEvents(dir).find((e) => e.kind === "task.moved");
    eq(moved?.componentId, "auth", "the move lands on the component's timeline");
  } finally { cleanup(); }
});

test("the log never fails the write it is recording", () => {
  const { dir, cleanup } = project();
  try {
    // A log directory that cannot be written to: the task edit must still work.
    execFileSync("sh", ["-c", `mkdir -p ${join(dir, ".project-log")} && chmod 500 ${join(dir, ".project-log")}`]);
    const task = createTask(dir, { title: "Still works", status: "todo" });
    eq(task.title, "Still works");
    eq(moveTask(dir, task.id, "done")?.status, "done");
  } finally {
    execFileSync("sh", ["-c", `chmod 700 ${join(dir, ".project-log")} 2>/dev/null || true`]);
    cleanup();
  }
});

/* --------------------------- the canvas drives it -------------------------- */

const serviceNode = (id: string, label: string) =>
  ({ id, type: "service", position: { x: 0, y: 0 }, data: { kind: "service", label } }) as never;

const withCanvas = (dir: string, ...labels: string[]) => {
  const diagram = createDiagram(dir, "Architecture", "architecture");
  return writeDiagram(dir, {
    ...diagram,
    nodes: labels.map((l, i) => serviceNode(`n${i + 1}`, l)),
  });
};

test("a node is decorative until somebody says it is a component", () => {
  const { dir, cleanup } = project();
  try {
    withCanvas(dir, "API", "Database", "Cache");
    eq(readComponents(dir).length, 0, "three boxes, no components");
  } finally { cleanup(); }
});

test("tracking a node stamps it and creates the component at once", () => {
  const { dir, cleanup } = project();
  try {
    const diagram = withCanvas(dir, "Auth Service");
    const tracked = trackNode(dir, diagram.id, "n1", { owner: "grace", paths: ["lib/auth/**"] });

    eq(tracked?.id, "auth-service");
    eq(tracked?.nodeId, "n1");
    eq(tracked?.owner, "grace");

    const node = readDiagram(dir, diagram.id)!.nodes[0];
    eq((node.data as { componentId?: string }).componentId, "auth-service",
      "the node carries the id, so a later save reconciles instead of duplicating");
  } finally { cleanup(); }
});

test("tracking the same node twice returns what is there", () => {
  const { dir, cleanup } = project();
  try {
    const diagram = withCanvas(dir, "Auth");
    const first = trackNode(dir, diagram.id, "n1");
    const second = trackNode(dir, diagram.id, "n1", { owner: "someone else" });

    eq(first?.id, second?.id);
    eq(readComponents(dir).length, 1, "no second component");
  } finally { cleanup(); }
});

test("tracking a node that is not there reports nothing", () => {
  const { dir, cleanup } = project();
  try {
    const diagram = withCanvas(dir, "Auth");
    eq(trackNode(dir, diagram.id, "nope"), null);
    eq(readComponents(dir).length, 0);
  } finally { cleanup(); }
});

test("deleting the node on the canvas orphans the component, keeping its work", () => {
  const { dir, cleanup } = project();
  try {
    const diagram = withCanvas(dir, "Auth", "Billing");
    trackNode(dir, diagram.id, "n1", { paths: ["lib/auth/**"] });
    createTask(dir, { title: "Rotate keys", status: "todo", componentId: "auth" });

    // The canvas saves without that node -- somebody deleted the box.
    const current = readDiagram(dir, diagram.id)!;
    writeDiagram(dir, { ...current, nodes: current.nodes.filter((n) => n.id !== "n1") });

    const auth = readComponent(dir, "auth")!;
    eq(auth.orphaned, true);
    eq(auth.nodeId, undefined);
    eq(auth.paths, ["lib/auth/**"], "it still attributes commits");

    const events = readEvents(dir).filter((e) => e.kind === "component.orphaned");
    eq(events[0].data.via, "canvas");
  } finally { cleanup(); }
});

test("undoing that deletion restores the component rather than making a new one", () => {
  const { dir, cleanup } = project();
  try {
    const diagram = withCanvas(dir, "Auth");
    trackNode(dir, diagram.id, "n1", { paths: ["lib/auth/**"], owner: "grace" });

    const saved = readDiagram(dir, diagram.id)!;
    writeDiagram(dir, { ...saved, nodes: [] });
    eq(readComponent(dir, "auth")?.orphaned, true);

    writeDiagram(dir, saved);
    const back = readComponent(dir, "auth")!;
    eq(back.orphaned, undefined, "the flag is cleared, not set false");
    eq(back.nodeId, "n1");
    eq(back.owner, "grace", "and everything it owned came back with it");
    eq(readComponents(dir).length, 1);
  } finally { cleanup(); }
});

test("renaming the box on the canvas renames the component", () => {
  const { dir, cleanup } = project();
  try {
    const diagram = withCanvas(dir, "Auth");
    trackNode(dir, diagram.id, "n1");

    const current = readDiagram(dir, diagram.id)!;
    const renamed = current.nodes.map((n) => ({ ...n, data: { ...n.data, label: "Identity" } }));
    writeDiagram(dir, { ...current, nodes: renamed as never });

    eq(readComponent(dir, "auth")?.title, "Identity");
    eq(readComponent(dir, "auth")?.id, "auth", "but the id never moves");
  } finally { cleanup(); }
});

test("a diagram copied in from elsewhere heals its catalog", () => {
  const { dir, cleanup } = project();
  try {
    const diagram = createDiagram(dir, "Imported", "architecture");
    // Nodes already stamped, but this project has never seen the components.
    writeDiagram(dir, {
      ...diagram,
      nodes: [
        { id: "a", type: "service", position: { x: 0, y: 0 },
          data: { kind: "service", label: "Gateway", componentId: "gateway" } },
      ] as never,
    });

    const healed = readComponent(dir, "gateway")!;
    eq(healed.title, "Gateway");
    eq(healed.nodeId, "a");
    eq(readEvents(dir).find((e) => e.kind === "component.created")?.data.via, "canvas");
  } finally { cleanup(); }
});

test("untracking removes the stamp but keeps the work resolvable", () => {
  const { dir, cleanup } = project();
  try {
    const diagram = withCanvas(dir, "Auth");
    trackNode(dir, diagram.id, "n1", { paths: ["lib/auth/**"] });
    createTask(dir, { title: "Rotate keys", status: "todo", componentId: "auth" });

    untrackNode(dir, "auth");

    const node = readDiagram(dir, diagram.id)!.nodes[0];
    eq((node.data as { componentId?: string }).componentId, undefined, "the stamp is gone");
    eq(readComponent(dir, "auth")?.orphaned, true, "but the component survives");
    eq(readComponent(dir, "auth")?.paths, ["lib/auth/**"]);
  } finally { cleanup(); }
});

test("an ordinary autosave logs nothing, because it happens constantly", () => {
  const { dir, cleanup } = project();
  try {
    const diagram = withCanvas(dir, "Auth");
    trackNode(dir, diagram.id, "n1");
    const before = readEvents(dir).length;

    // Three saves that move a box without changing what exists.
    const saved = readDiagram(dir, diagram.id)!;
    for (let i = 0; i < 3; i++) {
      writeDiagram(dir, {
        ...saved,
        nodes: saved.nodes.map((n) => ({ ...n, position: { x: i * 10, y: 0 } })),
      });
    }

    eq(readEvents(dir).length, before, "dragging a box is not a catalog event");
  } finally { cleanup(); }
});

runAll().then((failed) => process.exit(failed ? 1 : 0));
