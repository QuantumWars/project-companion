import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mergeBundles } from "@/lib/project/merge";
import { eq, ok, runAll, test } from "./harness";

const bundle = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ revision: 1, name: "P", components: {}, tasks: [], ...over });

const merge = (base: string, ours: string, theirs: string) =>
  mergeBundles(base, ours, theirs);

/* ---------------------------------- rules --------------------------------- */

test("a change on one side only is taken", () => {
  const base = bundle();
  const ours = bundle({ components: { auth: { id: "auth", title: "Auth" } } });
  const { merged, conflicts } = merge(base, ours, base);
  eq(conflicts, []);
  eq((merged as { components: Record<string, unknown> }).components.auth, { id: "auth", title: "Auth" });
});

test("two people adding different things both keep them", () => {
  const base = bundle();
  const ours = bundle({ components: { auth: { id: "auth" } } });
  const theirs = bundle({ components: { billing: { id: "billing" } } });
  const { merged, conflicts } = merge(base, ours, theirs);
  eq(conflicts, []);
  eq(Object.keys((merged as { components: Record<string, unknown> }).components).sort(), ["auth", "billing"]);
});

test("tasks merge by id, not by position", () => {
  const base = bundle({ tasks: [{ id: "a", title: "A", order: 0 }] });
  const ours = bundle({ tasks: [{ id: "a", title: "A", order: 0 }, { id: "b", title: "B", order: 1 }] });
  const theirs = bundle({ tasks: [{ id: "a", title: "A", order: 0 }, { id: "c", title: "C", order: 1 }] });
  const { merged, conflicts } = merge(base, ours, theirs);
  eq(conflicts, [], "two people adding a task at the same index is not a conflict");
  eq((merged as { tasks: { id: string }[] }).tasks.map((t) => t.id).sort(), ["a", "b", "c"]);
});

test("both sides editing one thing takes the later stamp", () => {
  const base = bundle({ components: { auth: { id: "auth", title: "Auth", updatedAt: "2026-01-01T00:00:00Z" } } });
  const ours = bundle({ components: { auth: { id: "auth", title: "Mine", updatedAt: "2026-01-02T00:00:00Z" } } });
  const theirs = bundle({ components: { auth: { id: "auth", title: "Theirs", updatedAt: "2026-01-03T00:00:00Z" } } });
  const { merged, conflicts } = merge(base, ours, theirs);
  eq(conflicts, []);
  eq((merged as { components: Record<string, { title: string }> }).components.auth.title, "Theirs");
});

test("both sides editing one untimestamped scalar is a real conflict", () => {
  const { conflicts } = merge(bundle({ name: "P" }), bundle({ name: "Mine" }), bundle({ name: "Theirs" }));
  eq(conflicts, ["name"], "losing somebody's edit silently is worse than making them merge");
});

test("a deletion the other side did not touch is a deletion", () => {
  const base = bundle({ components: { auth: { id: "auth" } } });
  const ours = bundle({ components: {} });
  const { merged, conflicts } = merge(base, ours, base);
  eq(conflicts, []);
  eq((merged as { components: Record<string, unknown> }).components, {});
});

test("a deletion on one side and an edit on the other keeps the edit", () => {
  const base = bundle({ components: { auth: { id: "auth", title: "Auth" } } });
  const ours = bundle({ components: {} });
  const theirs = bundle({ components: { auth: { id: "auth", title: "Renamed" } } });
  const { merged } = merge(base, ours, theirs);
  ok((merged as { components: Record<string, unknown> }).components.auth, "the work survives the delete");
});

test("the revision counter moves past both, so the next write still collides", () => {
  const { merged } = merge(bundle({ revision: 4 }), bundle({ revision: 7 }), bundle({ revision: 9 }));
  eq((merged as { revision: number }).revision, 10);
});

test("a file that is not JSON fails rather than producing something", () => {
  const { merged, conflicts } = merge("{}", "not json", "{}");
  eq(merged, null);
  ok(conflicts.length);
});

/* ------------------------------- through git ------------------------------ */

test("two clones that both edited the board merge with no conflict", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pc-merge-")));
  const cli = join(process.cwd(), "dist", "project-companion.mjs");
  const run = (cwd: string, ...args: string[]) =>
    execFileSync(process.execPath, [cli, ...args], { cwd, stdio: "pipe" }).toString();
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

  try {
    // Bare, because you cannot push to a branch somebody has checked out.
    const origin = join(dir, "origin.git");
    git(dir, "init", "-q", "--bare", "-b", "main", origin);

    const a = join(dir, "a");
    const b = join(dir, "b");

    git(dir, "clone", "-q", origin, a);
    git(a, "config", "user.email", "a@e.com");
    git(a, "config", "user.name", "A");
    git(a, "config", "commit.gpgsign", "false");
    run(a, "init", "Shared");
    git(a, "add", "-A");
    git(a, "commit", "-q", "-m", "start");
    git(a, "push", "-q", "origin", "main");

    git(dir, "clone", "-q", origin, b);
    git(b, "config", "user.email", "b@e.com");
    git(b, "config", "user.name", "B");
    git(b, "config", "commit.gpgsign", "false");
    // The driver is registered locally by design, so each clone runs `init`.
    run(b, "init", "Shared");
    // `init` points the driver at `npx project-companion`, which is right for a
    // published package and cannot resolve from a temp directory. The mechanism
    // under test is git invoking the driver, not how npm finds it.
    git(b, "config", "merge.project-companion.driver", `${process.execPath} ${cli} merge-driver %O %A %B`);

    run(a, "component", "add", "Auth", "--paths", "lib/auth/**", "--owner", "a");
    run(a, "task", "add", "A's work", "--status", "todo");
    git(a, "add", "-A");
    git(a, "commit", "-q", "-m", "a");

    run(b, "component", "add", "Billing", "--paths", "lib/billing/**", "--owner", "b");
    run(b, "task", "add", "B's work", "--status", "todo");
    git(b, "add", "-A");
    git(b, "commit", "-q", "-m", "b");

    git(a, "push", "-q", "origin", "main");
    git(b, "fetch", "-q", "origin");

    // Without the driver this is a conflict in a JSON blob nobody can resolve.
    git(b, "merge", "-q", "origin/main", "-m", "merge");

    const merged = JSON.parse(readFileSync(join(b, ".project"), "utf8"));
    eq(Object.keys(merged.components).sort(), ["auth", "billing"], "both catalogs survived");
    eq(
      merged.tasks.map((t: { title: string }) => t.title).sort(),
      ["A's work", "B's work"],
      "and both boards",
    );

    // And the log, which merges by being sharded rather than by any driver.
    const shards = execFileSync("ls", [join(b, ".project-log")]).toString().trim().split("\n");
    ok(shards.length >= 2, `each actor kept their own shard (${shards.length})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

runAll().then((failed) => process.exit(failed ? 1 : 0));
