/**
 * Bug e17ca1c9: the CLI test suites write the PM's real project index.
 *
 * Five suites (cli, devolps-phase3, gate, merge, sync) start the built CLI with the runner's own
 * environment, so the CLI adds each temporary test project to ~/.claude/project-companion/index.json
 * under the PM's real HOME (`registerProject`, cli/index.ts). Test rule 5 says a CLI child gets a
 * temporary HOME and no CLAUDE_PROJECT_DIR.
 *
 * The fix is in the runner (scripts/run-tests.mjs): it gives every suite a temporary HOME and removes
 * CLAUDE_PROJECT_DIR. This suite proves the runner does it, and proves the effect: a CLI child started
 * the way the offending suites start it (process.env spread in, nothing else) cannot reach the real
 * index.
 *
 * Safety (test rules 3, 5 and 8): this suite never starts the CLI while HOME is the real home, so a
 * failure here cannot add an entry to the PM's index. It reads the real index only to compare its
 * checksum. Every child has a timeout. It removes the folder it makes.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, sep } from "node:path";

import { eq, ok, runAll, test } from "./harness";

if (process.env.PROJECT_COMPANION_NOTIFY !== "off") {
  process.stderr.write("bug-e17ca1c9.test.ts: PROJECT_COMPANION_NOTIFY is not off; run this suite with npm test -- bug-e17ca1c9\n");
  process.exit(1);
}

const CLI = join(process.cwd(), "dist", "project-companion.mjs");
// The passwd entry does not follow $HOME, so this stays the PM's real home even when HOME is changed.
const REAL_HOME = userInfo().homedir;
const REAL_INDEX = join(REAL_HOME, ".claude", "project-companion", "index.json");
const sum = (file: string): string | null => (existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : null);
const realIndexBefore = sum(REAL_INDEX);

const real = (p: string): string => {
  try { return realpathSync(p); } catch { return p; }
};
const insideTmp = (p: string): boolean => real(p).startsWith(real(tmpdir()) + sep);
const homeIsTemporary = (): boolean => real(homedir()) !== real(REAL_HOME) && insideTmp(homedir());

test("e17ca1c9: the runner gives this suite a temporary HOME, not the real one", () => {
  ok(
    homeIsTemporary(),
    `HOME is ${JSON.stringify(process.env.HOME)}: it must be a temporary folder, not the real home ${JSON.stringify(REAL_HOME)}. ` +
      "scripts/run-tests.mjs must set HOME to a temporary folder for every suite.",
  );
});

test("e17ca1c9: the runner removes CLAUDE_PROJECT_DIR for this suite", () => {
  eq(process.env.CLAUDE_PROJECT_DIR, undefined, "a CLI child would find its project there before its working folder");
});

test("e17ca1c9: a CLI child with the runner's env cannot reach the real index", () => {
  // The way tests/devolps-phase3.test.ts starts the CLI: process.env spread in, nothing else.
  // Guard first: with the real HOME, running the CLI would write the PM's index, which is the bug.
  ok(
    homeIsTemporary() && process.env.CLAUDE_PROJECT_DIR === undefined,
    "not run: HOME is not temporary, so starting the CLI could add an entry to the real index",
  );

  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pc-e17ca1c9-")));
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe", timeout: 10_000 });
    git("init", "-q", "-b", "main");
    execFileSync(process.execPath, [CLI, "init", "Probe"], { cwd: dir, env: { ...process.env }, stdio: "pipe", timeout: 20_000 });
    execFileSync(process.execPath, [CLI, "status"], { cwd: dir, env: { ...process.env }, stdio: "pipe", timeout: 20_000 });

    const index = join(homedir(), ".claude", "project-companion", "index.json");
    ok(existsSync(index), "the CLI wrote its index under the temporary HOME");
    ok(readFileSync(index, "utf8").includes(dir), "the probe project is in the temporary index");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("e17ca1c9: this suite did not change the real index", () => {
  eq(sum(REAL_INDEX), realIndexBefore, "the checksum of the real index changed during this suite");
});

runAll().then((failed) => process.exit(failed ? 1 : 0));
