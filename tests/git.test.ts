import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertRef, GitError, gitRoot, readBranches, readCommits, readStatus, readWorktrees } from "@/lib/project/git";
import { attribute, branchMembership, globToRegExp, matchesAny } from "@/lib/project/git-link";
import { addWorktree, branchNameFor, createBranch } from "@/lib/project/git-write";
import { buildGraph } from "@/lib/project/commit-graph";
import type { Feature, Task } from "@/lib/project/types";
import { eq, ok, runAll, test, throws } from "./harness";

/** A real repository, because mocking git would test the mock. */
const repo = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "project-companion-git-")));
  const sh = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });

  sh("init", "-q", "-b", "main");
  sh("config", "user.email", "test@example.com");
  sh("config", "user.name", "Test");
  sh("config", "commit.gpgsign", "false");

  const commit = (message: string, files: Record<string, string>) => {
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), body, "utf8");
    }
    sh("add", "-A");
    sh("commit", "-q", "-m", message);
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  };

  return { dir, sh, commit, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

const task = (over: Partial<Task> = {}): Task => ({
  id: "978ce4d6",
  title: "Add refunds",
  status: "in_progress",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  order: 0,
  ...over,
});

const feature = (over: Partial<Feature> = {}): Feature => ({
  id: "guest-checkout",
  idSource: "marker",
  title: "Guest checkout",
  status: "todo",
  order: 0,
  acceptance: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

/* ------------------------------- ref safety ------------------------------- */

test("a ref that is really an option is rejected", () => {
  // The whole point: `git log --upload-pack=...` executes a command.
  throws(() => assertRef("--upload-pack=touch /tmp/pwned"), /Not a valid git ref/);
  throws(() => assertRef("-f"), /Not a valid git ref/);
  throws(() => assertRef("--output=/etc/passwd"), /Not a valid git ref/);
});

test("refs git itself forbids are rejected", () => {
  throws(() => assertRef("a..b"), /Not a valid git ref/);
  throws(() => assertRef("main.lock"), /Not a valid git ref/);
  throws(() => assertRef(""), /Not a valid git ref/);
  throws(() => assertRef("has space"), /Not a valid git ref/);
});

test("ordinary refs pass", () => {
  eq(assertRef("main"), "main");
  eq(assertRef("feat/978ce4d6-refunds"), "feat/978ce4d6-refunds");
  eq(assertRef("v1.2.3"), "v1.2.3");
});

/* --------------------------------- reading -------------------------------- */

test("a directory that is not a repository reports null, not an error", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "project-companion-norepo-")));
  try {
    eq(await gitRoot(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty repository yields no commits rather than throwing", async () => {
  const r = repo();
  try {
    eq(await readCommits(r.dir), []);
  } finally {
    r.cleanup();
  }
});

test("commits parse with stats and paths", async () => {
  const r = repo();
  try {
    r.commit("first", { "a.txt": "one\ntwo\n" });
    r.commit("second", { "src/b.ts": "export const x = 1;\n" });

    const commits = await readCommits(r.dir);
    eq(commits.length, 2);
    eq(commits[0].subject, "second");
    eq(commits[0].paths, ["src/b.ts"]);
    eq(commits[0].insertions, 1);
    eq(commits[0].author, "Test");
    ok(commits[0].sha.length === 40, "full sha expected");
    eq(commits[1].parents, []);
    eq(commits[0].parents, [commits[1].sha]);
  } finally {
    r.cleanup();
  }
});

test("a multi-line commit body does not break record parsing", async () => {
  const r = repo();
  try {
    r.commit("subject line\n\nA body with\nseveral lines\n\nproject-companion: 978ce4d6", { "a.txt": "x" });
    const [commit] = await readCommits(r.dir);
    eq(commit.subject, "subject line");
    ok(commit.body.includes("several lines"), "body truncated");
    ok(commit.body.includes("project-companion: 978ce4d6"), "trailer lost");
  } finally {
    r.cleanup();
  }
});

test("branches and status read correctly", async () => {
  const r = repo();
  try {
    r.commit("first", { "a.txt": "x" });
    r.sh("branch", "feat/978ce4d6-refunds");

    const branches = await readBranches(r.dir);
    eq(branches.map((b) => b.name).sort(), ["feat/978ce4d6-refunds", "main"]);
    eq(branches.find((b) => b.name === "main")!.isCurrent, true);

    writeFileSync(join(r.dir, "dirty.txt"), "x", "utf8");
    const status = await readStatus(r.dir);
    eq(status.branch, "main");
    eq(status.dirty, 1);
    eq(status.detached, false);
  } finally {
    r.cleanup();
  }
});

test("the main worktree is listed", async () => {
  const r = repo();
  try {
    r.commit("first", { "a.txt": "x" });
    const trees = await readWorktrees(r.dir);
    eq(trees.length, 1);
    eq(trees[0].path, r.dir);
    eq(trees[0].branch, "main");
    eq(trees[0].isMain, true);
  } finally {
    r.cleanup();
  }
});

/* ---------------------------------- globs --------------------------------- */

test("globs distinguish * from **", () => {
  ok(globToRegExp("app/*.ts").test("app/x.ts"));
  ok(!globToRegExp("app/*.ts").test("app/deep/x.ts"), "* must not cross a separator");
  ok(globToRegExp("app/**").test("app/deep/x.ts"));
  ok(globToRegExp("app/**/*.ts").test("app/deep/x.ts"));
  ok(globToRegExp("app/**/*.ts").test("app/x.ts"), "trailing /** should match the dir itself");
  ok(!globToRegExp("app/**").test("lib/x.ts"));
  ok(matchesAny("lib/cart/index.ts", ["app/**", "lib/cart/**"]));
});

/* ------------------------------- attribution ------------------------------ */

test("a recorded sha wins over everything else", async () => {
  const r = repo();
  try {
    const sha = r.commit("unrelated subject", { "elsewhere.ts": "x" });
    const commits = await readCommits(r.dir);
    const result = attribute(commits, [task({ commits: [sha] })], [feature()], new Map());
    eq(result.commits[0].taskId, "978ce4d6");
    eq(result.commits[0].signal, "recorded");
  } finally {
    r.cleanup();
  }
});

test("a trailer attributes to its task", async () => {
  const r = repo();
  try {
    r.commit("Add refund endpoint\n\nproject-companion: 978ce4d6", { "a.ts": "x" });
    const commits = await readCommits(r.dir);
    const result = attribute(commits, [task()], [feature()], new Map());
    eq(result.commits[0].taskId, "978ce4d6");
    eq(result.commits[0].signal, "trailer");
  } finally {
    r.cleanup();
  }
});

test("a branch name attributes when there is no trailer", async () => {
  const r = repo();
  try {
    r.sh("checkout", "-q", "-b", "feat/978ce4d6-refunds");
    r.commit("no trailer here", { "a.ts": "x" });
    const commits = await readCommits(r.dir);
    const membership = await branchMembership(r.dir, 50);
    const result = attribute(commits, [task()], [feature()], membership);
    eq(result.commits[0].taskId, "978ce4d6");
    eq(result.commits[0].signal, "branch");
  } finally {
    r.cleanup();
  }
});

test("path overlap attributes to a feature and never to a task", async () => {
  const r = repo();
  try {
    r.commit("touching checkout", { "app/checkout/page.tsx": "x" });
    const commits = await readCommits(r.dir);
    const result = attribute(
      commits,
      [task()],
      [feature({ paths: ["app/checkout/**"] })],
      new Map(),
    );
    eq(result.commits[0].featureId, "guest-checkout");
    eq(result.commits[0].taskId, undefined, "path overlap must not name a task");
    eq(result.commits[0].signal, "paths");
  } finally {
    r.cleanup();
  }
});

test("an ambiguous path match is no match", async () => {
  const r = repo();
  try {
    r.commit("touching shared code", { "lib/shared.ts": "x" });
    const commits = await readCommits(r.dir);
    const result = attribute(
      commits,
      [],
      [feature({ id: "a", paths: ["lib/**"] }), feature({ id: "b", paths: ["lib/**"] })],
      new Map(),
    );
    eq(result.commits[0].featureId, undefined, "two claimants should mean no claim");
    eq(result.unattributed.length, 1);
  } finally {
    r.cleanup();
  }
});

test("a task's feature is inherited by its commits", async () => {
  const r = repo();
  try {
    r.commit("work\n\nproject-companion: 978ce4d6", { "a.ts": "x" });
    const commits = await readCommits(r.dir);
    const result = attribute(commits, [task({ featureId: "guest-checkout" })], [feature()], new Map());
    eq(result.byFeature["guest-checkout"].length, 1);
    eq(result.byTask["978ce4d6"].length, 1);
  } finally {
    r.cleanup();
  }
});

test("commits with no signal land in the unattributed tray", async () => {
  const r = repo();
  try {
    r.commit("chore: tidy", { "random.ts": "x" });
    const commits = await readCommits(r.dir);
    const result = attribute(commits, [task()], [feature()], new Map());
    eq(result.unattributed.length, 1);
    eq(result.commits[0].signal, undefined);
  } finally {
    r.cleanup();
  }
});

/* ---------------------------------- writes -------------------------------- */

test("branch names carry the task id so attribution works for free", () => {
  eq(branchNameFor("978ce4d6", "Add refund endpoint"), "feat/978ce4d6-add-refund-endpoint");
  eq(branchNameFor("978ce4d6", "!!!"), "feat/978ce4d6");
});

test("creating a branch does not change the checkout", async () => {
  const r = repo();
  try {
    r.commit("first", { "a.txt": "x" });
    const before = await readStatus(r.dir);
    const result = await createBranch(r.dir, "feat/978ce4d6-refunds");
    eq(result.created, true);
    const after = await readStatus(r.dir);
    eq(after.branch, before.branch, "must not check out the new branch");
    ok((await readBranches(r.dir)).some((b) => b.name === "feat/978ce4d6-refunds"), "branch missing");
  } finally {
    r.cleanup();
  }
});

test("creating the same branch twice is not an error", async () => {
  const r = repo();
  try {
    r.commit("first", { "a.txt": "x" });
    await createBranch(r.dir, "feat/x");
    const second = await createBranch(r.dir, "feat/x");
    eq(second.created, false);
  } finally {
    r.cleanup();
  }
});

test("an option-shaped branch name is refused", async () => {
  const r = repo();
  try {
    r.commit("first", { "a.txt": "x" });
    let threw = false;
    try {
      await createBranch(r.dir, "--upload-pack=x");
    } catch (error) {
      threw = error instanceof GitError;
    }
    ok(threw, "expected a GitError");
  } finally {
    r.cleanup();
  }
});

test("a worktree outside the repository's parent is refused", async () => {
  const r = repo();
  try {
    r.commit("first", { "a.txt": "x" });
    let threw = false;
    try {
      await addWorktree(r.dir, "/tmp/somewhere-else-entirely", "feat/x");
    } catch (error) {
      threw = error instanceof GitError;
    }
    ok(threw, "expected the path to be refused");
  } finally {
    r.cleanup();
  }
});

test("a sibling worktree is created with its branch", async () => {
  const r = repo();
  try {
    r.commit("first", { "a.txt": "x" });
    const result = await addWorktree(r.dir, "../wt-refunds", "feat/978ce4d6-refunds");
    eq(result.created, true);
    const trees = await readWorktrees(r.dir);
    eq(trees.length, 2);
    ok(trees.some((t) => t.branch === "feat/978ce4d6-refunds"), "worktree branch missing");
    rmSync(result.path, { recursive: true, force: true });
  } finally {
    r.cleanup();
  }
});

test("a branch does not claim the history it was cut from", async () => {
  // The regression a live demo caught: `git log <branch>` includes every
  // ancestor, so "contained in" would credit the repository's first commit to
  // whichever task branch was cut most recently.
  const r = repo();
  try {
    r.commit("Initial commit", { "a.txt": "x" });
    r.commit("Unrelated trunk work", { "b.txt": "x" });
    r.sh("checkout", "-q", "-b", "feat/978ce4d6-refunds");
    r.commit("The actual task work", { "c.ts": "x" });
    r.sh("checkout", "-q", "main");

    const commits = await readCommits(r.dir, { all: true });
    const membership = await branchMembership(r.dir, 50);
    const result = attribute(commits, [task()], [feature()], membership);

    const bySubject = Object.fromEntries(result.commits.map((c) => [c.subject, c]));
    eq(bySubject["The actual task work"].taskId, "978ce4d6", "the branch's own commit links");
    eq(bySubject["Initial commit"].taskId, undefined, "an ancestor must NOT be claimed");
    eq(bySubject["Unrelated trunk work"].taskId, undefined, "trunk work must NOT be claimed");
  } finally {
    r.cleanup();
  }
});

test("commits on other branches are visible, not just the current one", async () => {
  const r = repo();
  try {
    r.commit("on main", { "a.txt": "x" });
    r.sh("checkout", "-q", "-b", "side");
    r.commit("on side", { "b.txt": "x" });
    r.sh("checkout", "-q", "main");

    const current = await readCommits(r.dir);
    ok(!current.some((c) => c.subject === "on side"), "current branch only, by default");

    const all = await readCommits(r.dir, { all: true });
    ok(all.some((c) => c.subject === "on side"), "all branches when asked");
  } finally {
    r.cleanup();
  }
});

/* ------------------------------ commit graph ------------------------------ */

test("a linear history occupies one lane", () => {
  const { rows, width } = buildGraph([
    { sha: "c", parents: ["b"] },
    { sha: "b", parents: ["a"] },
    { sha: "a", parents: [] },
  ]);
  eq(width, 1);
  eq(rows.map((r) => r.lane), [0, 0, 0]);
});

test("a merge forks a second lane and rejoins", () => {
  // m has two parents; the side branch gets its own lane until it merges back.
  const { rows, width } = buildGraph([
    { sha: "m", parents: ["a", "b"] },
    { sha: "b", parents: ["root"] },
    { sha: "a", parents: ["root"] },
    { sha: "root", parents: [] },
  ]);
  ok(width >= 2, "a merge should occupy at least two lanes");
  eq(rows[0].parentLanes.length, 2);
  eq(rows[rows.length - 1].commit.sha, "root");
});

test("the graph handles an empty history", () => {
  eq(buildGraph([]).rows, []);
  eq(buildGraph([]).width, 0);
});

runAll().then((failed) => process.exit(failed ? 1 : 0));
