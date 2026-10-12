/**
 * Regression test for bug ce914d26: `logEvent` skips the event log silently
 * when a planted shard is refused.
 *
 * Bug 54b4e811 made `appendEvent` (`lib/project/events.ts`) refuse a shard or a
 * `.project-log` that is not a real file or folder. Three callers hide that
 * refusal: `logEvent` (`lib/project/store.ts`, empty `catch`), the `ingest`
 * hook (`cli/index.ts`, empty `catch`) and `recordSpawnRequest`
 * (`lib/project/subagent.ts`, calls `appendEvent` and so reaches the hook's
 * `catch`). The user sees exit 0 and no message while the event is lost.
 *
 * What these tests assert is what the user sees: exactly one stderr line that
 * says the event log refused a write, with no event text and no path of the
 * outside target in it; the command's exit code and saved result unchanged;
 * the outside target unchanged. Requirement ID: UNKNOWN (TH-7 residual 3 and
 * the security re-check N3 stand in; see specs/bugs/ce914d26/bugfix.md).
 *
 * Run it with `npm test -- bug-ce914d26` (notifications are then off).
 */

import { execFile, execFileSync } from "node:child_process";
import {
  mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LOG_REFUSED_WARNING } from "../lib/project/events";
import { eq, ok, runAll, test } from "./harness";

if (process.env.PROJECT_COMPANION_NOTIFY !== "off") {
  process.stderr.write("bug-ce914d26.test.ts: PROJECT_COMPANION_NOTIFY is not off; run this suite with npm test -- bug-ce914d26\n");
  process.exit(1);
}

const CLI = join(process.cwd(), "dist", "project-companion.mjs");
const TMP = realpathSync(mkdtempSync(join(tmpdir(), "pc-ce914d26-")));
const HOME = join(TMP, "home"); // never the real ~/.claude (test rule 5)
mkdirSync(HOME);
// CLAUDE_PROJECT_DIR is dropped: the CLI would find its project there before the cwd (test rule 5).
const { CLAUDE_PROJECT_DIR: _dir, ...BASE_ENV } = process.env;
const ENV = { ...BASE_ENV, HOME };
const TIMEOUT = 10_000; // a failure is an assertion, not a stuck suite (test rule 3)

type Result = { code: number; out: string; err: string };

/** Runs the CLI in `dir`; `stdin` (if any) is piped in, as a harness hook would. */
const pc = (dir: string, args: string[], stdin?: string): Promise<Result> =>
  new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, ...args], { cwd: dir, env: ENV, timeout: TIMEOUT }, (e, out, err) => {
      const code = e ? ((e as { code?: unknown }).code as number | undefined) : 0;
      resolve({ code: typeof code === "number" ? code : -1, out, err });
    });
    child.stdin!.end(stdin ?? "");
  });

/** A temporary git project with a first task, so the actor's own shard exists. */
const project = async (): Promise<string> => {
  const dir = realpathSync(mkdtempSync(join(TMP, "p-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "dev@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "A Dev"], { cwd: dir });
  eq((await pc(dir, ["init", "Demo"])).code, 0);
  eq((await pc(dir, ["task", "add", "First task"])).code, 0);
  return dir;
};

/** A folder outside every project, where a planted link points. */
const outside = (): string => mkdtempSync(join(TMP, "outside-"));

/** Replaces the actor's own shard with a symlink to a regular file elsewhere. */
const plantShard = (dir: string, target: string): void => {
  const shards = readdirSync(join(dir, ".project-log")).filter((f) => f.endsWith(".jsonl"));
  eq(shards.length, 1, "expected exactly one shard (the actor's own)");
  const shard = join(dir, ".project-log", shards[0]);
  rmSync(shard);
  symlinkSync(target, shard);
};

/** Lines of stderr that say the event log refused a write. */
const warnings = (err: string): string[] => err.split("\n").filter((l) => l === LOG_REFUSED_WARNING.trim());

/** The warning must not hold event text, or a path outside the project. */
const clean = (line: string, secrets: string[]) => {
  for (const s of secrets) ok(!line.includes(s), `the warning must not hold ${JSON.stringify(s)}: ${line}`);
};

const SECRET_TITLE = "SECRET-TITLE-ce914d26";

test("ce914d26: task add after a planted own shard says the event log refused a write", async () => {
  const dir = await project();
  const target = join(outside(), "target.txt");
  writeFileSync(target, "OUTSIDE\n");
  plantShard(dir, target);

  const r = await pc(dir, ["task", "add", SECRET_TITLE]);

  // Unchanged: the command still succeeds and the task is still saved in .project.
  eq(r.code, 0, `task add must still exit 0: ${r.err}`);
  const list = await pc(dir, ["task", "list"]);
  ok(list.out.includes(SECRET_TITLE), "the task must still be saved in .project");
  // Unchanged: nothing reached the outside file.
  eq(readFileSync(target, "utf8"), "OUTSIDE\n", "the outside file must be unchanged");
  // The bug: no message at all.
  const found = warnings(r.err);
  eq(found.length, 1, `stderr must carry exactly one line that says the event log refused a write, got: ${JSON.stringify(r.err)}`);
  clean(found[0], [SECRET_TITLE, target]);
});

test("ce914d26: task add with a working log prints no warning (control)", async () => {
  const dir = await project();
  const r = await pc(dir, ["task", "add", "Another task"]);
  eq(r.code, 0, r.err);
  eq(warnings(r.err).length, 0, `no warning when the log works: ${JSON.stringify(r.err)}`);
});

test("ce914d26: a planted .project-log gives the same one warning and writes nothing outside", async () => {
  const dir = await project();
  const elsewhere = outside();
  rmSync(join(dir, ".project-log"), { recursive: true });
  symlinkSync(elsewhere, join(dir, ".project-log"));

  const r = await pc(dir, ["task", "add", SECRET_TITLE]);

  eq(r.code, 0, `task add must still exit 0: ${r.err}`);
  eq(readdirSync(elsewhere).length, 0, "nothing may be written through a planted .project-log");
  const found = warnings(r.err);
  eq(found.length, 1, `stderr must carry exactly one line that says the event log refused a write, got: ${JSON.stringify(r.err)}`);
  clean(found[0], [SECRET_TITLE, elsewhere]);
});

test("ce914d26: the ingest hook says so when it cannot record run.requested, and still exits 0", async () => {
  const dir = await project();
  const target = join(outside(), "target.txt");
  writeFileSync(target, "OUTSIDE\n");
  plantShard(dir, target);

  const payload = {
    session_id: "s1",
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: { subagent_type: "devolps:backend-engineer", prompt: `Task: ${SECRET_TITLE}\nBuild it.` },
  };
  const r = await pc(dir, ["ingest"], JSON.stringify(payload));

  eq(r.code, 0, `a hook must never exit non-zero: ${r.err}`);
  eq(readFileSync(target, "utf8"), "OUTSIDE\n", "the outside file must be unchanged");
  const found = warnings(r.err);
  eq(found.length, 1, `stderr must carry exactly one line that says the event log refused a write, got: ${JSON.stringify(r.err)}`);
  clean(found[0], [SECRET_TITLE, target]);
});

// The session.start path makes exactly one refused write, so this proves one warning for one refusal.
// The once-per-process flag itself is guarded by the unit test in tests/log-refused-warning.test.ts.
test("ce914d26: an ingest session.start after a planted shard prints exactly one warning", async () => {
  const dir = await project();
  const target = join(outside(), "target.txt");
  writeFileSync(target, "OUTSIDE\n");
  plantShard(dir, target);

  const r = await pc(dir, ["ingest"], JSON.stringify({ session_id: "s2", hook_event_name: "SessionStart", model: "m" }));

  eq(r.code, 0, `a hook must never exit non-zero: ${r.err}`);
  eq(readFileSync(target, "utf8"), "OUTSIDE\n", "the outside file must be unchanged");
  eq(warnings(r.err).length, 1, `exactly one warning per command, got: ${JSON.stringify(r.err)}`);
});

test("ce914d26: a tool.use hook that finds no run because the shard was planted after run start warns once and exits 0", async () => {
  const dir = await project();
  const started = await pc(dir, ["run", "start", "--session", "s3"]);
  eq(started.code, 0, started.err);
  const target = join(outside(), "target.txt");
  writeFileSync(target, "OUTSIDE\n");
  plantShard(dir, target);

  const payload = { session_id: "s3", hook_event_name: "PostToolUse", tool_name: "Edit" };
  const r = await pc(dir, ["ingest"], JSON.stringify(payload));

  eq(r.code, 0, `a hook must never exit non-zero: ${r.err}`);
  eq(readFileSync(target, "utf8"), "OUTSIDE\n", "the outside file must be unchanged");
  const found = warnings(r.err);
  eq(found.length, 1, `exactly one warning, got: ${JSON.stringify(r.err)}`);
  clean(found[0], [target, "s3"]);
});

test("ce914d26: a SubagentStop hook that finds no run because the shard was planted warns once and exits 0", async () => {
  const dir = await project();
  const started = await pc(dir, ["run", "start", "--session", "s4"]);
  eq(started.code, 0, started.err);
  const target = join(outside(), "target.txt");
  writeFileSync(target, "OUTSIDE\n");
  plantShard(dir, target);

  const payload = { session_id: "s4", hook_event_name: "SubagentStop", agent_id: "agent-x", agent_type: "devolps:backend-engineer" };
  const r = await pc(dir, ["ingest"], JSON.stringify(payload));

  eq(r.code, 0, `a hook must never exit non-zero: ${r.err}`);
  eq(readFileSync(target, "utf8"), "OUTSIDE\n", "the outside file must be unchanged");
  eq(warnings(r.err).length, 1, `exactly one warning, got: ${JSON.stringify(r.err)}`);
});

test("ce914d26: a PostToolUse for an unknown session in a healthy project prints no warning (control)", async () => {
  const dir = await project();
  const payload = { session_id: "unknown-s", hook_event_name: "PostToolUse", tool_name: "Edit" };
  const r = await pc(dir, ["ingest"], JSON.stringify(payload));
  eq(r.code, 0, r.err);
  eq(warnings(r.err).length, 0, `no warning when the log works: ${JSON.stringify(r.err)}`);
});

runAll().then((failed) => {
  rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
});
