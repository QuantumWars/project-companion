/**
 * QA gap test for bug f6864c33: the top-level handler in `cli/index.ts` must
 * catch only `LogRefusedError`.
 *
 * `tests/bug-f6864c33.test.ts` passes even when the handler is widened to catch
 * every error, because no test makes `main()` throw anything else. Here
 * `update draft --file <missing>` throws an ENOENT from `readFileSync` before
 * any log write. The handler must let it out unchanged: no event-log line, and
 * Node's own report (an `    at ` frame) on stderr. The `run start` case in the
 * same planted state is not used: it is a different error that bug f6864c33
 * leaves out of scope, and its output may change.
 *
 * Run it with `npm test -- qa-f6864c33` (notifications are then off).
 */

import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq, ok, runAll, test } from "./harness";

if (process.env.PROJECT_COMPANION_NOTIFY !== "off") {
  process.stderr.write("qa-f6864c33-rethrow.test.ts: PROJECT_COMPANION_NOTIFY is not off; run this suite with npm test -- qa-f6864c33\n");
  process.exit(1);
}

const CLI = join(process.cwd(), "dist", "project-companion.mjs");
const TMP = realpathSync(mkdtempSync(join(tmpdir(), "pc-qa-f6864c33-")));
const HOME = join(TMP, "home"); // never the real ~/.claude (test rule 5)
mkdirSync(HOME);
const { CLAUDE_PROJECT_DIR: _dir, ...BASE_ENV } = process.env;
const ENV = { ...BASE_ENV, HOME };

type Result = { code: number; err: string };

const pc = (dir: string, args: string[]): Promise<Result> =>
  new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, ...args], { cwd: dir, env: ENV, timeout: 10_000 }, (e, _out, err) => {
      const code = e ? ((e as { code?: unknown }).code as number | undefined) : 0;
      resolve({ code: typeof code === "number" ? code : -1, err });
    });
    child.stdin!.end("");
  });

test("f6864c33 QA: an error that is not a log refusal is rethrown, not turned into the event-log line", async () => {
  const dir = realpathSync(mkdtempSync(join(TMP, "p-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "dev@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "A Dev"], { cwd: dir });
  eq((await pc(dir, ["init", "Demo"])).code, 0);

  const r = await pc(dir, ["update", "draft", "w1", "--health", "on-track", "--reason", "r", "--file", "missing-f6864c33.md"]);

  ok(r.code !== 0 && r.code !== -1, `must exit non-zero (not hang), got ${r.code}`);
  ok(/ENOENT/.test(r.err), `the real error must reach stderr: ${JSON.stringify(r.err)}`);
  ok(/^\s+at /m.test(r.err), `an error that is not a log refusal keeps Node's own report: ${JSON.stringify(r.err)}`);
  ok(!/event log/.test(r.err), `must not print the event-log line for another error: ${JSON.stringify(r.err)}`);
});

runAll().then((failed) => {
  rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
});
