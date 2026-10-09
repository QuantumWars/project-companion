import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

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

runAll().then((failed) => {
  rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
});
