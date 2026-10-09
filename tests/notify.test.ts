import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync, chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync,
  rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { logDir, readEvents } from "@/lib/project/events";
import { approveGate, requestGate } from "@/lib/project/gate";
import {
  controlsToSpaces, decisionText, dispatch, DispatchError, failureReason, NOTIFIER, NOTIFIER_ENV, notifierArgs, notifierPath, notifyDecision, NOTIFY_ENV,
  NOTIFY_SCRIPT, type NotifyText, osascriptArgs, PLATFORM_ENV,
} from "@/lib/project/notify";
import { appendRecord, codeOf, NOTIFY_DIR, NOTIFY_RECORD, readRecord, RecordError, recordPath, type RecordLine } from "@/lib/project/notify-record";
import { initProject } from "@/lib/project/store";

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
// A stub started in-process gets process.env, and it writes wherever STUB_OUT points.
if (process.env.STUB_OUT !== undefined || process.env.STUB_HOLD !== undefined) {
  process.stderr.write("notify.test.ts: STUB_OUT or STUB_HOLD is set in the environment; unset them to run this suite\n");
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
  'ps -o pgid= -p $$ | tr -d " " > "$STUB_OUT/$$.pgid"', // TH-7: a detached child leads its own process group
  'if [ -n "${STUB_HOLD:-}" ]; then',
  "  i=0",
  '  while [ -e "$STUB_HOLD" ] && [ "$i" -lt 600 ]; do sleep 0.05 2>/dev/null || sleep 1; i=$((i+1)); done',
  "fi",
  ': > "$STUB_OUT/$$.done"',
  "",
].join("\n"));
chmodSync(STUB, 0o755);

/** Writes its argument count to SENT_WITNESS. The path is in the script, not the environment, so it works in process. */
const SENT_STUB = join(TMP, "sent-stub");
const SENT_WITNESS = join(TMP, "sent-witness");
writeFileSync(SENT_STUB, `#!/bin/sh\nprintf '%s' "$#" > '${SENT_WITNESS}.tmp' && mv '${SENT_WITNESS}.tmp' '${SENT_WITNESS}'\n`);
chmodSync(SENT_STUB, 0o755);

/**
 * The overrides can set only the switch to "off" and the platform. They are never spread, so they cannot change the
 * notifier: a regression that ignores the switch or the platform starts only the stub.
 */
type StubOverrides = { notify?: "off"; platform?: string };
const stubEnv = (notifier: string, overrides: StubOverrides = {}): NodeJS.ProcessEnv => {
  if (!notifier || !isAbsolute(notifier) || dirname(resolve(notifier)) !== TMP) {
    throw new Error(`stubEnv: the notifier must be an absolute path inside the suite's temporary folder, got ${JSON.stringify(notifier)}`);
  }
  let isLink = false;
  try { isLink = lstatSync(notifier).isSymbolicLink(); } catch { /* a missing path, such as <tmp>/missing, is allowed */ }
  if (isLink) throw new Error(`stubEnv: the notifier must not be a symlink, got ${JSON.stringify(notifier)}`);
  const notify = overrides.notify === "off" ? "off" : "on";
  const platform = typeof overrides.platform === "string" ? overrides.platform : "darwin";
  return { ...process.env, PROJECT_COMPANION_NOTIFY: notify, PROJECT_COMPANION_PLATFORM: platform, PROJECT_COMPANION_NOTIFIER: notifier, STUB_OUT, STUB_HOLD };
};

// S5: if this ever drifts, every stubEnv(STUB) test would quietly stop exercising the stub.
if (notifierPath(stubEnv(STUB)) !== STUB) {
  process.stderr.write("notify.test.ts: notifierPath(stubEnv(STUB)) is not STUB; the stub safety guard is broken\n");
  process.exit(1);
}

/* ------------------------------ the off switch ----------------------------- */

test("DA-03.2: the runner sets PROJECT_COMPANION_NOTIFY=off", () => {
  eq(process.env.PROJECT_COMPANION_NOTIFY, "off", "run this suite with `npm test -- notify`");
});

test("TH-19: stubEnv refuses an empty or relative path; its overrides set only the switch and the platform", () => {
  const before = { ...process.env };
  throws(() => stubEnv(""), /absolute path/);
  throws(() => stubEnv("relative/x"), /absolute path/);
  throws(() => stubEnv("osascript"), /absolute path/);
  throws(() => stubEnv("/usr/bin/osascript"), /inside the suite's temporary folder/);
  eq(stubEnv(join(TMP, "missing")).PROJECT_COMPANION_NOTIFIER, join(TMP, "missing"), "<tmp>/missing is allowed");
  const link = join(TMP, "a-symlink");
  symlinkSync(STUB, link);
  throws(() => stubEnv(link), /must not be a symlink/);
  const env = stubEnv(STUB);
  eq(
    [env.PROJECT_COMPANION_NOTIFY, env.PROJECT_COMPANION_PLATFORM, env.PROJECT_COMPANION_NOTIFIER, env.STUB_OUT, env.STUB_HOLD],
    ["on", "darwin", STUB, STUB_OUT, STUB_HOLD],
  );
  eq(env.PATH, process.env.PATH, "the rest of the environment is kept");
  const pick = (e: NodeJS.ProcessEnv) => [e.PROJECT_COMPANION_NOTIFY, e.PROJECT_COMPANION_PLATFORM, e.PROJECT_COMPANION_NOTIFIER];
  eq(pick(stubEnv(STUB, { notify: "off", platform: "linux" })), ["off", "linux", STUB]);
  eq(pick(stubEnv(STUB, { platform: "win32" })), ["on", "win32", STUB]);
  // A cast cannot turn an override into another switch value or a notifier.
  const forced = { notify: "yes", notifier: NOTIFIER, PROJECT_COMPANION_NOTIFIER: NOTIFIER } as unknown as StubOverrides;
  eq(pick(stubEnv(STUB, forced)), ["on", "darwin", STUB]);
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
    eq(readdirSync(STUB_OUT).sort(), [`${run.pid}.argv`, `${run.pid}.done`, `${run.pid}.pgid`]);
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

/* ------------------------- the notifier's arguments ------------------------ */

const PREFIX = [
  "-e", "on run argv",
  "-e", "display notification (item 2 of argv) with title (item 1 of argv) subtitle (item 3 of argv)",
  "-e", "end run",
  "--",
];
const hostile = (tag: string) => `-e "${tag}\\x"\n" & (do shell script "touch PWNED") & "`;
const HOSTILE: NotifyText = { title: hostile("title"), command: hostile("command"), project: hostile("project") };

test("DA-02.4: notifierArgs gives 10 items, text only after --", () => {
  const args = notifierArgs(HOSTILE);
  const text = [HOSTILE.title, HOSTILE.command, HOSTILE.project];
  eq(args.length, 10);
  eq([args.slice(0, 7), args.slice(7)], [PREFIX, text]);
  eq(NOTIFY_SCRIPT, [PREFIX[1], PREFIX[3], PREFIX[5]], "NOTIFY_SCRIPT is not the design's 3 lines");
  const scripts = args.flatMap((arg, i) => (arg === "-e" ? [args[i + 1]] : []));
  eq(scripts.length, 3);
  for (const script of scripts) ok(!text.some((t) => script.includes(t)), `text inside an -e value: ${JSON.stringify(script)}`);
});

test("TH-3: notifierPath defaults to /usr/bin/osascript and takes the override", () => {
  eq([NOTIFY_ENV, NOTIFIER_ENV, PLATFORM_ENV, NOTIFIER], ["PROJECT_COMPANION_NOTIFY", "PROJECT_COMPANION_NOTIFIER", "PROJECT_COMPANION_PLATFORM", "/usr/bin/osascript"]);
  eq(notifierPath({}), "/usr/bin/osascript");
  eq(notifierPath({ PROJECT_COMPANION_NOTIFIER: "/x" }), "/x");
  eq(notifierPath({ PROJECT_COMPANION_NOTIFIER: "" }), "/usr/bin/osascript", "an empty value gives the default");
  eq(notifierPath(stubEnv(STUB)), STUB);
});

/** Design 3.4: it returns the argument count and every argument, joined by U+001F. It shows nothing. */
const ECHO_SCRIPT = [
  "on run argv",
  "set AppleScript's text item delimiters to (character id 31)",
  "return ((count of argv) as text) & (character id 31) & (argv as text)",
  "end run",
];
const FLAGS = ["-e", "-l", "JavaScript", "-i", "--"];
const TEXT = ['x"y\\z\nnext line', 'do shell script "echo pwned"', '" & (do shell script "echo pwned") & "'];

test("DA-02.4: osascript passes every argument after -- unchanged", () => {
  const osascript = "/usr/bin/osascript";
  if (process.platform !== "darwin" || !existsSync(osascript)) {
    process.stdout.write(`       skipped: platform ${process.platform}, ${osascript} ${existsSync(osascript) ? "present" : "absent"}\n`);
    return;
  }
  const lists = [[...FLAGS, ...TEXT], [TEXT[0], ...FLAGS, TEXT[1], TEXT[2]], [...TEXT, ...FLAGS], ["--", "-e", "return 1", "--", "-l", "JavaScript", "-i", "--"]];
  for (const inputs of lists) {
    // An argument array and no shell. The timeout is a failure guard, not a requirement.
    const out = execFileSync(osascript, osascriptArgs(ECHO_SCRIPT, inputs), { encoding: "utf8", shell: false, timeout: 10_000 });
    ok(out.endsWith("\n"), `no final line break: ${JSON.stringify(out)}`);
    eq(out.slice(0, -1).split("\u001f"), [String(inputs.length), ...inputs]);
  }
});

/* -------------------------------- dispatch --------------------------------- */
// Every dispatch call uses notifierPath(stubEnv(...)), except the commented TH-3 calls: dispatch has no off switch (TH-19).

const dispatchFailure = (run: () => unknown): [string, string | null] => {
  try { run(); } catch (error) { if (error instanceof DispatchError) return [error.step, error.code]; throw error; }
  throw new Error("expected a DispatchError, but nothing was thrown");
};

test("dispatch: a missing notifier fails at accessSync, a folder gives no pid, a NUL fails at spawn", async () => {
  eq(dispatchFailure(() => dispatch(notifierPath(stubEnv(join(TMP, "missing"))), notifierArgs(HOSTILE))), ["access", "ENOENT"]);
  const folder = join(TMP, "a-folder");
  mkdirSync(folder);
  eq(dispatchFailure(() => dispatch(notifierPath(stubEnv(folder)), [])), ["pid", null]);
  eq(dispatchFailure(() => dispatch(notifierPath(stubEnv(STUB)), ["a\0b"])), ["spawn", "ERR_INVALID_ARG_VALUE"]);
  await new Promise((done) => setImmediate(done)); // the folder's late 'error' event: without the listener, the suite crashes
});

test("TH-3: dispatch refuses a program path that is not absolute", () => {
  // The one exception to the stubEnv rule for dispatch(): names that are not on PATH, so a regression still starts nothing.
  eq(dispatchFailure(() => dispatch("pc-no-such-notifier", [])), ["path", null]);
  eq(dispatchFailure(() => dispatch("relative/pc-no-such-notifier", [])), ["path", null]);
});

test("dispatch: the stub starts, and dispatch returns its pid", () => {
  // process.env has no STUB_OUT, so the stub exits at once and writes nothing.
  const pid = dispatch(notifierPath(stubEnv(STUB)), notifierArgs(HOSTILE));
  ok(Number.isInteger(pid) && pid > 0, `not a pid: ${pid}`);
});

/* ------------------------------ notifyDecision ----------------------------- */
// Every notifyDecision call passes a stubEnv(...) env, never process.env or the default env (TH-19).

const GATE = "gate:prd:alerts";
const GATE_LINE = { id: GATE, title: 'Approve the requirements for "alerts"', command: "/devolps:approve prd alerts" };
const LOST_LINE = { id: "c-000000", title: null, command: null }; // an id that is not in the cockpit
const NOT_SENT = "project-companion: notification not sent: "; // design 3.3, "Standard error lines" (DA-02.2)

/** A project in TMP whose cockpit holds one requested gate, GATE. */
const gateProject = (): string => {
  const root = project();
  initProject(root, "Demo");
  requestGate(root, { kind: "prd", subject: "alerts", artifacts: [] });
  return root;
};
/** The record's lines without the time, which changes on each run. */
const lines = (root: string) => readRecord(root).map(({ at: _at, ...rest }) => rest);

/** Runs `run` with stdout and stderr captured, then restores both. It does not change process.env. */
const captured = <T>(run: () => T): [T, string, string] => {
  const { stdout, stderr } = process;
  const [outWrite, errWrite] = [stdout.write, stderr.write];
  let [out, err] = ["", ""];
  stdout.write = ((chunk: unknown) => { out += String(chunk); return true; }) as typeof stdout.write;
  stderr.write = ((chunk: unknown) => { err += String(chunk); return true; }) as typeof stderr.write;
  try {
    const value = run();
    return [value, out, err];
  } finally { stdout.write = outWrite; stderr.write = errWrite; }
};

test("DA-03.1: off passes no notification", () => {
  const root = gateProject();
  eq(captured(() => notifyDecision(root, GATE, stubEnv(STUB, { notify: "off" }))), ["off", "", ""]);
  // Row 1 comes before rows 2 and 3: a failed lookup on linux with the switch off is still "off".
  eq(captured(() => notifyDecision(root, LOST_LINE.id, stubEnv(STUB, { notify: "off", platform: "linux" }))), ["off", "", ""]);
  eq(lines(root), [{ ...GATE_LINE, outcome: "off" }, { ...LOST_LINE, outcome: "off" }]);
});

test("DA-03.3: linux and win32 pass no notification", () => {
  for (const platform of ["linux", "win32"]) {
    const root = gateProject();
    eq(captured(() => notifyDecision(root, GATE, stubEnv(STUB, { platform }))), ["unsupported", "", ""], platform);
    eq(captured(() => notifyDecision(root, LOST_LINE.id, stubEnv(STUB, { platform }))), ["unsupported", "", ""], platform); // row 2 before row 3
    eq(lines(root), [{ ...GATE_LINE, outcome: "unsupported" }, { ...LOST_LINE, outcome: "unsupported" }], platform);
  }
});

test("notifyDecision: the stub starts with 10 arguments, and one line records sent", async () => {
  // SENT_STUB writes the witness, so a change that starts another notifier fails here (TH-19).
  const root = gateProject();
  try {
    eq(captured(() => notifyDecision(root, GATE, stubEnv(SENT_STUB))), ["sent", "", ""]);
    let polls = 0; // 250 polls of 20 ms: about 5 s, a failure guard, not a requirement
    while (!existsSync(SENT_WITNESS) && polls++ < 250) await new Promise((done) => setTimeout(done, 20));
    eq(existsSync(SENT_WITNESS) ? readFileSync(SENT_WITNESS, "utf8") : "no witness after 5 s", "10", "the stub's argument count");
    eq(lines(root), [{ ...GATE_LINE, outcome: "sent" }]);
    const [line] = readRecord(root);
    eq([Object.keys(line).join(), new Date(line.at).toISOString()], ["id,at,title,command,outcome", line.at]);
  } finally { rmSync(SENT_WITNESS, { force: true }); }
});

test("notifyDecision: a failure records failed and a reason without decision text, writes no stdout, and does not throw", () => {
  const root = gateProject();
  const missing = join(TMP, "missing");
  const runs = [captured(() => notifyDecision(root, "c-000000", stubEnv(STUB))), captured(() => notifyDecision(root, GATE, stubEnv(missing)))];
  const notSent = [`${NOT_SENT}not in the cockpit: c-000000\n`, `${NOT_SENT}ENOENT ${missing}\n`];
  runs.forEach(([outcome, out, err], i) => {
    eq([outcome, out, err], ["failed", "", notSent[i]]);
    ok(![GATE_LINE.title, GATE_LINE.command, "Demo"].some((t) => err.includes(t)), `decision text on stderr: ${err}`);
  });
  // A failed lookup gives null text. A dispatch failure keeps the text, and its reason is the code and the path.
  eq(lines(root), [
    { id: "c-000000", title: null, command: null, outcome: "failed", reason: "not in the cockpit: c-000000" },
    { ...GATE_LINE, outcome: "failed", reason: `ENOENT ${missing}` },
  ]);
});

test("DA-02.2: a missing notifier gives one stderr line", () => {
  const root = gateProject();
  eq(captured(() => notifyDecision(root, GATE, stubEnv(join(TMP, "missing")))), ["failed", "", `${NOT_SENT}ENOENT ${TMP}/missing\n`]);
  // A line break in the path becomes one space, in the stderr line and in the record alike.
  eq(captured(() => notifyDecision(root, GATE, stubEnv(join(TMP, "miss\ning")))), ["failed", "", `${NOT_SENT}ENOENT ${TMP}/miss ing\n`]);
  eq(lines(root), [`ENOENT ${TMP}/missing`, `ENOENT ${TMP}/miss ing`].map((reason) => ({ ...GATE_LINE, outcome: "failed" as const, reason })));
});

test("notifyDecision: a folder as the notifier gives \"did not start <folder>\"", async () => {
  const root = gateProject();
  const folder = join(TMP, "folder-notifier");
  mkdirSync(folder);
  eq(captured(() => notifyDecision(root, GATE, stubEnv(folder))), ["failed", "", `${NOT_SENT}did not start ${folder}\n`]);
  await new Promise((done) => setImmediate(done)); // the folder's late 'error' event must not crash the suite
});

test("failureReason: \"not an absolute path: pc-no-such-notifier\", and never the error's message", () => {
  // Through failureReason, not notifyDecision: stubEnv refuses a relative notifier, and nothing starts here.
  eq(failureReason(new DispatchError("path", null), "pc-no-such-notifier"), "not an absolute path: pc-no-such-notifier");
  eq(failureReason(Object.assign(new Error(GATE_LINE.title), { code: "EPERM" }), "/x"), "EPERM");
});

test("TH-5: a NUL in the project name gives ERR_INVALID_ARG_VALUE, and the name is not on stderr", () => {
  const root = project();
  initProject(root, "Secret\u0000Name");
  requestGate(root, { kind: "prd", subject: "alerts", artifacts: [] });
  ok(readFileSync(join(root, ".project"), "utf8").includes("Secret\\u0000Name"), "no \\u0000 in .project");
  eq(decisionText(root, GATE).project, "Secret\u0000Name", "the lookup does not give the name");
  const [outcome, out, err] = captured(() => notifyDecision(root, GATE, stubEnv(STUB)));
  eq([outcome, out, err], ["failed", "", `${NOT_SENT}ERR_INVALID_ARG_VALUE\n`]);
  ok(!err.includes("Secret") && !err.includes("Name"), `the project name is on stderr: ${err}`);
});

/** gateProject, plus an approved design gate on docs/a.md, so each lookup re-hashes it (withStaleness, hashArtifact). */
const approvedProject = (): string => {
  const root = gateProject();
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs", "a.md"), "# A\n");
  requestGate(root, { kind: "design", subject: "alerts", artifacts: ["docs/a.md"] });
  approveGate(root, { kind: "design", subject: "alerts", via: "prompt:test" });
  return root;
};

test("TH-5: a folder in place of an approved artifact gives lookup failed: EISDIR", () => {
  // Design TH-5 (SR-4). It depends on how hashArtifact reads files today: the SR-8 bugfix must update this test.
  const root = approvedProject();
  eq(decisionText(root, GATE).title, GATE_LINE.title, "the lookup fails before the swap");
  rmSync(join(root, "docs", "a.md"));
  mkdirSync(join(root, "docs", "a.md"));
  eq(captured(() => notifyDecision(root, GATE, stubEnv(STUB))), ["failed", "", `${NOT_SENT}lookup failed: EISDIR\n`]);
  eq(lines(root), [{ id: GATE, title: null, command: null, outcome: "failed", reason: "lookup failed: EISDIR" }]);
});

/** Every line of every file in the project's event log, so any append, of any kind, changes the result. */
const logLines = (root: string): string[] =>
  readdirSync(logDir(root)).sort().flatMap((name) => readFileSync(join(logDir(root), name), "utf8").split("\n").filter(Boolean));

test("DA-02.5: the notifier appends no event", async () => {
  const root = approvedProject(); // with an approved artifact, each lookup also runs the staleness re-hash (TH-16)
  const [events, bytes] = [logLines(root), readFileSync(join(root, ".project"))];
  ok(events.length > 0, "the temporary project's log has no event");
  const run = (label: string, id: string, notifier: string, overrides: StubOverrides, outcome: string): void => {
    eq(captured(() => notifyDecision(root, id, stubEnv(notifier, overrides)))[0], outcome, label);
    eq(logLines(root), events, `${label}: the event log changed`);
    ok(readFileSync(join(root, ".project")).equals(bytes), `${label}: .project changed`);
  };
  run("off", GATE, STUB, { notify: "off" }, "off");
  run("unsupported", GATE, STUB, { platform: "linux" }, "unsupported");
  run("sent", GATE, STUB, {}, "sent");
  run("missing notifier", GATE, join(TMP, "missing"), {}, "failed");
  run("not in the cockpit", LOST_LINE.id, STUB, {}, "failed");
  run("folder as the notifier", GATE, project("notifier-"), {}, "failed"); // no pid
  await new Promise((done) => setImmediate(done)); // the folder's late 'error' event
  writeFileSync(join(root, "docs", "a.md"), "# A, changed\n");
  run("changed artifact", GATE, STUB, {}, "sent");
  rmSync(join(root, "docs", "a.md"));
  mkdirSync(join(root, "docs", "a.md"));
  run("artifact is a folder", GATE, STUB, {}, "failed");
  eq(lines(root).slice(-1), [{ id: GATE, title: null, command: null, outcome: "failed", reason: "lookup failed: EISDIR" }]);
});

test("notifyDecision: a file at .project-notify gives one 'record not written' line, after any 'not sent' line", () => {
  eq(controlsToSpaces("a\u0000b\u001fc\u007fd\u009fe\u00a0f"), "a b c d e\u00a0f");
  const root = gateProject();
  writeFileSync(join(root, NOTIFY_DIR), "");
  const line = `project-companion: notification record not written: ENOTDIR ${root}/.project-notify\n`;
  eq(captured(() => notifyDecision(root, GATE, stubEnv(STUB, { notify: "off" }))), ["off", "", line]);
  eq(captured(() => notifyDecision(root, GATE, stubEnv(join(TMP, "missing")))), ["failed", "", `${NOT_SENT}ENOENT ${TMP}/missing\n${line}`]);
  const odd = project("line\nbreak\u0085-"); // control characters in the path become spaces, so stderr gets one line
  writeFileSync(join(odd, NOTIFY_DIR), "");
  const [, , err] = captured(() => notifyDecision(odd, GATE, stubEnv(STUB, { notify: "off" })));
  eq(err, `project-companion: notification record not written: ENOTDIR ${odd.replace(/[\n\u0085]/g, " ")}/.project-notify\n`);
});

/* ------------------------- the CLI, as a real process ---------------------- */
// Every CLI run gets its env from stubEnv(...), so a notification can start only the stub (TH-19).

const CLI = join(process.cwd(), "dist", "project-companion.mjs");
const HOME = join(TMP, "home"); // the CLI's project index goes here, not in the real ~/.claude (security F1)
mkdirSync(HOME);

/** Runs the CLI bundle in `root`. CLAUDE_PROJECT_DIR is dropped: findProject would use it, not the cwd (store.ts). */
const cli = (root: string, args: string[], overrides: StubOverrides = {}, notifier: string = STUB) => {
  const { CLAUDE_PROJECT_DIR: _dir, ...env } = stubEnv(notifier, overrides);
  const run = spawnSync(process.execPath, [CLI, ...args], { cwd: root, env: { ...env, HOME }, encoding: "utf8", timeout: 20_000 });
  if (run.error) throw run.error; // a 20 s timeout (a notifier holding the output pipe) fails the test, not status 0
  return { code: run.status, out: run.stdout, err: run.stderr };
};

let made: string[] = []; // the projects of the CLI test that runs now
let drained = 0; // the stub runs that this test already read

/** A project "Demo" with docs/a.md. */
const cliProject = (): string => {
  const root = project();
  initProject(root, "Demo");
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs", "a.md"), "# A\n");
  made.push(root);
  return root;
};

/** Waits for `count` <pid>.done files (guard: 10 s, below the stub's 30 s hold limit), reads each argv, deletes every file. */
const calls = async (count: number): Promise<string[][]> => {
  const done = () => readdirSync(STUB_OUT).filter((f) => f.endsWith(".done")).length;
  for (let polls = 0; done() < count && polls < 500; polls++) await new Promise((next) => setTimeout(next, 20));
  const files = readdirSync(STUB_OUT);
  const argv = files.filter((f) => f.endsWith(".argv")).map((f) => readFileSync(join(STUB_OUT, f), "utf8").split("\0").slice(0, -1));
  for (const f of files) rmSync(join(STUB_OUT, f), { force: true });
  drained += argv.length;
  return argv;
};

/** Waits for at least one <pid>.argv file (same guard as `calls`), without deleting anything or waiting for .done. */
const argvFiles = async (): Promise<string[]> => {
  const have = () => readdirSync(STUB_OUT).filter((f) => f.endsWith(".argv"));
  let files: string[] = [];
  for (let polls = 0; (files = have()).length < 1 && polls < 500; polls++) await new Promise((next) => setTimeout(next, 20));
  return files;
};

/** Each "sent" record line is one stub started, so the test waits for all of them before it ends, pass or fail. */
const cliTest = (name: string, run: () => Promise<void>) =>
  test(name, async () => {
    [made, drained] = [[], 0];
    try { await run(); } finally {
      rmSync(STUB_HOLD, { force: true }); // release a held stub before the drain
      // A record that cannot be read gives [] here, so a test that breaks the record must wait for its own stub with `await calls(n)`.
      const record = (root: string) => { try { return readRecord(root); } catch { return []; } };
      const sent = made.flatMap(record).filter((l) => l.outcome === "sent").length;
      if (sent > drained) await calls(sent - drained);
    }
  });

/** One decision command: exit 0, no stderr, and exactly one stub call. */
const decide = async (root: string, args: string[]): Promise<{ out: string; argv: string[] }> => {
  const run = cli(root, args);
  eq([run.code, run.err], [0, ""], args.join(" "));
  const argv = await calls(1);
  eq(argv.length, 1, `${args.join(" ")}: stub calls`);
  return { out: run.out, argv: argv[0] };
};
const cardId = (out: string): string => (JSON.parse(out) as { id: string }).id;

cliTest("DA-01.1: gate request passes one notification", async () => {
  const root = cliProject();
  const { out, argv } = await decide(root, ["gate", "request", "prd", "alerts", "--artifact", "docs/a.md"]);
  eq(out, "Requested the prd gate for alerts. The PM approves with /devolps:approve prd alerts\n");
  eq(argv, [...PREFIX, GATE_LINE.title, GATE_LINE.command, "Demo"]);
  eq(lines(root), [{ ...GATE_LINE, outcome: "sent" }]);
});

cliTest("DA-01.2: card open passes one notification for a question card and for a track card", async () => {
  const root = cliProject();
  const ids: string[] = [];
  for (const kind of ["question", "track"]) {
    const { out, argv } = await decide(root, ["card", "open", "--subject", "alerts", "--ask", `A ${kind}?`, "--kind", kind, "--json"]);
    ids.push(cardId(out));
    eq([argv.length, argv[7]], [10, `A ${kind}?`], kind);
  }
  eq(lines(root).map((l) => [l.id, l.outcome]), ids.map((id) => [id, "sent"]));
});

cliTest("DA-01.3: each notification holds the cockpit's title, command and project name", async () => {
  const root = cliProject();
  const sent = new Map<string, string[]>();
  for (const [kind, subject] of [["prd", "alerts"], ["design", "alerts"], ["sprint", "2026-w42"], ["merge", "17"], ["release", "1.2.0"]]) {
    const artifact = kind === "merge" ? ["--head", "abc1234"] : ["--artifact", "docs/a.md"];
    sent.set(`gate:${kind}:${subject}`, (await decide(root, ["gate", "request", kind, subject, ...artifact])).argv);
  }
  for (const kind of ["question", "track"]) {
    const { out, argv } = await decide(root, ["card", "open", "--subject", "alerts", "--ask", `Pick "one"?`, "--options", "a|b", "--kind", kind, "--json"]);
    sent.set(cardId(out), argv);
  }
  const model = JSON.parse(cli(root, ["cockpit", "--json"], { notify: "off" }).out) as { project: string; needsYou: { id: string; title: string; command: string }[] };
  eq(model.needsYou.map((d) => d.id).sort(), Array.from(sent.keys()).sort());
  for (const d of model.needsYou) eq(sent.get(d.id)?.slice(7), [d.title, d.command, model.project], d.id);
});

cliTest("DA-01.4: a refused gate request or card open passes no notification", async () => {
  const root = cliProject();
  const refused = [
    ["gate", "request", "design", "alerts", "--artifact", "docs/missing.md"], // the file does not exist (GateError)
    ["gate", "request", "prd", "alerts"], // no artifact
    ["gate", "request", "nope", "alerts", "--artifact", "docs/a.md"], // unknown kind
    ["card", "open", "--subject", "alerts"], // no --ask
  ];
  for (const args of refused) {
    const run = cli(root, args);
    eq([run.code, run.out], [1, ""], args.join(" "));
    ok(!run.err.includes("notification"), `${args.join(" ")}: ${run.err}`);
  }
  eq([readRecord(root), readEvents(root).filter((e) => ["gate.requested", "card.opened"].includes(e.kind))], [[], []]);
  eq(readdirSync(STUB_OUT), [], "the stub ran");
});

cliTest("DA-01.5: approve, refuse, track, answer, status and cockpit pass no notification", async () => {
  const root = cliProject();
  for (const kind of ["prd", "design"]) cli(root, ["gate", "request", kind, "alerts", "--artifact", "docs/a.md"], { notify: "off" });
  const card = cardId(cli(root, ["card", "open", "--subject", "alerts", "--ask", "Ship it?", "--json"], { notify: "off" }).out);
  const before = readRecord(root);
  eq(before.map((l) => l.outcome), ["off", "off", "off"]);
  for (const args of [
    ["gate", "approve", "prd", "alerts", "--via", "prompt:t"],
    ["gate", "refuse", "design", "alerts", "--via", "prompt:t", "--reason", "too long"],
    ["gate", "track", "alerts", "full", "--via", "prompt:t"],
    ["card", "answer", card, "yes", "--via", "prompt:t"],
    ["gate", "status"],
    ["cockpit"],
  ]) eq(cli(root, args).code, 0, args.join(" "));
  eq(readRecord(root), before, "a record line was added");
  eq(readdirSync(STUB_OUT), [], "the stub ran");
});

cliTest("DA-01.6: five requests in a row pass five notifications", async () => {
  const root = cliProject();
  const subjects = ["e1", "e2", "e3", "e4", "e5"];
  for (const s of subjects) eq(cli(root, ["gate", "request", "prd", s, "--artifact", "docs/a.md"]).code, 0, s); // no wait between
  eq(lines(root).map((l) => [l.id, l.outcome]), subjects.map((s) => [`gate:prd:${s}`, "sent"]));
  eq((await calls(5)).map((argv) => argv[7]).sort(), subjects.map((s) => `Approve the requirements for "${s}"`));
});

cliTest("DA-02.5: gate request and card open log the same events with the notifier on and off", async () => {
  // Method: run the same commands in a project with the stub on and in one with the switch off. Then compare each
  // event's kind and data, in log order; card ids are random, so each becomes c-x. Equal lists mean the notify path
  // added no event. The decisions' own events are in both lists, so the check covers every line of both logs.
  const events = (root: string) => readEvents(root).map((e) => JSON.stringify([e.kind, e.data]).replace(/c-[0-9a-f]{6}/g, "c-x"));
  const [on, off] = [cliProject(), cliProject()];
  const start = [on, off].map((root) => readEvents(root).length);
  for (const [root, overrides] of [[on, {}], [off, { notify: "off" }]] as const) {
    for (const kind of ["question", "track"]) eq(cli(root, ["card", "open", "--subject", "alerts", "--ask", "Q?", "--kind", kind], overrides).code, 0);
    eq(cli(root, ["gate", "request", "prd", "alerts", "--artifact", "docs/a.md"], overrides).code, 0);
  }
  eq([on, off].map((root) => readRecord(root).map((l) => l.outcome).join()), ["sent,sent,sent", "off,off,off"]);
  eq((await calls(3)).length, 3, "stub calls");
  eq(events(on), events(off));
  // Each log grew by the 3 decisions' own events, after the identity line that a new shard starts with (events.ts).
  const grew = [on, off].map((root, i) => readEvents(root).slice(start[i]).map((e) => e.kind).join());
  eq(grew, ["on", "off"].map(() => "actor.identified,card.opened,card.opened,gate.requested"), "new events");
});

/* ---------------------- the CLI with a broken notifier --------------------- */

const GATE_ARGS = ["gate", "request", "prd", "alerts", "--artifact", "docs/a.md", "--json"];
const CARD_ARGS = ["card", "open", "--subject", "alerts", "--ask", "Ship it?", "--json"];
/** Strips the two fields that change run to run: the request time, and a card's random id. */
const normalizeOut = (out: string): string => out.replace(/"requestedAt":\d+,/, "").replace(/c-[0-9a-f]{6}/g, "c-x");

cliTest("DA-02.1: same exit code and stdout as off", async () => {
  const missing = join(TMP, "missing");
  for (const args of [GATE_ARGS, CARD_ARGS]) {
    const off = cli(cliProject(), args, { notify: "off" });

    const missingRun = cli(cliProject(), args, {}, missing);
    eq([missingRun.code, normalizeOut(missingRun.out)], [off.code, normalizeOut(off.out)], `${args[0]} missing notifier`);
    eq(missingRun.err, `project-companion: notification not sent: ENOENT ${missing}\n`, `${args[0]} missing notifier stderr`);

    const brokenRoot = cliProject();
    writeFileSync(join(brokenRoot, NOTIFY_DIR), "");
    const brokenRun = cli(brokenRoot, args);
    eq([brokenRun.code, normalizeOut(brokenRun.out)], [off.code, normalizeOut(off.out)], `${args[0]} broken record`);
    eq(brokenRun.err, `project-companion: notification record not written: ENOTDIR ${join(brokenRoot, NOTIFY_DIR)}\n`, `${args[0]} broken record stderr`);
    // dispatch to the stub still succeeds; the broken record stops readRecord, so cliTest cannot drain it
    eq((await calls(1)).length, 1, `${args[0]} broken record: stub calls`);

    const bothRoot = cliProject();
    writeFileSync(join(bothRoot, NOTIFY_DIR), "");
    const bothRun = cli(bothRoot, args, {}, missing);
    eq([bothRun.code, normalizeOut(bothRun.out)], [off.code, normalizeOut(off.out)], `${args[0]} both problems`);
    eq(
      bothRun.err,
      `project-companion: notification not sent: ENOENT ${missing}\nproject-companion: notification record not written: ENOTDIR ${join(bothRoot, NOTIFY_DIR)}\n`,
      `${args[0]} both problems stderr`,
    );

    const folder = project("notifier-"); // TH-8: a folder as the notifier gives "did not start", not a wait
    const folderRun = cli(cliProject(), args, {}, folder);
    eq([folderRun.code, normalizeOut(folderRun.out)], [off.code, normalizeOut(off.out)], `${args[0]} folder notifier`);
    eq(folderRun.err, `project-companion: notification not sent: did not start ${folder}\n`, `${args[0]} folder notifier stderr`);
  }
});

cliTest("DA-02.3: the CLI exits while the notifier waits", async () => {
  const root = cliProject();
  writeFileSync(STUB_HOLD, "");
  try {
    const run = cli(root, ["gate", "request", "prd", "alerts", "--artifact", "docs/a.md"]);
    eq([run.code, run.err], [0, ""]);
    const files = await argvFiles();
    eq(files.length, 1, "stub .argv files");
    const pid = files[0].replace(/\.argv$/, "");
    ok(!existsSync(join(STUB_OUT, `${pid}.done`)), "the stub finished while the hold was in place");
    let pgid = ""; // TH-7 (S1): a detached child leads its own process group, not the CLI's
    for (let polls = 0; !pgid && polls < 500; polls++) {
      if (existsSync(join(STUB_OUT, `${pid}.pgid`))) pgid = readFileSync(join(STUB_OUT, `${pid}.pgid`), "utf8").trim();
      else await new Promise((next) => setTimeout(next, 20));
    }
    eq(pgid, pid, "the stub's process group id should equal its own pid");
  } finally { rmSync(STUB_HOLD, { force: true }); }
  eq((await calls(1)).length, 1, "the stub finished once the hold was released");
});

cliTest("DA-02.4: a hostile card question reaches the stub unchanged", async () => {
  const root = cliProject();
  const question = hostile("ask");
  const { argv } = await decide(root, ["card", "open", "--subject", "alerts", "--ask", question, "--kind", "question"]);
  eq(argv.length, 10);
  eq(argv.slice(0, 7), PREFIX);
  eq(argv[7], question);
  for (let i = 0; i < argv.length; i++) if (argv[i] === "-e") ok(!argv[i + 1].includes(question), `-e value holds the question: ${argv[i + 1]}`);
  // "Runs nothing" is proven once, for every text, by "DA-02.4: osascript passes every argument after -- unchanged" plus the fixed NOTIFY_SCRIPT.
});

cliTest("DA-03.3: linux and win32 give the same output as off", async () => {
  for (const platform of ["linux", "win32"]) {
    for (const args of [GATE_ARGS, CARD_ARGS]) {
      const off = cli(cliProject(), args, { notify: "off" });
      const root = cliProject();
      const on = cli(root, args, { platform });
      eq([on.code, normalizeOut(on.out)], [off.code, normalizeOut(off.out)], `${args[0]} ${platform}`);
      eq(readRecord(root).map((l) => l.outcome), ["unsupported"], `${args[0]} ${platform} record`);
    }
  }
  eq(readdirSync(STUB_OUT), [], "the stub ran");
});

cliTest("TH-5: a folder in place of an approved artifact gives one stderr line and output as with off", async () => {
  const root = cliProject();
  eq(cli(root, ["gate", "request", "design", "alerts", "--artifact", "docs/a.md"], { notify: "off" }).code, 0, "setup: gate request");
  eq(cli(root, ["gate", "approve", "design", "alerts", "--via", "prompt:test"], { notify: "off" }).code, 0, "setup: gate approve");
  rmSync(join(root, "docs", "a.md"));
  mkdirSync(join(root, "docs", "a.md"));
  const off = cli(root, CARD_ARGS, { notify: "off" });
  const on = cli(root, CARD_ARGS);
  eq([on.code, normalizeOut(on.out)], [off.code, normalizeOut(off.out)]);
  eq([off.err, on.err], ["", "project-companion: notification not sent: lookup failed: EISDIR\n"]);
});

cliTest("TH-21: a symlinked record or folder gives one stderr line and output as with off", async () => {
  const off = cli(cliProject(), CARD_ARGS, { notify: "off" });

  const root1 = cliProject();
  const target = join(project("outside-"), "target.txt");
  writeFileSync(target, "keep\n");
  mkdirSync(join(root1, NOTIFY_DIR), { mode: 0o700 });
  symlinkSync(target, recordPath(root1));
  const run1 = cli(root1, CARD_ARGS);
  eq([run1.code, normalizeOut(run1.out)], [off.code, normalizeOut(off.out)], "record symlink");
  eq(run1.err, `project-companion: notification record not written: ELOOP ${recordPath(root1)}\n`, "record symlink stderr");
  eq(readFileSync(target, "utf8"), "keep\n", "the outside file changed");
  // A symlinked record does not stop readRecord: it follows the link and skips the line that is not JSON, so no
  // "sent" line is counted there either; this drains the stub call cliTest would otherwise miss.
  eq((await calls(1)).length, 1, "record symlink: stub calls");

  const root2 = cliProject();
  const outside = project("outside-");
  symlinkSync(outside, join(root2, NOTIFY_DIR));
  const run2 = cli(root2, CARD_ARGS);
  eq([run2.code, normalizeOut(run2.out)], [off.code, normalizeOut(off.out)], "folder symlink");
  eq(run2.err, `project-companion: notification record not written: ENOTDIR ${join(root2, NOTIFY_DIR)}\n`, "folder symlink stderr");
  eq(readdirSync(outside), [], "the outside folder changed");
  eq((await calls(1)).length, 1, "folder symlink: stub calls");
});

test("DA-03.4: README names the commands, the off switch and macOS only", () => {
  const readme = readFileSync(join(process.cwd(), "README.md"), "utf8").split("\n");
  const start = readme.findIndex((l) => l.startsWith("**Decision alerts.**"));
  ok(start >= 0, "README.md has no line that starts with **Decision alerts.**");
  eq(readme.slice(0, start).reverse().find((l) => l.startsWith("## ")), "## Gates, sprints and the PM cockpit", "the section above the paragraph");
  const end = readme.findIndex((l, i) => i > start && (l.startsWith("**") || l.startsWith("## ")));
  const text = readme.slice(start, end < 0 ? undefined : end).join("\n");
  const wanted = ["gate request", "card open", "PROJECT_COMPANION_NOTIFY=off", "macOS only", "exactly `off`"];
  eq(wanted.filter((s) => !text.includes(s)), [], "not in the Decision alerts paragraph");
});

runAll().then((failed) => {
  rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
});
