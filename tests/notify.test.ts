import { spawnSync } from "node:child_process";
import {
  appendFileSync, chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync,
  rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { appendRecord, codeOf, NOTIFY_DIR, NOTIFY_RECORD, readRecord, RecordError, recordPath, type RecordLine } from "@/lib/project/notify-record";

import { eq, ok, runAll, test, throws } from "./harness";

/**
 * Decision alerts. No test here may show a notification to the PM (TH-19), so:
 * the runner sets PROJECT_COMPANION_NOTIFY=off (else the suite stops at once),
 * the suite never changes process.env, and `stubEnv` is the only way to turn
 * notifications on. It accepts only a notifier in the suite's temporary folder.
 */

if (process.env.PROJECT_COMPANION_NOTIFY !== "off") {
  process.stderr.write("notify.test.ts: PROJECT_COMPANION_NOTIFY is not off; run this suite with npm test -- notify\n");
  process.exit(1);
}

const TMP = realpathSync(mkdtempSync(join(tmpdir(), "pc-notify-")));
const STUB_OUT = join(TMP, "out");
const STUB_HOLD = join(TMP, "hold");
mkdirSync(STUB_OUT);

/** Saves its arguments (each ends in NUL), waits while STUB_HOLD exists (600 polls at most), then writes <pid>.done. */
const STUB = join(TMP, "notifier-stub");
writeFileSync(STUB, [
  "#!/bin/sh",
  '[ -n "${STUB_OUT:-}" ] || exit 0',
  "printf '%s\\0' \"$@\" > \"$STUB_OUT/$$.tmp\"",
  'mv "$STUB_OUT/$$.tmp" "$STUB_OUT/$$.argv"',
  'if [ -n "${STUB_HOLD:-}" ]; then',
  "  i=0",
  '  while [ -e "$STUB_HOLD" ] && [ "$i" -lt 600 ]; do sleep 0.05 2>/dev/null || sleep 1; i=$((i+1)); done',
  "fi",
  ': > "$STUB_OUT/$$.done"',
  "",
].join("\n"));
chmodSync(STUB, 0o755);

const stubEnv = (notifier: string): NodeJS.ProcessEnv => {
  if (!notifier || !isAbsolute(notifier) || dirname(resolve(notifier)) !== TMP) {
    throw new Error(`stubEnv: the notifier must be an absolute path inside the suite's temporary folder, got ${JSON.stringify(notifier)}`);
  }
  return { ...process.env, PROJECT_COMPANION_NOTIFY: "on", PROJECT_COMPANION_PLATFORM: "darwin", PROJECT_COMPANION_NOTIFIER: notifier, STUB_OUT, STUB_HOLD };
};

/* ------------------------------ the off switch ----------------------------- */

test("DA-03.2: the runner sets PROJECT_COMPANION_NOTIFY=off", () => {
  eq(process.env.PROJECT_COMPANION_NOTIFY, "off", "run this suite with `npm test -- notify`");
});

test("TH-19: stubEnv refuses an empty or relative path", () => {
  const before = { ...process.env };
  throws(() => stubEnv(""), /absolute path/);
  throws(() => stubEnv("relative/x"), /absolute path/);
  throws(() => stubEnv("osascript"), /absolute path/);
  throws(() => stubEnv("/usr/bin/osascript"), /inside the suite's temporary folder/);
  eq(stubEnv(join(TMP, "missing")).PROJECT_COMPANION_NOTIFIER, join(TMP, "missing"), "<tmp>/missing is allowed");
  const env = stubEnv(STUB);
  eq(
    [env.PROJECT_COMPANION_NOTIFY, env.PROJECT_COMPANION_PLATFORM, env.PROJECT_COMPANION_NOTIFIER, env.STUB_OUT, env.STUB_HOLD],
    ["on", "darwin", STUB, STUB_OUT, STUB_HOLD],
  );
  eq(env.PATH, process.env.PATH, "the rest of the environment is kept");
  eq(process.env, before, "stubEnv must not change process.env");
});

/* --------------------------------- the stub -------------------------------- */

test("stub: exits at once and writes nothing when STUB_OUT is not set", () => {
  // A held STUB_HOLD would make a stub without the guard wait until the timeout.
  const { STUB_OUT: _out, STUB_HOLD: _hold, ...env } = process.env;
  writeFileSync(STUB_HOLD, "");
  try {
    const run = spawnSync(STUB, ["x"], { env: { ...env, STUB_HOLD }, encoding: "utf8", timeout: 5000 });
    eq([run.error?.message, run.status, run.stdout, run.stderr], [undefined, 0, "", ""]);
    eq(readdirSync(STUB_OUT), []);
  } finally { rmSync(STUB_HOLD, { force: true }); }
});

test("stub: saves each argument with a NUL, then writes <pid>.done", () => {
  const run = spawnSync(STUB, ["-e", "a b", ""], { env: stubEnv(STUB), encoding: "utf8", timeout: 5000 });
  try {
    eq([run.error?.message, run.status], [undefined, 0]);
    eq(readFileSync(join(STUB_OUT, `${run.pid}.argv`), "utf8"), "-e\0a b\0\0");
    ok(existsSync(join(STUB_OUT, `${run.pid}.done`)), "no <pid>.done");
    eq(readdirSync(STUB_OUT).sort(), [`${run.pid}.argv`, `${run.pid}.done`]);
  } finally { for (const f of readdirSync(STUB_OUT)) rmSync(join(STUB_OUT, f)); }
});

/* ------------------------- the notification record ------------------------- */

/** A new empty folder in TMP, so the suite's clean-up removes it. */
const project = (prefix = "project-"): string => mkdtempSync(join(TMP, prefix));
const LINE: RecordLine = { id: "gate:prd:x", at: "2026-10-09T00:00:00.000Z", title: "Approve x", command: "/devolps:approve prd x", outcome: "off" };
const recordError = (run: () => unknown): RecordError => {
  try { run(); } catch (error) { if (error instanceof RecordError) return error; throw error; }
  throw new Error("expected a RecordError, but nothing was thrown");
};

test("DA-04.2: git ignores the record path, outside .project-cache/ and .project-log/", () => {
  eq([NOTIFY_RECORD, recordPath("/r")], [".project-notify/record.jsonl", "/r/.project-notify/record.jsonl"]);
  const run = spawnSync("git", ["check-ignore", "-v", NOTIFY_RECORD], { encoding: "utf8" });
  eq([run.error?.message, run.status], [undefined, 0], `git check-ignore: ${run.stderr}`);
  ok(/^\.gitignore:\d+:\/\.project-notify\/\t\.project-notify\/record\.jsonl\n$/.test(run.stdout), `not the root .gitignore rule: ${run.stdout}`);
  ok(![".project-cache", ".project-log"].includes(NOTIFY_RECORD.split("/")[0]), "the record is inside the cache or the event log");
});

test("TH-13: the first append writes .gitignore \"*\\n\"; the folder is 0o700 and the record 0o600", () => {
  const root = project();
  appendRecord(root, LINE);
  eq(readFileSync(join(root, NOTIFY_DIR, ".gitignore"), "utf8"), "*\n");
  eq([lstatSync(join(root, NOTIFY_DIR)).mode & 0o777, lstatSync(recordPath(root)).mode & 0o777], [0o700, 0o600]);
  eq(readRecord(root), [LINE]);
});

test("TH-13: .gitignore is written before the record is opened", () => {
  const root = project();
  mkdirSync(recordPath(root), { recursive: true }); // a folder at record.jsonl makes the open fail
  eq(recordError(() => appendRecord(root, LINE)).message, `EISDIR ${recordPath(root)}`);
  eq(readFileSync(join(root, NOTIFY_DIR, ".gitignore"), "utf8"), "*\n");
});

test("TH-13: a .gitignore error other than EEXIST stops the append (skipped as root)", () => {
  if (process.getuid?.() === 0) return; // root ignores folder modes, so the write would not fail
  const root = project();
  const folder = join(root, NOTIFY_DIR);
  mkdirSync(folder, { mode: 0o700 });
  writeFileSync(recordPath(root), "", { mode: 0o600 });
  chmodSync(folder, 0o500);
  try {
    eq(recordError(() => appendRecord(root, LINE)).message, `EACCES ${join(folder, ".gitignore")}`);
    eq(readFileSync(recordPath(root), "utf8"), "", "a line was appended");
  } finally { chmodSync(folder, 0o700); }
});

test("TH-13: a dangling .gitignore symlink is kept, its target is not made, and the append happens", () => {
  const root = project();
  const target = join(root, "made-through-the-link");
  mkdirSync(join(root, NOTIFY_DIR), { mode: 0o700 });
  symlinkSync(target, join(root, NOTIFY_DIR, ".gitignore"));
  appendRecord(root, LINE);
  eq(readRecord(root), [LINE]);
  ok(!existsSync(target), "the symlink target was created");
  ok(lstatSync(join(root, NOTIFY_DIR, ".gitignore")).isSymbolicLink(), "the symlink was replaced");
});

test("TH-15: a title with line breaks gives exactly one record line", () => {
  const root = project();
  const title = 'one\ntwo\r\n{"id":"forged","outcome":"sent"}';
  appendRecord(root, { ...LINE, title });
  eq(readFileSync(recordPath(root), "utf8").split("\n").length, 2, "one line and its final line break");
  eq(readRecord(root).map((l) => l.title), [title]);
});

test("record line: keys in the design order, reason only on failed; readRecord skips bad lines", () => {
  const root = project();
  appendRecord(root, { outcome: "sent", command: null, title: null, at: "t", id: "c-1" });
  appendRecord(root, { ...LINE, outcome: "failed", reason: "ENOENT /x" });
  appendRecord(root, { ...LINE, reason: "dropped" } as RecordLine);
  appendFileSync(recordPath(root), "not json\n");
  eq(readRecord(root).map((l) => Object.keys(l).join()), ["id,at,title,command,outcome", "id,at,title,command,outcome,reason", "id,at,title,command,outcome"]);
});

test("TH-21: a symlinked record.jsonl gives ELOOP and writes nothing", () => {
  const root = project();
  const outside = join(project("outside-"), "target.txt");
  writeFileSync(outside, "keep\n");
  mkdirSync(join(root, NOTIFY_DIR), { mode: 0o700 });
  symlinkSync(outside, recordPath(root));
  const error = recordError(() => appendRecord(root, LINE));
  eq([error.code, error.target, error.message], ["ELOOP", recordPath(root), `ELOOP ${recordPath(root)}`]);
  eq(readFileSync(outside, "utf8"), "keep\n");
});

test("TH-21: a symlinked .project-notify gives ENOTDIR and makes nothing in its target", () => {
  const root = project();
  const outside = project("outside-");
  symlinkSync(outside, join(root, NOTIFY_DIR));
  const error = recordError(() => appendRecord(root, LINE));
  eq([error.code, error.target, error.message], ["ENOTDIR", join(root, NOTIFY_DIR), `ENOTDIR ${join(root, NOTIFY_DIR)}`]);
  eq(readdirSync(outside), []);
  const file = project(); // a regular file named .project-notify gives the same reason
  writeFileSync(join(file, NOTIFY_DIR), "");
  eq(recordError(() => appendRecord(file, LINE)).message, `ENOTDIR ${join(file, NOTIFY_DIR)}`);
});

test("TH-8: a FIFO at record.jsonl gives EFTYPE and writes nothing (skipped without mkfifo)", () => {
  const root = project();
  mkdirSync(join(root, NOTIFY_DIR), { mode: 0o700 });
  const made = spawnSync("mkfifo", [recordPath(root)]);
  if (made.error || made.status !== 0) return;
  // Open a reader first (O_NONBLOCK, so this never waits). Then no open of the FIFO can wait: a regression fails, it does not hang.
  const reader = openSync(recordPath(root), constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    eq(recordError(() => appendRecord(root, LINE)).message, `EFTYPE ${recordPath(root)}`);
    let bytes = 0;
    try { bytes = readSync(reader, Buffer.alloc(64)); } catch (error) { if (codeOf(error) !== "EAGAIN") throw error; }
    eq(bytes, 0, "bytes reached the FIFO");
  } finally { closeSync(reader); }
});

runAll().then((failed) => {
  rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
});
