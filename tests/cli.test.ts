import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { eq, ok, runAll, test } from "./harness";

/**
 * The CLI, run as a real process against a real repository.
 *
 * There was no suite here, and it is where the thinnest coverage did the most
 * damage: `init` -- the first command anybody runs, and the one the README's
 * quick start documents -- crashed on every new project for as long as the
 * single-file format has existed. Nothing that only imports `lib/` could have
 * caught it, because the bug was in the argument the CLI passed.
 */

const run = promisify(execFile);
const CLI = join(process.cwd(), "dist", "project-companion.mjs");

const repo = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pc-cli-")));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString();

  git("init", "-q", "-b", "main");
  git("config", "user.email", "grace@example.com");
  git("config", "user.name", "Grace H");
  git("config", "commit.gpgsign", "false");

  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

const pc = (dir: string, ...args: string[]) =>
  run(process.execPath, [CLI, ...args], { cwd: dir }).then((r) => r.stdout);

/* ----------------------------------- init ---------------------------------- */

test("init creates the project and does not throw", async () => {
  const { dir, cleanup } = repo();
  try {
    const out = await pc(dir, "init", "Demo");
    ok(out.includes("Initialised"), out);
    ok(existsSync(join(dir, ".project")), "the bundle is a file at the root");
  } finally { cleanup(); }
});

test("init writes the skill into an agent directory, not into .project", async () => {
  const { dir, cleanup } = repo();
  try {
    await pc(dir, "init", "Demo");

    const skill = join(dir, ".claude", "skills", "project-companion", "SKILL.md");
    ok(existsSync(skill), "the skill lands in .claude/skills/");
    ok(
      readFileSync(skill, "utf8").includes("project-companion"),
      "and it is the real skill, not an empty file",
    );

    // The regression: `.project` is a FILE, so deriving the agent directory
    // from the store path asked for `mkdir .project/skills/...` -- ENOTDIR.
    ok(!existsSync(join(dir, ".project", "skills")), "nothing was written inside .project");
  } finally { cleanup(); }
});

test("init respects an agent directory that already exists", async () => {
  const { dir, cleanup } = repo();
  try {
    execFileSync("mkdir", ["-p", join(dir, ".codex")]);
    await pc(dir, "init", "Demo");

    ok(
      existsSync(join(dir, ".codex", "skills", "project-companion", "SKILL.md")),
      "a Codex user is not handed a .claude/ they never asked for",
    );
    ok(!existsSync(join(dir, ".claude")), "and no second agent directory appears");
  } finally { cleanup(); }
});

test("init twice leaves the project and its contents alone", async () => {
  const { dir, cleanup } = repo();
  try {
    await pc(dir, "init", "Demo");
    await pc(dir, "task", "add", "Already here", "--status", "todo");
    await pc(dir, "init", "Demo");

    ok((await pc(dir, "task", "list")).includes("Already here"), "the second init reset nothing");
  } finally { cleanup(); }
});

/* -------------------------------- components ------------------------------- */

test("a component round-trips through the CLI", async () => {
  const { dir, cleanup } = repo();
  try {
    await pc(dir, "init", "Demo");
    const created = await pc(dir, "component", "add", "Auth Service",
      "--owner", "grace@example.com", "--paths", "lib/auth/**,app/login/**");
    ok(created.includes("auth-service"), created);

    const shown = await pc(dir, "component", "show", "auth-service");
    ok(shown.includes("grace@example.com"), shown);
    ok(shown.includes("lib/auth/**, app/login/**"), "both globs survive the round trip");
  } finally { cleanup(); }
});

test("a component with no paths says so, rather than looking finished", async () => {
  const { dir, cleanup } = repo();
  try {
    await pc(dir, "init", "Demo");
    const out = await pc(dir, "component", "add", "Vague");
    ok(out.includes("No paths yet"), "the CLI says why that is a problem");
    ok(out.includes("component set vague --paths"), "and exactly how to fix it");
  } finally { cleanup(); }
});

test("`whose` explains which glob matched", async () => {
  const { dir, cleanup } = repo();
  try {
    await pc(dir, "init", "Demo");
    await pc(dir, "component", "add", "Platform", "--paths", "lib/**", "--owner", "grace");
    await pc(dir, "component", "add", "Auth", "--paths", "lib/auth/**", "--owner", "sam");

    const nested = await pc(dir, "whose", "lib/auth/token.ts");
    ok(nested.includes("auth"), nested);
    ok(nested.includes("matched lib/auth/**"), "the attribution is explained, not asserted");

    const outside = await pc(dir, "whose", "README.md");
    ok(outside.includes("belongs to no component"), outside);
  } finally { cleanup(); }
});

test("doctor reports an unowned component and a pathless one", async () => {
  const { dir, cleanup } = repo();
  try {
    await pc(dir, "init", "Demo");
    await pc(dir, "component", "add", "Ghost");

    const out = await pc(dir, "component", "doctor");
    ok(out.includes("unowned"), out);
    ok(out.includes("no-paths"), out);
  } finally { cleanup(); }
});

test("a dangling --parent is refused rather than stored", async () => {
  const { dir, cleanup } = repo();
  try {
    await pc(dir, "init", "Demo");
    let failed = false;
    try {
      await pc(dir, "component", "add", "Orphan", "--parent", "nope");
    } catch (error) {
      failed = true;
      ok(String((error as { stderr?: string }).stderr).includes("No component"), "it says which");
    }
    ok(failed, "the command exits non-zero rather than storing a broken link");
  } finally { cleanup(); }
});

/* ----------------------------------- log ----------------------------------- */

test("the log shows what happened, by whom, in order", async () => {
  const { dir, cleanup } = repo();
  try {
    await pc(dir, "init", "Demo");
    const created = await pc(dir, "task", "add", "Rotate keys", "--status", "todo");
    const id = created.split(/\s+/)[1];
    await pc(dir, "task", "move", id, "in_progress");
    await pc(dir, "task", "move", id, "done");

    const log = await pc(dir, "log");
    const lines = log.trim().split("\n");
    eq(lines.length, 3, log);
    ok(lines.every((l) => l.includes("Grace H")), "the actor hash resolves to a name");
    ok(lines[1].includes("from=todo to=in_progress"), lines[1]);
    ok(lines[2].includes("from=in_progress to=done"), lines[2]);
  } finally { cleanup(); }
});

test("an empty log says so instead of printing nothing", async () => {
  const { dir, cleanup } = repo();
  try {
    await pc(dir, "init", "Demo");
    ok((await pc(dir, "log")).includes("Nothing logged yet"));
  } finally { cleanup(); }
});

/* ---------------------------------- help ----------------------------------- */

test("help does not promise a directory the tool stopped creating", async () => {
  const { dir, cleanup } = repo();
  try {
    const help = await pc(dir, "help");
    ok(!help.includes("create .arch/"), "the init line described a layout two formats ago");
    ok(help.includes("create a .project file"), help.slice(0, 200));
    ok(!help.includes("repo containing .arch/"), "and so did the closing line");
  } finally { cleanup(); }
});

runAll().then((failed) => process.exit(failed ? 1 : 0));
