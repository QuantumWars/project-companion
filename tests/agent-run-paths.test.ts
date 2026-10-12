/**
 * Bug 15753492: a run's touched paths are stored relative to the checkout that holds them,
 * and old absolute paths in the log are read the same way.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { linkRepository } from "@/lib/project/git-link";
import { relativeToRoot } from "@/lib/project/rel-path";
import { createComponent, createTask, initProject, readRun, readRuns, reportRun, startRun } from "@/lib/project/store";
import { eq, test, runAll } from "./harness";

const project = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pc-runpaths-")));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "A Dev");
  git("config", "commit.gpgsign", "false");
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
    const escape = `${dir}/lib/../../sibling.ts`;
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
    const auth = createComponent(dir, { title: "Auth", paths: ["lib/auth/**"] });
    const task = createTask(dir, { title: "T", status: "in_progress", componentId: auth.id });
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

test("15753492: a .. that stays inside the root is resolved, and the root itself is unchanged", () => {
  const { dir, cleanup } = project();
  try {
    eq(relativeToRoot(dir, `${dir}/lib/../src/a.ts`), "src/a.ts", "inside .. resolved");
    eq(relativeToRoot(dir, dir), dir, "the root itself is returned as given");
  } finally {
    cleanup();
  }
});

test("15753492: a write inside a linked worktree links the run to the commit made there", async () => {
  const { dir, git, cleanup } = project();
  try {
    const task = createTask(dir, { title: "Rotate keys", status: "in_progress" });
    writeFileSync(join(dir, "README.md"), "demo\n");
    git("add", "README.md");
    git("commit", "-q", "-m", "Start");
    const tree = join(dir, ".claude", "worktrees", "agent-x");
    git("worktree", "add", "-q", "-b", "agent-x", tree);
    const run = startRun(dir, { taskId: task.id, actor: { model: "m" } });
    const absolute = join(tree, "lib", "auth", "token.ts");
    reportRun(dir, run.id, { touched: [absolute] });
    eq(readRun(dir, run.id)?.touched, ["lib/auth/token.ts"], "relative to the worktree, as git shows it");
    mkdirSync(join(tree, "lib", "auth"), { recursive: true });
    writeFileSync(absolute, "export const token = 1;\n");
    const inTree = (...args: string[]) => execFileSync("git", args, { cwd: tree, stdio: "pipe" });
    inTree("add", "lib/auth/token.ts");
    inTree("commit", "-q", "-m", "Rotate the token", "--date", new Date(Date.now() + 60_000).toISOString());
    const linked = await linkRepository(dir, [task], [], 50, readRuns(dir));
    const commit = linked.commits.find((c) => c.subject === "Rotate the token");
    eq(commit?.signal, "run", "linked through the run");
    eq(commit?.taskId, task.id, "to the run's task");
  } finally {
    cleanup();
  }
});

test("15753492: a project in a sub-folder of its repository stores paths relative to the git root", async () => {
  const { dir, git, cleanup } = project();
  try {
    const app = join(dir, "app");
    mkdirSync(app);
    initProject(app, "Sub");
    const task = createTask(app, { title: "Rotate keys", status: "in_progress" });
    const run = startRun(app, { taskId: task.id, actor: { model: "m" } });
    const absolute = join(app, "lib", "a.ts");
    reportRun(app, run.id, { touched: [absolute] });
    eq(readRun(app, run.id)?.touched, ["app/lib/a.ts"], "relative to the git root");
    mkdirSync(join(app, "lib"));
    writeFileSync(absolute, "export const a = 1;\n");
    git("add", "app/lib/a.ts");
    git("commit", "-q", "-m", "Add a", "--date", new Date(Date.now() + 60_000).toISOString());
    const linked = await linkRepository(dir, [task], [], 50, readRuns(app));
    eq(linked.commits.find((c) => c.subject === "Add a")?.signal, "run", "linked through the run");
    eq(relativeToRoot(app, absolute), "app/lib/a.ts", "the read side gives the same text from the project root");
  } finally {
    cleanup();
  }
});

test("15753492: a path in a sibling repository stays absolute and never links to a commit here", async () => {
  const { dir, git, cleanup } = project();
  const other = realpathSync(mkdtempSync(join(tmpdir(), "pc-runpaths-other-")));
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: other, stdio: "pipe" });
    const task = createTask(dir, { title: "Rotate keys", status: "in_progress" });
    const run = startRun(dir, { taskId: task.id, actor: { model: "m" } });
    const foreign = join(other, "lib", "foo.ts");
    reportRun(dir, run.id, { touched: [foreign] });
    eq(readRun(dir, run.id)?.touched, [foreign], "stays absolute");
    mkdirSync(join(dir, "lib"));
    writeFileSync(join(dir, "lib", "foo.ts"), "export const a = 1;\n");
    git("add", "lib/foo.ts");
    git("commit", "-q", "-m", "Add foo", "--date", new Date(Date.now() + 60_000).toISOString());
    const linked = await linkRepository(dir, [task], [], 50, readRuns(dir));
    const commit = linked.commits.find((c) => c.subject === "Add foo");
    eq(commit?.signal === "run", false, "no run signal");
  } finally {
    rmSync(other, { recursive: true, force: true });
    cleanup();
  }
});

test("15753492: a path in a nested repository inside the project stays absolute", () => {
  const { dir, cleanup } = project();
  try {
    const nested = join(dir, "vendor", "lib");
    mkdirSync(nested, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: nested, stdio: "pipe" });
    const file = join(nested, "x.ts");
    eq(relativeToRoot(dir, file), file, "nested repository path stays absolute");
  } finally {
    cleanup();
  }
});

test("15753492: a path in a submodule of the project stays absolute", () => {
  const { dir, git, cleanup } = project();
  const sub = realpathSync(mkdtempSync(join(tmpdir(), "pc-runpaths-sub-")));
  try {
    const inSub = (...args: string[]) => execFileSync("git", args, { cwd: sub, stdio: "pipe" });
    inSub("init", "-q", "-b", "main");
    inSub("config", "user.email", "dev@example.com");
    inSub("config", "user.name", "A Dev");
    inSub("config", "commit.gpgsign", "false");
    writeFileSync(join(sub, "a.txt"), "a\n");
    inSub("add", "a.txt");
    inSub("commit", "-q", "-m", "init");
    git("-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "mod");
    const file = join(dir, "mod", "lib", "x.ts");
    eq(relativeToRoot(dir, file), file, "submodule path stays absolute");
  } finally {
    rmSync(sub, { recursive: true, force: true });
    cleanup();
  }
});

test("15753492: with no git repository, a symlinked root still gives a relative path", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pc-runpaths-nogit-")));
  const link = join(tmpdir(), `pc-runpaths-nogit-link-${process.pid}`);
  try {
    symlinkSync(dir, link);
    eq(relativeToRoot(link, join(dir, "lib", "a.ts")), "lib/a.ts", "falls back to the root");
  } finally {
    rmSync(link, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

runAll().then((failed) => process.exit(failed ? 1 : 0));
