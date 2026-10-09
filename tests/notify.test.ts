import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { eq, ok, runAll, test, throws } from "./harness";

/**
 * Decision alerts. No test here may show a notification to the PM (TH-19), so:
 * the runner sets PROJECT_COMPANION_NOTIFY=off, the suite never changes
 * process.env, and `stubEnv` is the only way to turn notifications on. It
 * always points the notifier at an absolute path, in practice `STUB` below.
 */

const TMP = realpathSync(mkdtempSync(join(tmpdir(), "pc-notify-")));
const STUB_OUT = join(TMP, "out");
const STUB_HOLD = join(TMP, "hold");
mkdirSync(STUB_OUT);

/** Saves its arguments (each ends in NUL), waits while STUB_HOLD exists, then writes <pid>.done. */
const STUB = join(TMP, "notifier-stub");
writeFileSync(STUB, [
  "#!/bin/sh",
  '[ -n "${STUB_OUT:-}" ] || exit 0',
  "printf '%s\\0' \"$@\" > \"$STUB_OUT/$$.tmp\"",
  'mv "$STUB_OUT/$$.tmp" "$STUB_OUT/$$.argv"',
  'if [ -n "${STUB_HOLD:-}" ]; then',
  '  while [ -e "$STUB_HOLD" ]; do sleep 0.05 2>/dev/null || sleep 1; done',
  "fi",
  ': > "$STUB_OUT/$$.done"',
  "",
].join("\n"));
chmodSync(STUB, 0o755);

const stubEnv = (notifier: string): NodeJS.ProcessEnv => {
  if (!notifier || !isAbsolute(notifier)) {
    throw new Error(`stubEnv: the notifier must be an absolute path, got ${JSON.stringify(notifier)}`);
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
