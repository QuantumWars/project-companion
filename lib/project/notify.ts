/**
 * The notifier (design 3.3, ADR-0001). Decision text reaches /usr/bin/osascript only as arguments after `--`, never
 * inside script source, so no part of it runs as code (DA-02.4, TH-1). The program is an absolute path, so `PATH` is
 * never searched (TH-3). This module never writes the event log (TH-16).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";

import { codeOf } from "@/lib/project/notify-record";

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

/** The dispatch step that failed, and the error code. It never holds `error.message` or the text (TH-5). */
export class DispatchError extends Error {
  constructor(readonly step: "access" | "spawn" | "pid", readonly code: string | null) {
    super(code ? `${step} ${code}` : step);
    this.name = "DispatchError";
  }
}

// Contract: returns the pid (outcome "sent"); throws a DispatchError when the notifier did not start (outcome "failed").
export const dispatch = (program: string, args: readonly string[]): number => {
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
