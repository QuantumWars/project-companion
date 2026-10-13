/**
 * Regression test for bug f6864c33: the CLI prints a Node stack trace when the
 * event log refuses a gate or card command.
 *
 * Bug 54b4e811 made `appendEvent` (`lib/project/events.ts`) throw
 * `LogRefusedError` for a planted shard or `.project-log`. Bug ce914d26 made
 * the callers that swallow it print one fixed warning. The gate and card
 * branches of the CLI call `appendEvent` (through `lib/project/gate.ts` and
 * directly) with no `catch` for it, and `main()` has no top-level handler, so
 * Node prints the uncaught exception: the source line, the message with the
 * absolute project path, `    at ` stack frames and the Node version.
 *
 * What these tests assert is what the user sees: a non-zero exit code, and on
 * stderr exactly one plain line that names the event log, with no stack frame,
 * no path, and no subject or question text. Requirement ID: UNKNOWN (TH-7
 * residual 3 and the F2 row of specs/decision-alerts/threat-model.md stand in;
 * see specs/bugs/f6864c33/bugfix.md).
 *
 * Run it with `npm test -- bug-f6864c33` (notifications are then off).
 */

import { execFile, execFileSync } from "node:child_process";
import {
  mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq, ok, runAll, test } from "./harness";

if (process.env.PROJECT_COMPANION_NOTIFY !== "off") {
  process.stderr.write("bug-f6864c33.test.ts: PROJECT_COMPANION_NOTIFY is not off; run this suite with npm test -- bug-f6864c33\n");
  process.exit(1);
}

const CLI = join(process.cwd(), "dist", "project-companion.mjs");
const TMP = realpathSync(mkdtempSync(join(tmpdir(), "pc-f6864c33-")));
const HOME = join(TMP, "home"); // never the real ~/.claude (test rule 5)
mkdirSync(HOME);
// CLAUDE_PROJECT_DIR is dropped: the CLI would find its project there before the cwd (test rule 5).
const { CLAUDE_PROJECT_DIR: _dir, ...BASE_ENV } = process.env;
const ENV = { ...BASE_ENV, HOME };
const TIMEOUT = 10_000; // a failure is an assertion, not a stuck suite (test rule 3)

type Result = { code: number; out: string; err: string };

const pc = (dir: string, args: string[]): Promise<Result> =>
  new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, ...args], { cwd: dir, env: ENV, timeout: TIMEOUT }, (e, out, err) => {
      const code = e ? ((e as { code?: unknown }).code as number | undefined) : 0;
      resolve({ code: typeof code === "number" ? code : -1, out, err });
    });
    child.stdin!.end("");
  });

/** A temporary git project with a first task (so the actor's own shard exists) and one artifact file. */
const project = async (): Promise<string> => {
  const dir = realpathSync(mkdtempSync(join(TMP, "p-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "dev@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "A Dev"], { cwd: dir });
  eq((await pc(dir, ["init", "Demo"])).code, 0);
  eq((await pc(dir, ["task", "add", "First task"])).code, 0);
  writeFileSync(join(dir, "notes.md"), "# notes\n");
  return dir;
};

const outside = (): string => mkdtempSync(join(TMP, "outside-"));

/** Replaces the actor's own shard with a symlink to a regular file elsewhere. */
const plantShard = (dir: string, target: string): void => {
  const shards = readdirSync(join(dir, ".project-log")).filter((f) => f.endsWith(".jsonl"));
  eq(shards.length, 1, "expected exactly one shard (the actor's own)");
  const shard = join(dir, ".project-log", shards[0]);
  rmSync(shard);
  symlinkSync(target, shard);
};

/** Replaces `.project-log` with a symlink to an empty folder elsewhere. */
const plantFolder = (dir: string, target: string): void => {
  rmSync(join(dir, ".project-log"), { recursive: true });
  symlinkSync(target, join(dir, ".project-log"));
};

const SUBJECT = "SECRET-SUBJECT-f6864c33";
const ASK = "SECRET-ASK-f6864c33";
const GATE = ["gate", "request", "prd", SUBJECT, "--artifact", "notes.md"];
const CARD = ["card", "open", "--subject", SUBJECT, "--ask", ASK, "--options", "a|b"];

/** The failure the user must see: non-zero, one plain line, no stack, nothing private. */
const plainRefusal = (r: Result, secrets: string[]): void => {
  ok(r.code !== 0 && r.code !== -1, `must exit non-zero (not hang, not 0), got ${r.code}: ${JSON.stringify(r.err)}`);
  ok(!/^\s+at /m.test(r.err), `stderr must hold no stack frame ("    at "): ${JSON.stringify(r.err)}`);
  ok(!/\bNode\.js v\d/.test(r.err), `stderr must not carry the Node version footer: ${JSON.stringify(r.err)}`);
  const lines = r.err.split("\n").filter((l) => l.trim() !== "");
  eq(lines.length, 1, `stderr must be exactly one line, got ${lines.length}: ${JSON.stringify(r.err)}`);
  ok(/^project-companion: /.test(lines[0]) && /event log/.test(lines[0]), `the line must name the event log: ${lines[0]}`);
  for (const s of [...secrets, process.cwd(), TMP, "file://", ".mjs"]) {
    ok(!r.err.includes(s), `stderr must not hold ${JSON.stringify(s)}: ${JSON.stringify(r.err)}`);
  }
};

test("f6864c33: gate request after a planted own shard prints one plain line and exits non-zero", async () => {
  const dir = await project();
  const target = join(outside(), "target.txt");
  writeFileSync(target, "OUTSIDE\n");
  plantShard(dir, target);

  const r = await pc(dir, GATE);

  plainRefusal(r, [SUBJECT, target, dir]);
  eq(readFileSync(target, "utf8"), "OUTSIDE\n", "the outside file must be unchanged");
});

test("f6864c33: card open after a planted own shard prints one plain line and exits non-zero", async () => {
  const dir = await project();
  const target = join(outside(), "target.txt");
  writeFileSync(target, "OUTSIDE\n");
  plantShard(dir, target);

  const r = await pc(dir, CARD);

  plainRefusal(r, [SUBJECT, ASK, target, dir]);
  eq(readFileSync(target, "utf8"), "OUTSIDE\n", "the outside file must be unchanged");
});

test("f6864c33: gate request with a planted .project-log prints one plain line and writes nothing outside", async () => {
  const dir = await project();
  const elsewhere = outside();
  plantFolder(dir, elsewhere);

  const r = await pc(dir, GATE);

  plainRefusal(r, [SUBJECT, elsewhere, dir]);
  eq(readdirSync(elsewhere).length, 0, "nothing may be written through a planted .project-log");
});

test("f6864c33: card open with a planted .project-log prints one plain line and writes nothing outside", async () => {
  const dir = await project();
  const elsewhere = outside();
  plantFolder(dir, elsewhere);

  const r = await pc(dir, CARD);

  plainRefusal(r, [SUBJECT, ASK, elsewhere, dir]);
  eq(readdirSync(elsewhere).length, 0, "nothing may be written through a planted .project-log");
});

test("f6864c33: gate request and card open in a normal project still work, with no extra output (control)", async () => {
  const dir = await project();

  const g = await pc(dir, GATE);
  eq(g.code, 0, g.err);
  eq(g.err, "", `no stderr when the log works: ${JSON.stringify(g.err)}`);
  ok(g.out.includes("Requested the prd gate"), g.out);

  const c = await pc(dir, CARD);
  eq(c.code, 0, c.err);
  eq(c.err, "", `no stderr when the log works: ${JSON.stringify(c.err)}`);
  ok(/Opened card c-[0-9a-f]{6}\./.test(c.out), c.out);
});

test("f6864c33: a gate error that is not a log refusal keeps its own plain line (control)", async () => {
  const dir = await project();
  const r = await pc(dir, ["gate", "request", "prd", "x", "--artifact", "missing.md"]);
  ok(r.code !== 0, "a missing artifact is still refused");
  ok(!/^\s+at /m.test(r.err), `no stack frame: ${JSON.stringify(r.err)}`);
  ok(r.err.includes("do not exist"), r.err);
});

runAll().then((failed) => {
  rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
});
