/**
 * The notifier (design 3.3, ADR-0001). Decision text reaches /usr/bin/osascript only as arguments after `--`, never
 * inside script source, so no part of it runs as code (DA-02.4, TH-1). `dispatch` refuses a program path that is not
 * absolute, so `PATH` is never searched (TH-3). This module never writes the event log (TH-16).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { isAbsolute } from "node:path";

import { readCockpit } from "@/lib/project/cockpit";
import { appendRecord, codeOf, RecordError, type NotifyOutcome, type RecordLine } from "@/lib/project/notify-record";

export const NOTIFY_ENV = "PROJECT_COMPANION_NOTIFY";
export const NOTIFIER_ENV = "PROJECT_COMPANION_NOTIFIER";
export const PLATFORM_ENV = "PROJECT_COMPANION_PLATFORM";
export const NOTIFIER = "/usr/bin/osascript";

/** The fixed script. It holds no user text, and it calls only `display notification`. */
export const NOTIFY_SCRIPT: readonly string[] = [
  "on run argv",
  "display notification (item 2 of argv) with title (item 1 of argv) subtitle (item 3 of argv)",
  "end run",
];

export type NotifyText = { title: string; command: string; project: string };

/**
 * `PROJECT_COMPANION_NOTIFIER` when it is set and not empty, else NOTIFIER. Pure: it starts nothing.
 * `Partial`, because Next.js makes `NODE_ENV` required, and the TH-3 test passes `{}`.
 */
export const notifierPath = (env: Partial<NodeJS.ProcessEnv>): string => env[NOTIFIER_ENV] || NOTIFIER;

/**
 * Each script line after `-e`, then `--`, then the text. Without `--`, a text that starts with `-e` becomes script.
 * The DA-02.4 osascript test uses this builder with its own echo script, so it checks the layout that ships.
 */
export const osascriptArgs = (script: readonly string[], text: readonly string[]): string[] => [
  ...script.flatMap((line) => ["-e", line]),
  "--",
  ...text,
];

/** Exactly 10 items: 3 fixed `-e` lines, `--`, then the title, the command and the project name. */
export const notifierArgs = ({ title, command, project }: NotifyText): string[] =>
  osascriptArgs(NOTIFY_SCRIPT, [title, command, project]);

/**
 * The dispatch step that failed, and the error code: "path" (not absolute), "access", "spawn" or "pid" (no pid).
 * The code is null for "path" and "pid". It never holds `error.message` or the text (TH-5).
 */
export class DispatchError extends Error {
  constructor(readonly step: "path" | "access" | "spawn" | "pid", readonly code: string | null) {
    super(code ? `${step} ${code}` : step);
    this.name = "DispatchError";
  }
}

// Contract: returns the pid (outcome "sent"); throws a DispatchError at the first failed step (outcome "failed").
export const dispatch = (program: string, args: readonly string[]): number => {
  if (!isAbsolute(program)) throw new DispatchError("path", null); // a bare name would make spawn search PATH (TH-3)
  try {
    accessSync(program, constants.X_OK);
  } catch (error) {
    throw new DispatchError("access", codeOf(error));
  }
  let child: ChildProcess;
  try {
    child = spawn(program, args, { detached: true, stdio: "ignore", shell: false, windowsHide: true });
  } catch (error) {
    throw new DispatchError("spawn", codeOf(error)); // for example ERR_INVALID_ARG_VALUE for a NUL character
  }
  child.once("error", () => {}); // without a listener, a late 'error' event would crash the CLI
  if (child.pid === undefined) throw new DispatchError("pid", null);
  child.unref(); // the CLI exits without waiting for the notifier (DA-02.3)
  return child.pid;
};

/** Each character from U+0000 to U+001F and from U+007F to U+009F becomes one space, so a reason stays on one line. */
export const controlsToSpaces = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");

/** The decision id is not in the cockpit's "needs you" list. */
export class NotInCockpitError extends Error {
  constructor() {
    super("not in the cockpit");
    this.name = "NotInCockpitError";
  }
}

/** The text comes from the cockpit model itself, so the alert and the cockpit say the same thing (DA-01.3). */
export const decisionText = (root: string, id: string): NotifyText => {
  const model = readCockpit(root);
  const decision = model.needsYou.find((d) => d.id === id);
  if (!decision) throw new NotInCockpitError();
  return { title: decision.title, command: decision.command, project: model.project };
};

/** Design 3.3, reason table. It uses the step, the code and the paths this code passed, never `error.message`. */
export const failureReason = (error: unknown, program: string): string => {
  if (!(error instanceof DispatchError)) return codeOf(error);
  const reasons = {
    path: `not an absolute path: ${program}`,
    access: `${error.code} ${program}`,
    spawn: `${error.code}`,
    pid: `did not start ${program}`,
  };
  return reasons[error.step];
};

/** One record line. When it is not written, one standard error line from the code and the target, never the message. */
const record = (root: string, line: RecordLine): void => {
  try {
    appendRecord(root, line);
  } catch (error) {
    const reason = error instanceof RecordError ? `${error.code} ${error.target}` : codeOf(error);
    process.stderr.write(`project-companion: notification record not written: ${controlsToSpaces(reason)}\n`);
  }
};

/**
 * Design 3.3, "Entry point" and "Outcome precedence" (the first match wins). It never throws and never writes to
 * standard output, and the decision text never reaches a reason. Each failure writes one "notification not sent" line
 * to standard error (DA-02.2), then records `failed` with the same reason (design flow 2).
 */
export const notifyDecision = (root: string, decisionId: string, env: NodeJS.ProcessEnv = process.env): NotifyOutcome => {
  let text: NotifyText | null = null;
  let outcome: NotifyOutcome = "failed";
  let reason = "";
  try {
    try {
      text = decisionText(root, decisionId); // first, so the off and unsupported lines carry the text (DA-04.1)
    } catch (error) {
      reason = error instanceof NotInCockpitError ? `not in the cockpit: ${decisionId}` : `lookup failed: ${codeOf(error)}`;
    }
    if (env[NOTIFY_ENV] === "off") outcome = "off"; // row 1 (DA-03.1)
    else if ((env[PLATFORM_ENV] || process.platform) !== "darwin") outcome = "unsupported"; // row 2 (DA-03.3)
    else if (text) {
      dispatch(notifierPath(env), notifierArgs(text)); // rows 4 to 6: it throws, or the notifier started
      outcome = "sent";
    } // else row 3: the lookup failed, so the outcome stays "failed" with the lookup's reason
  } catch (error) {
    outcome = "failed";
    reason = failureReason(error, notifierPath(env));
  }
  const base = { id: decisionId, at: new Date().toISOString(), title: text?.title ?? null, command: text?.command ?? null };
  if (outcome === "failed") {
    const clean = controlsToSpaces(reason); // once, so the standard error line and the record hold the same reason
    process.stderr.write(`project-companion: notification not sent: ${clean}\n`); // DA-02.2, before the record (flow 2)
    record(root, { ...base, outcome, reason: clean });
  } else record(root, { ...base, outcome });
  return outcome;
};
