/**
 * Bug 15753492: a run's touched paths are stored relative to the project root,
 * and old absolute paths in the log are read the same way.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { linkRepository } from "@/lib/project/git-link";
import { relativeToRoot } from "@/lib/project/rel-path";
import { createComponent, createTask, initProject, readRun, reportRun, startRun } from "@/lib/project/store";
import { eq, test, runAll } from "./harness";

const project = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pc-runpaths-")));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "A Dev");
  initProject(dir, "Demo");
  return { dir, git, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

test("15753492: an absolute path inside the root is stored relative with forward slashes", () => {
  const { dir, cleanup } = project();
  try {
    const task = createTask(dir, { title: "T", status: "in_progress" });
    const run = startRun(dir, { taskId: task.id, actor: { model: "m" } });
    reportRun(dir, run.id, { touched: [join(dir, "lib", "auth", "token.ts")] });
    eq(readRun(dir, run.id)?.touched, ["lib/auth/token.ts"], "stored relative");
  } finally {
    cleanup();
  }
});

test("15753492: a path outside the root, or with .. out of it, is stored exactly as given", () => {
  const { dir, cleanup } = project();
  try {
    const task = createTask(dir, { title: "T", status: "in_progress" });
    const run = startRun(dir, { taskId: task.id, actor: { model: "m" } });
    const outside = join(tmpdir(), "elsewhere", "x.ts");
    const escape = join(dir, "lib", "..", "..", "sibling.ts");
    reportRun(dir, run.id, { touched: [outside, escape] });
    eq(readRun(dir, run.id)?.touched, [outside, escape], "outside paths untouched");
  } finally {
    cleanup();
  }
});

test("15753492: a relative path already in the log is unchanged", () => {
  const { dir, cleanup } = project();
  try {
    const task = createTask(dir, { title: "T", status: "in_progress" });
    const run = startRun(dir, { taskId: task.id, actor: { model: "m" } });
    reportRun(dir, run.id, { touched: ["lib/auth/token.ts"] });
    eq(readRun(dir, run.id)?.touched, ["lib/auth/token.ts"], "unchanged");
  } finally {
    cleanup();
  }
});

test("15753492: mayWrite sees the relative path, so an absolute write inside the boundary is allowed", () => {
  const { dir, cleanup } = project();
  try {
    createComponent(dir, { title: "Auth", paths: ["lib/auth/**"] });
    const task = createTask(dir, { title: "T", status: "in_progress", componentId: "auth" });
    const run = startRun(dir, { taskId: task.id, actor: { model: "m" } });
    const inside = join(dir, "lib", "auth", "a.ts");
    const other = join(dir, "lib", "billing", "b.ts");
    const result = reportRun(dir, run.id, { touched: [inside, other] });
    eq(result?.refused, ["lib/billing/b.ts"], "only the billing write is refused");
    eq(readRun(dir, run.id)?.touched, ["lib/auth/a.ts"], "the allowed write is relative");
  } finally {
    cleanup();
  }
});

test("15753492: a symlinked root still resolves an absolute path inside it", () => {
  const { dir, cleanup } = project();
  const link = join(tmpdir(), `pc-runpaths-link-${process.pid}`);
  try {
    mkdirSync(join(dir, "lib"));
    symlinkSync(dir, link);
    eq(relativeToRoot(dir, join(link, "lib", "a.ts")), "lib/a.ts", "via the link");
    eq(relativeToRoot(link, join(dir, "lib", "a.ts")), "lib/a.ts", "root given as the link");
  } finally {
    rmSync(link, { force: true });
    cleanup();
  }
});

test("15753492: an old run holding an absolute path still attributes to its commit", async () => {
  const { dir, git, cleanup } = project();
  try {
    const task = createTask(dir, { title: "Rotate keys", status: "in_progress" });
    const absolute = join(dir, "lib", "auth", "token.ts");
    mkdirSync(join(dir, "lib", "auth"), { recursive: true });
    writeFileSync(absolute, "export const token = 1;\n");
    git("add", "lib/auth/token.ts");
    git("commit", "-q", "-m", "Rotate the token");
    const old = { id: "old1", taskId: task.id, touched: [absolute], startedAt: new Date(Date.now() - 60_000).toISOString() };
    const linked = await linkRepository(dir, [task], [], 50, [old]);
    const commit = linked.commits.find((c) => c.subject === "Rotate the token");
    eq(commit?.signal, "run", "matched through the read side");
    eq(commit?.taskId, task.id, "to the run's task");
  } finally {
    cleanup();
  }
});

runAll().then((failed) => process.exit(failed ? 1 : 0));
