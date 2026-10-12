/**
 * Regression test for bug 37f9fbce: the CLI's `git log` and `git unlinked`
 * never attribute commits to agent runs.
 *
 * `project-companion git log`/`git unlinked` (`cli/index.ts`, `runGit`) call
 *
 *   linkRepository(repo, tasks, features, limit)
 *
 * with no fifth argument. Only the app's Git view (`lib/project/git-view.ts`)
 * passes `runs`:
 *
 *   linkRepository(repo, tasks, features, options.limit, runs)
 *
 * `linkRepository` (`lib/project/git-link.ts`) defaults `runs` to `[]`, so the
 * CLI never even attempts signal 2 of `run-attribution` (`docs/prd.md`, id
 * `run-attribution`) -- not "runs but finds no match", but "never tries".
 *
 * This is deliberately independent of bug 15753492 (a run's `touched` paths
 * are stored as absolute paths, so they can never match a commit's relative
 * ones even when runs ARE passed). The fixture below feeds the run a `touched`
 * path that is already relative to the project root -- the form 15753492's
 * fix produces -- by giving the `ingest` hook a `tool_input.file_path` that is
 * already relative, rather than the absolute one a real harness sends. So the
 * only thing left standing between the run and the commit is this bug: the
 * CLI passing no runs at all. The first test below is the control: it calls
 * `linkRepository` directly WITH the same runs (the exact call `git-view.ts`
 * makes) and shows the match succeeds, proving the fixture is sound.
 */

import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { linkRepository } from "@/lib/project/git-link";
import { readRuns, readTasks } from "@/lib/project/store";
import { eq, ok, test, runAll } from "./harness";

const run = promisify(execFile);
const CLI = join(process.cwd(), "dist", "project-companion.mjs");

const repo = () => {
  // A temporary project and git repository, never the real .project /
  // .project-log of this repository.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pc-37f9fbce-")));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "A Dev");
  git("config", "commit.gpgsign", "false");
  return { dir, git, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

const pc = (dir: string, ...args: string[]) =>
  run(process.execPath, [CLI, ...args], { cwd: dir }).then((r) => r.stdout);

/** One `ingest` hook payload, piped to the real CLI process on stdin. */
const hook = (dir: string, payload: Record<string, unknown>) =>
  new Promise<void>((resolve) => {
    const child = execFile(process.execPath, [CLI, "ingest"], { cwd: dir }, () => resolve());
    child.stdin!.end(JSON.stringify(payload));
  });

/**
 * A task, a run against it (touching a path already relative to the project
 * root), and a commit that changes that same path. Every step but the last
 * two goes through the real CLI, the same way a user or a harness would.
 */
const fixture = async (dir: string, git: (...args: string[]) => string) => {
  await pc(dir, "init", "Demo");

  const createdTask = await pc(dir, "task", "add", "Rotate keys", "--status", "in_progress");
  const taskId = /^Created (\S+)/.exec(createdTask)?.[1];
  if (!taskId) throw new Error(`could not parse a task id from: ${createdTask}`);

  const startedRun = await pc(dir, "run", "start", taskId, "--session", "s1");
  if (!/^Run \S+/.test(startedRun)) throw new Error(`could not start a run from: ${startedRun}`);

  // The harness's own PostToolUse hook -- but with a path already relative to
  // the project root, the form bug 15753492's fix produces for a real
  // harness's absolute one. This sidesteps that bug entirely, so this test
  // can fail for only this bug's reason.
  await hook(dir, {
    session_id: "s1",
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: "lib/auth/token.ts" },
  });

  // A commit that changes the very file the run just touched, safely after
  // the run started (git's author date truncates to the second; the run's
  // startedAt carries milliseconds, so the margin keeps the window check
  // honest rather than flaky).
  mkdirSync(join(dir, "lib", "auth"), { recursive: true });
  writeFileSync(join(dir, "lib", "auth", "token.ts"), "export const token = 1;\n");
  git("add", "lib/auth/token.ts");
  const after = new Date(Date.now() + 60_000).toISOString();
  git("commit", "-q", "-m", "Rotate the token", "--date", after);

  return { taskId };
};

test("37f9fbce (control): linkRepository WITH runs attributes the commit, same as the app's Git view", async () => {
  const { dir, git, cleanup } = repo();
  try {
    const { taskId } = await fixture(dir, git);

    const runs = readRuns(dir);
    eq(
      runs[0]?.touched,
      ["lib/auth/token.ts"],
      "the fixture's run already holds a path relative to the project root -- the form 15753492's fix produces",
    );

    // The exact call lib/project/git-view.ts:87 makes for the app's Git view.
    const linked = await linkRepository(dir, readTasks(dir).tasks, [], 50, runs);
    const commit = linked.commits.find((c) => c.subject === "Rotate the token");

    eq(commit?.signal, "run", "a run that touched this exact (relative) path, inside its open window, must be the match");
    eq(commit?.taskId, taskId, "and the commit must attribute to that run's task");
  } finally {
    cleanup();
  }
});

test("37f9fbce: `project-companion git log` never shows the run signal -- the CLI passes no runs", async () => {
  const { dir, git, cleanup } = repo();
  try {
    await fixture(dir, git);

    const out = await pc(dir, "git", "log");
    const line = out.split("\n").find((l) => l.includes("Rotate the token"));
    ok(line, `no line for the commit in:\n${out}`);

    const signal = line!.trim().split(/\s+/)[1];
    eq(signal, "run", "cli/index.ts's runGit calls linkRepository with no runs, so signal 2 never fires");
  } finally {
    cleanup();
  }
});

test("37f9fbce: `project-companion git unlinked` must not list a commit a run already covers", async () => {
  const { dir, git, cleanup } = repo();
  try {
    await fixture(dir, git);

    const out = await pc(dir, "git", "unlinked");
    ok(
      !out.includes("Rotate the token"),
      `the commit should be attributed by the run and so absent from \`git unlinked\`, but it was listed:\n${out}`,
    );
  } finally {
    cleanup();
  }
});

runAll().then((failed) => process.exit(failed ? 1 : 0));
