import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readBundle, writeBundle } from "@/lib/project/bundle";
import { attribute, type AttributableRun } from "@/lib/project/git-link";
import type { GitCommit } from "@/lib/project/git";
import type { Feature, Task } from "@/lib/project/types";
import {
  createComponent, createTask, initProject, readRun, readRuns, reportRun,
  resolvePolicy, setRunState, startRun,
} from "@/lib/project/store";
import { eq, ok, runAll, test, throws } from "./harness";

const project = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pc-run-")));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "A Dev");
  initProject(dir, "Runs");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

/** Agent policy lives in the bundle; there is no CLI for it yet. */
const setPolicy = (dir: string, agents: NonNullable<ReturnType<typeof readBundle>>["agents"]) => {
  const bundle = readBundle(dir)!;
  writeBundle(dir, { ...bundle, agents }, bundle.revision);
};

/* -------------------------------- policy ---------------------------------- */

test("an agent asks permission unless somebody said otherwise", () => {
  const { dir, cleanup } = project();
  try {
    eq(resolvePolicy(dir).autonomy, "confirm", "the safest setting is the one nobody has to choose");
  } finally { cleanup(); }
});

test("a component's policy overrides the project's", () => {
  const { dir, cleanup } = project();
  try {
    createComponent(dir, { title: "Utils", paths: ["lib/utils/**"] });
    createComponent(dir, { title: "Billing", paths: ["lib/billing/**"] });
    setPolicy(dir, {
      default: { autonomy: "confirm", budget: { tokens: 1000 } },
      byComponent: { utils: { autonomy: "autonomous" }, billing: { budget: { tokens: 50 } } },
    });

    eq(resolvePolicy(dir, "utils").autonomy, "autonomous");
    eq(resolvePolicy(dir, "billing").autonomy, "confirm", "billing keeps the default");
    eq(resolvePolicy(dir, "billing").budget?.tokens, 50, "but its own ceiling");
    eq(resolvePolicy(dir, "utils").budget?.tokens, 1000, "and utils keeps the default ceiling");
  } finally { cleanup(); }
});

test("the boundary defaults to the component's own paths", () => {
  const { dir, cleanup } = project();
  try {
    createComponent(dir, { title: "Auth", paths: ["lib/auth/**", "app/login/**"] });
    eq(resolvePolicy(dir, "auth").writeGlobs, ["lib/auth/**", "app/login/**"],
      "one declaration, used for attribution and for the boundary");
  } finally { cleanup(); }
});

/* --------------------------------- runs ----------------------------------- */

test("a run inherits its constraints from the work it picks up", () => {
  const { dir, cleanup } = project();
  try {
    createComponent(dir, { title: "Auth", paths: ["lib/auth/**"] });
    setPolicy(dir, { byComponent: { auth: { autonomy: "confirm", budget: { tokens: 500 } } } });
    const task = createTask(dir, { title: "Rotate keys", status: "todo", componentId: "auth" });

    // Only the task id is given; everything else follows from it.
    const run = startRun(dir, { taskId: task.id, actor: { model: "claude-opus-5" } });
    eq(run.componentId, "auth");
    eq(run.budget.tokens, 500);
    eq(run.writeGlobs, ["lib/auth/**"]);
    eq(run.state, "running");
  } finally { cleanup(); }
});

test("a run is derived from the log, not stored in the project", () => {
  const { dir, cleanup } = project();
  try {
    const run = startRun(dir, { actor: { model: "m" } });
    eq(readBundle(dir)!.components, {}, "nothing about the run is in the bundle");
    eq(readRun(dir, run.id)?.id, run.id, "and it still reads back");
  } finally { cleanup(); }
});

test("spending is recorded and totalled", () => {
  const { dir, cleanup } = project();
  try {
    const run = startRun(dir, { actor: { model: "m" } });
    reportRun(dir, run.id, { inputTokens: 100, outputTokens: 40, toolCalls: 1, touched: ["a.ts"] });
    const result = reportRun(dir, run.id, { inputTokens: 60, toolCalls: 1, touched: ["b.ts"] })!;

    eq(result.run.spent.inputTokens, 160);
    eq(result.run.spent.toolCalls, 2);
    eq(result.run.touched, ["a.ts", "b.ts"]);
    ok(result.verdict.ok);
  } finally { cleanup(); }
});

test("going over budget blocks the run rather than throwing at the agent", () => {
  const { dir, cleanup } = project();
  try {
    const run = startRun(dir, { actor: { model: "m" }, budget: { tokens: 100 } });
    const result = reportRun(dir, run.id, { inputTokens: 150 })!;

    eq(result.verdict.ok, false);
    eq(result.verdict.exceeded, "tokens");
    eq(result.run.state, "blocked", "recoverable, not fatal");
    ok(result.run.reason?.includes("Budget exhausted"), result.run.reason);
  } finally { cleanup(); }
});

test("a blocked run resumes once somebody raises the ceiling", () => {
  const { dir, cleanup } = project();
  try {
    const run = startRun(dir, { actor: { model: "m" }, budget: { tokens: 10 } });
    reportRun(dir, run.id, { inputTokens: 50 });
    eq(readRun(dir, run.id)?.state, "blocked");

    eq(setRunState(dir, run.id, "running", "Ceiling raised.")?.state, "running");
  } finally { cleanup(); }
});

test("a write outside the boundary is refused and reported, not silently dropped", () => {
  const { dir, cleanup } = project();
  try {
    createComponent(dir, { title: "Auth", paths: ["lib/auth/**"] });
    const run = startRun(dir, { componentId: "auth", actor: { model: "m" } });

    const result = reportRun(dir, run.id, {
      touched: ["lib/auth/token.ts", "lib/billing/invoice.ts"],
    })!;

    eq(result.refused, ["lib/billing/invoice.ts"], "the caller is told which");
    eq(result.run.touched, ["lib/auth/token.ts"], "and it is not counted as work here");
  } finally { cleanup(); }
});

test("an unscoped run may touch anything, because scoping it to nothing helps nobody", () => {
  const { dir, cleanup } = project();
  try {
    const run = startRun(dir, { actor: { model: "m" } });
    const result = reportRun(dir, run.id, { touched: ["anywhere.ts"] })!;
    eq(result.refused, []);
    eq(result.run.touched, ["anywhere.ts"]);
  } finally { cleanup(); }
});

test("an illegal transition is refused before it is written", () => {
  const { dir, cleanup } = project();
  try {
    const run = startRun(dir, { actor: { model: "m" } });
    throws(
      () => setRunState(dir, run.id, "merged"),
      /running run cannot become merged/,
      "work does not merge without review",
    );
    eq(readRun(dir, run.id)?.state, "running", "and the log is unchanged");
  } finally { cleanup(); }
});

test("the whole lifecycle round-trips", () => {
  const { dir, cleanup } = project();
  try {
    const run = startRun(dir, { actor: { model: "m" } });
    reportRun(dir, run.id, { inputTokens: 10, toolCalls: 1, touched: ["x.ts"] });
    setRunState(dir, run.id, "awaiting_review");
    const merged = setRunState(dir, run.id, "merged")!;

    eq(merged.state, "merged");
    ok(merged.endedAt, "it knows when it ended");
    eq(readRuns(dir).length, 1);
  } finally { cleanup(); }
});

test("reporting against a run that does not exist is nothing, not a crash", () => {
  const { dir, cleanup } = project();
  try {
    eq(reportRun(dir, "nope", { inputTokens: 1 }), null);
    eq(setRunState(dir, "nope", "blocked"), null);
  } finally { cleanup(); }
});

test("several runs coexist, newest first", () => {
  const { dir, cleanup } = project();
  try {
    const a = startRun(dir, { actor: { model: "m" } });
    const b = startRun(dir, { actor: { model: "m" } });
    eq(readRuns(dir).map((r) => r.id), [b.id, a.id]);
  } finally { cleanup(); }
});

/* --------------------------- the run as a signal --------------------------- */

/**
 * A run is the second-strongest attribution signal, and the one that finally
 * makes this work without the trailer convention -- which this repository
 * documented from the start and never once used until three weeks ago.
 */

const commit = (over: Partial<GitCommit> = {}): GitCommit => ({
  sha: "aaaaaaaaaaaa", short: "aaaaaaa", subject: "Do a thing", body: "",
  author: "A Dev", email: "dev@example.com",
  at: "2026-09-01T10:00:00.000Z",
  parents: [], refs: [], insertions: 10, deletions: 1,
  paths: ["lib/auth/token.ts"],
  files: [{ path: "lib/auth/token.ts", insertions: 10, deletions: 1 }],
  ...over,
});

const aRun = (over: Partial<AttributableRun> = {}): AttributableRun => ({
  id: "r1",
  taskId: "task-1",
  touched: ["lib/auth/token.ts"],
  startedAt: "2026-09-01T09:00:00.000Z",
  endedAt: "2026-09-01T11:00:00.000Z",
  ...over,
});

const task = (over: Partial<Task> = {}): Task => ({
  id: "task-1", title: "Rotate keys", status: "in_progress",
  createdAt: "2026-09-01T08:00:00.000Z", updatedAt: "2026-09-01T08:00:00.000Z",
  order: 0, ...over,
});

const link = (commits: GitCommit[], runs: AttributableRun[], tasks: Task[] = [task()]) =>
  attribute(commits, tasks, [] as Feature[], new Map(), runs).commits[0];

test("a commit of files a run was watched writing belongs to that run's task", () => {
  const linked = link([commit()], [aRun()]);
  eq(linked.signal, "run");
  eq(linked.taskId, "task-1");
});

test("a commit before the run started is not the run's", () => {
  const linked = link([commit({ at: "2026-09-01T08:30:00.000Z" })], [aRun()]);
  eq(linked.signal, undefined, "an agent cannot have written what was committed before it began");
});

test("a commit after the run ended is not the run's either", () => {
  const linked = link([commit({ at: "2026-09-01T12:00:00.000Z" })], [aRun()]);
  eq(linked.signal, undefined);
});

test("an open run has no end, so it can still be producing commits", () => {
  const linked = link([commit({ at: "2032-01-01T00:00:00.000Z" })], [aRun({ endedAt: undefined })]);
  eq(linked.signal, "run");
});

test("overlapping in time is not enough without overlapping in files", () => {
  const linked = link([commit({ paths: ["docs/readme.md"], files: [] })], [aRun()]);
  eq(linked.signal, undefined, "a window alone catches every unrelated commit");
});

test("two runs that both touched the file attribute to neither", () => {
  const linked = link([commit()], [aRun(), aRun({ id: "r2", taskId: "task-2" })]);
  eq(linked.signal, undefined, "the parallel-agent case must not guess");
});

test("a recorded sha still outranks a run", () => {
  const linked = link([commit()], [aRun({ taskId: "task-2" })], [
    task({ id: "task-1", commits: ["aaaaaaaaaaaa"] }),
    task({ id: "task-2" }),
  ]);
  eq(linked.signal, "recorded", "somebody typing the sha beats an observation");
  eq(linked.taskId, "task-1");
});

test("a run outranks a trailer, because it was observed rather than declared", () => {
  const linked = link(
    [commit({ body: "project-companion: task-2" })],
    [aRun({ taskId: "task-1" })],
    [task({ id: "task-1" }), task({ id: "task-2" })],
  );
  eq(linked.signal, "run");
  eq(linked.taskId, "task-1");
});

test("a run with no task attributes nothing, since a run is not a unit of work", () => {
  const linked = link([commit()], [aRun({ taskId: undefined })]);
  eq(linked.signal, undefined);
});

test("a run that touched nothing cannot claim a commit", () => {
  const linked = link([commit()], [aRun({ touched: [] })]);
  eq(linked.signal, undefined);
});

runAll().then((failed) => process.exit(failed ? 1 : 0));
