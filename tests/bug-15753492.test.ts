/**
 * Regression test for bug 15753492: a run never links to the commit that
 * changed the same file it wrote.
 *
 * The harness's own hook payload names the file it wrote with an absolute
 * path -- that is what Claude Code's `tool_input.file_path` always is, and
 * `writtenPaths` (`lib/project/ingest.ts`) passes it through unchanged. The
 * `ingest` command (`cli/index.ts`, the `tool.use` branch) hands that straight
 * to `reportRun` (`lib/project/store.ts`), which logs it on the run's
 * `run.progress` event, so `run.touched` ends up holding a full path such as
 * `/Users/.../project/lib/auth/token.ts`.
 *
 * `git-link.ts`'s `runFor` (about line 152) then asks whether
 * `commit.paths.some((path) => run.touched.includes(path))`. `commit.paths`
 * comes from `git log --numstat`, which is always relative to the repository
 * root -- `lib/auth/token.ts`, never the absolute form. An absolute string is
 * never equal to a relative one, so the `.includes` check fails for every run,
 * every time, and signal 2 of `commit-attribution`/`run-attribution`
 * (`docs/prd.md`, id `run-attribution`) never fires.
 *
 * This test drives the exact two call sites named in the bug report --
 * `reportRun` with the harness's own (absolute) `touched` list, then
 * `linkRepository` with the runs `readRuns` folds back out of the log, the
 * same two calls `cli/index.ts` and `lib/project/git-view.ts` make -- against
 * a real git repository, so it fails on the present code for the reason the
 * bug names rather than on a synthetic shortcut.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { linkRepository } from "@/lib/project/git-link";
import { parseHook } from "@/lib/project/ingest";
import { createTask, initProject, readRuns, readTasks, reportRun, startRun } from "@/lib/project/store";
import { eq, test, runAll } from "./harness";

const project = () => {
  // A temporary project, never the real .project / .project-log of this repo.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pc-15753492-")));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "A Dev");
  initProject(dir, "Demo");
  return { dir, git, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

test("15753492: a run that touches a file a commit also changes is linked to that commit's task", async () => {
  const { dir, git, cleanup } = project();
  try {
    const task = createTask(dir, { title: "Rotate keys", status: "in_progress" });
    const run = startRun(dir, { taskId: task.id, actor: { model: "m" } });

    // Claude Code's PostToolUse payload names the file with the absolute path
    // it actually wrote -- never one relative to the project root.
    const absolute = join(dir, "lib", "auth", "token.ts");
    const event = parseHook({
      session_id: "s1",
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: absolute },
    });
    if (event.kind !== "tool.use") throw new Error(`expected a tool.use event, got ${event.kind}`);

    // The exact call `ingest` makes for a tool.use event (cli/index.ts).
    reportRun(dir, run.id, { touched: event.touched });

    // A commit that changes the very file the run just wrote, safely after
    // the run started (git's author date truncates to the second; the run's
    // startedAt carries milliseconds, so the margin keeps the window check
    // honest rather than flaky).
    mkdirSync(join(dir, "lib", "auth"), { recursive: true });
    writeFileSync(absolute, "export const token = 1;\n");
    git("add", "lib/auth/token.ts");
    const after = new Date(Date.now() + 60_000).toISOString();
    git("commit", "-q", "-m", "Rotate the token", "--date", after);

    // The same inputs `readGitView` (lib/project/git-view.ts) feeds `linkRepository`.
    const runs = readRuns(dir);
    eq(runs[0]?.touched, [absolute], "the run recorded the absolute path, as the harness sent it (control)");

    const linked = await linkRepository(dir, readTasks(dir).tasks, [], 50, runs);
    const commit = linked.commits.find((c) => c.subject === "Rotate the token");

    eq(commit?.signal, "run", "a run that wrote this exact file, inside its open window, must be the match");
    eq(commit?.taskId, task.id, "and the commit must attribute to that run's task");
  } finally {
    cleanup();
  }
});

runAll().then((failed) => process.exit(failed ? 1 : 0));
