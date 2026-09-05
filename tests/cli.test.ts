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
