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
 * failure here cannot add an entry to the PM's index. It reads the real index only to look for its own
 * probe folder. Every child has a timeout. It removes the folder it makes.
 */

import { execFileSync } from "node:child_process";
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
// Same rule as globalIndexPath in lib/project/registry.ts: the first of these agent folders that exists.
const REAL_AGENT_DIR = [".claude", ".codex", ".cursor", ".gemini"].find((d) => existsSync(join(REAL_HOME, d))) ?? ".claude";
const REAL_INDEX = join(REAL_HOME, REAL_AGENT_DIR, "project-companion", "index.json");
// The probe project folder of test 3, kept so test 4 can look for it in the real index.
let probe: string | null = null;

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
  probe = dir;
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

test("e17ca1c9: this suite did not add its project to the real index", () => {
  ok(probe !== null, "test 3 did not run, so there is no probe folder to look for");
  // Other sessions rewrite the real index, so compare nothing but the probe folder. A missing file is not listed.
  const text = existsSync(REAL_INDEX) ? readFileSync(REAL_INDEX, "utf8") : "";
  ok(!text.includes(probe as string), `the real index ${REAL_INDEX} lists the probe project ${probe}`);
});

runAll().then((failed) => process.exit(failed ? 1 : 0));
