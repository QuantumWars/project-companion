/**
 * Quick spec ee3e8672: a run's attribution window ends when the run ends or
 * when its task first moves to `done`, whichever is first (RW-01.1 to RW-01.8).
 *
 * Window logic is tested with synthetic events and `attribute()`; the store,
 * cache and CLI behaviour use a temporary project and a temporary HOME (test
 * rules 2, 3, 5, 6 and 8).
 */

import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { ProjectEvent } from "@/lib/project/events";
import { readEvents } from "@/lib/project/events";
import type { GitCommit } from "@/lib/project/git";
import { attribute, linkRepository, type AttributableRun } from "@/lib/project/git-link";
import { readGitView } from "@/lib/project/git-view";
import { runsFrom } from "@/lib/project/run";
import {
  createTask,
  initProject,
  moveTask,
  readRuns,
  readTasks,
  reorderTask,
  reportRun,
  startRun,
} from "@/lib/project/store";
import type { Feature, Task } from "@/lib/project/types";
import { eq, ok, test, runAll } from "./harness";

const exec = promisify(execFile);
const CLI = join(process.cwd(), "dist", "project-companion.mjs");
const TIMEOUT = 10_000;
const FILE = "lib/auth/token.ts";

/* ------------------------------ synthetic data ----------------------------- */

let seq = 0;
const ev = (ts: number, kind: string, data: Record<string, unknown>): ProjectEvent => ({
  id: `a:${seq}`,
  ts,
  seq: seq++,
  actor: "a",
  prev: null,
  kind: kind as ProjectEvent["kind"],
  data,
});
const started = (ts: number, runId: string, taskId?: string) =>
  ev(ts, "run.started", { runId, taskId, actor: { kind: "agent" } });
const moved = (ts: number, taskId: string, from: string, to: string) =>
  ev(ts, "task.moved", { taskId, from, to });

const commit = (at: string, over: Partial<GitCommit> = {}): GitCommit => ({
  sha: "aaaaaaaaaaaa", short: "aaaaaaa", subject: "Do a thing", body: "",
  author: "A Dev", email: "dev@example.com", at,
  parents: [], refs: [], insertions: 1, deletions: 0,
  paths: [FILE], files: [{ path: FILE, insertions: 1, deletions: 0 }],
  ...over,
});
const aTask = (id = "t1"): Task => ({
  id, title: "Rotate keys", status: "in_progress",
  createdAt: "2026-09-01T08:00:00.000Z", updatedAt: "2026-09-01T08:00:00.000Z", order: 0,
});
const aRun = (over: Partial<AttributableRun> = {}): AttributableRun => ({
  id: "r1", taskId: "t1", touched: [FILE], startedAt: "2026-09-01T09:00:00.000Z", ...over,
});
const link = (c: GitCommit, runs: AttributableRun[], tasks: Task[] = [aTask()]) =>
  attribute([c], tasks, [] as Feature[], new Map(), runs).commits[0];

/* --------------------------- temporary repository -------------------------- */

const dirs: string[] = [];
const project = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pc-ee3e8672-")));
  const home = realpathSync(mkdtempSync(join(tmpdir(), "pc-ee3e8672-home-")));
  dirs.push(dir, home);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "A Dev");
  git("config", "commit.gpgsign", "false");
  const { CLAUDE_PROJECT_DIR: _d, ...base } = process.env;
  const env = { ...base, HOME: home, PROJECT_COMPANION_NOTIFY: "off" };
  const pc = (...args: string[]) =>
    exec(process.execPath, [CLI, ...args], { cwd: dir, env, timeout: TIMEOUT }).then((r) => r.stdout);
  const hook = (payload: Record<string, unknown>) =>
    new Promise<void>((resolve, reject) => {
      const child = execFile(process.execPath, [CLI, "ingest"], { cwd: dir, env, timeout: TIMEOUT }, (e) =>
        e ? reject(e) : resolve(),
      );
      child.stdin!.end(JSON.stringify(payload));
    });
  return { dir, home, git, pc, hook, env };
};
const cleanAll = () => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
};

/** A commit of FILE, authored `offsetMs` from now. */
const commitFile = (dir: string, git: (...a: string[]) => string, offsetMs: number, msg = "Rotate the token") => {
  mkdirSync(join(dir, "lib", "auth"), { recursive: true });
  writeFileSync(join(dir, FILE), `export const token = ${Math.random()};\n`);
  git("add", FILE);
  git("commit", "-q", "-m", msg, "--date", new Date(Date.now() + offsetMs).toISOString());
};

/** In-process project: a task in progress and a run that touched FILE. */
const inProcess = () => {
  const p = project();
  initProject(p.dir, "Demo");
  const task = createTask(p.dir, { title: "Rotate keys", status: "in_progress" });
  const run = startRun(p.dir, { taskId: task.id, sessionId: "s1" });
  reportRun(p.dir, run.id, { touched: [FILE] });
  return { ...p, taskId: task.id, runId: run.id };
};

/* --------------------------------- RW-01.1 -------------------------------- */

test("RW-01.1: taskDoneAt is the first done at or after the run's start", () => {
  const [run] = runsFrom([
    started(1000, "r1", "t1"),
    moved(500, "t1", "todo", "done"), // before the start: ignored
    moved(2000, "t1", "in_progress", "done"),
    moved(3000, "t1", "done", "review"),
    moved(4000, "t1", "review", "done"),
  ]);
  eq(run.taskDoneAt, new Date(2000).toISOString());
  eq(run.state, "running");
  eq(run.endedAt, undefined);
  eq(run.updatedAt, new Date(1000).toISOString());
});

test("RW-01.1: a done event that comes before run.started in the log still counts when timed after it", () => {
  const [run] = runsFrom([moved(2000, "t1", "in_progress", "done"), started(1000, "r1", "t1")]);
  eq(run.taskDoneAt, new Date(2000).toISOString());
});

/* --------------------------------- RW-01.2 -------------------------------- */

test("RW-01.2: a commit authored after taskDoneAt is not the run's; one at or before it is", () => {
  const run = aRun({ taskDoneAt: "2026-09-01T10:00:00.000Z" });
  eq(link(commit("2026-09-01T09:30:00.000Z"), [run]).signal, "run");
  eq(link(commit("2026-09-01T10:00:00.000Z"), [run]).signal, "run");
  eq(link(commit("2026-09-01T10:00:01.000Z"), [run]).signal, undefined);
  const withTrailer = commit("2026-09-01T10:30:00.000Z", { body: "archboard: abcd1234" });
  eq(link(withTrailer, [{ ...run, taskId: "abcd1234" }], [aTask("abcd1234")]).signal, "trailer");
});

test("RW-01.2: git log shows - for a commit after task move done", async () => {
  const p = project();
  try {
    await p.pc("init", "Demo");
    const out = await p.pc("task", "add", "Rotate keys", "--status", "in_progress");
    const taskId = /^Created (\S+)/.exec(out)?.[1]!;
    ok(taskId, `no task id in ${out}`);
    await p.pc("run", "start", taskId, "--session", "s1");
    await p.hook({
      session_id: "s1", hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: FILE },
    });
    commitFile(p.dir, p.git, 60_000);

    const signalOf = async () => {
      const log = await p.pc("git", "log");
      const line = log.split("\n").find((l) => l.includes("Rotate the token"));
      ok(line, `no line for the commit in:\n${log}`);
      return line!.trim().split(/\s+/)[1];
    };
    eq(await signalOf(), "run", "control: before the move the open run owns the commit");
    await p.pc("task", "move", taskId, "done");
    eq(await signalOf(), "-", "after the move the run's window is closed");
  } finally {
    cleanAll();
  }
});

/* --------------------------------- RW-01.3 -------------------------------- */

test("RW-01.3: a reopened task keeps the first done time", () => {
  const events = [
    started(1000, "r1", "t1"),
    moved(2000, "t1", "in_progress", "done"),
    moved(3000, "t1", "done", "in_progress"),
  ];
  const [run] = runsFrom(events);
  eq(run.taskDoneAt, new Date(2000).toISOString());
  // Still closed: a commit after the first done time is not the run's.
  const runs = runsFrom(events).map((r) => ({ ...r, touched: [FILE] }));
  eq(link(commit(new Date(5000).toISOString()), runs).signal, undefined);
});

test("RW-01.3: a new run after reopen gets its own commits", () => {
  const runs = runsFrom([
    started(1000, "r1", "t1"),
    moved(2000, "t1", "in_progress", "done"),
    moved(3000, "t1", "done", "in_progress"),
    started(4000, "r2", "t1"),
  ]).map((r) => ({ ...r, touched: [FILE] }));
  const linked = link(commit(new Date(5000).toISOString()), runs);
  eq(linked.signal, "run");
  eq(runs.find((r) => r.id === "r2")!.taskDoneAt, undefined);
});

test("RW-01.1: a done event with a bad ts is ignored and runsFrom does not throw", () => {
  const badNumber = moved(1e20, "t1", "in_progress", "done"); // outside the Date range
  const badString = { ...moved(2000, "t1", "in_progress", "done"), ts: "2000" as unknown as number };
  const [run] = runsFrom([started(1000, "r1", "t1"), badNumber, badString]);
  eq(run.taskDoneAt, undefined);
  eq(run.state, "running");
  // A good event next to the bad ones still counts.
  const [ok2] = runsFrom([started(1000, "r1", "t1"), badNumber, moved(3000, "t1", "in_progress", "done")]);
  eq(ok2.taskDoneAt, new Date(3000).toISOString());
});

/* --------------------------------- RW-01.4 -------------------------------- */

test("RW-01.4: the earlier of endedAt and taskDoneAt ends the window", () => {
  const T = (m: number) => `2026-09-01T10:${String(m).padStart(2, "0")}:00.000Z`;
  const doneFirst = aRun({ taskDoneAt: T(10), endedAt: T(30) });
  eq(link(commit(T(5)), [doneFirst]).signal, "run");
  eq(link(commit(T(20)), [doneFirst]).signal, undefined, "done came first");
  const endedFirst = aRun({ taskDoneAt: T(30), endedAt: T(10) });
  eq(link(commit(T(5)), [endedFirst]).signal, "run");
  eq(link(commit(T(20)), [endedFirst]).signal, undefined, "the run ended first");
});

/* --------------------------------- RW-01.5 -------------------------------- */

test("RW-01.5: no taskId, or no done, keeps today's window", () => {
  const late = commit("2030-01-01T00:00:00.000Z");
  eq(link(late, [aRun()]).signal, "run", "an open run with no done is open forever");
  eq(link(late, [aRun({ taskId: undefined })]).signal, undefined, "no taskId: never attributed by run");

  // The task was already done before the run started: no taskDoneAt, the run stays open.
  const [run] = runsFrom([moved(500, "t1", "todo", "done"), started(1000, "r1", "t1")]);
  eq(run.taskDoneAt, undefined);
  // A run with no task never gets one, whatever else is done.
  const [other] = runsFrom([started(1000, "r2"), moved(2000, "t9", "todo", "done")]);
  eq(other.taskDoneAt, undefined);
});

/* --------------------------------- RW-01.6 -------------------------------- */

test("RW-01.6: reorderTask to another column appends task.moved", () => {
  const p = inProcess();
  try {
    const movedEvents = () => readEvents(p.dir).filter((e) => e.kind === "task.moved");
    eq(movedEvents().length, 0);

    reorderTask(p.dir, p.taskId, "done", 0);
    eq(movedEvents().length, 1);
    eq(readEvents(p.dir).at(-1)!.kind, "task.moved");
    eq(readEvents(p.dir).at(-1)!.data, { taskId: p.taskId, from: "in_progress", to: "done" });

    reorderTask(p.dir, p.taskId, "done", 0); // same column: nothing
    eq(movedEvents().length, 1);

    ok(readRuns(p.dir).find((r) => r.id === p.runId)!.taskDoneAt, "the run learned its task is done");
    eq(reorderTask(p.dir, "nope", "done", 0), null);
  } finally {
    cleanAll();
  }
});

/* --------------------------------- RW-01.7 -------------------------------- */

test("RW-01.7: moving the task to done turns over the Git view cache", async () => {
  const p = inProcess();
  try {
    commitFile(p.dir, p.git, 60_000);
    const cache = join(p.dir, ".project-cache", "git.json");
    const print = () => (JSON.parse(readFileSync(cache, "utf8")) as { fingerprint: string }).fingerprint;
    const signal = async () => {
      const view = await readGitView(p.dir, []);
      ok(view.available, "git view available");
      return view.attribution!.commits.find((c) => c.subject === "Rotate the token")?.signal;
    };

    eq(await signal(), "run");
    const before = print();
    moveTask(p.dir, p.taskId, "done");
    // No new commit and no refresh, so only the run side of the key can change.
    eq(await signal(), undefined, "a stale cache would still say run");
    ok(print() !== before, "the cache fingerprint changed");
  } finally {
    cleanAll();
  }
});

/* --------------------------------- RW-01.8 -------------------------------- */

test("RW-01.8: reading attribution writes nothing to .project or .project-log", async () => {
  const p = inProcess();
  try {
    commitFile(p.dir, p.git, 60_000);
    moveTask(p.dir, p.taskId, "done");

    const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
    const hashes = () => {
      const out: Record<string, string> = { ".project": sha(join(p.dir, ".project")) };
      for (const f of readdirSync(join(p.dir, ".project-log")).sort()) {
        out[f] = sha(join(p.dir, ".project-log", f));
      }
      return out;
    };
    const before = hashes();
    ok(Object.keys(before).length > 1, "there is a log shard to compare");

    await p.pc("git", "log");
    await p.pc("git", "unlinked");
    await linkRepository(p.dir, readTasks(p.dir).tasks, [], 50, readRuns(p.dir));
    await readGitView(p.dir, [], { refresh: true });
    eq(hashes(), before);
  } finally {
    cleanAll();
  }
});

runAll().then((failed) => {
  cleanAll();
  process.exit(failed ? 1 : 0);
});
