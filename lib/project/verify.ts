/**
 * Running the checks a PRD declares.
 *
 * A ticked box is a claim. Once agents are doing the ticking that claim is
 * worth exactly as much as the thing behind it, so a feature can name a command
 * and `verify` runs it: `Verify: npm test -- auth` beside `Paths:`, answering
 * the same shape of question -- where the feature lives, and how you know it is
 * done.
 *
 * The consequence is the point. A criterion whose check fails cannot stay
 * ticked; it is unticked, and the event log records that it was the check that
 * did it rather than a person changing their mind. Status derivation therefore
 * gains a third answer -- claimed, but not proven -- which is the state most
 * boards are actually in and none of them can say.
 *
 * Opt-in per project, because this runs shell commands out of a file in the
 * repository. A PRD is reviewed like code, so a command in one has been through
 * review -- but the tool should not start executing them because a document
 * happened to contain a line.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Longer than a unit suite, shorter than anybody's patience. */
const TIMEOUT_MS = 120_000;

export type CheckResult = {
  featureId: string;
  command: string;
  ok: boolean;
  code: number;
  ms: number;
  /** Tail of the output, for a message worth reading. */
  output: string;
};

/**
 * Runs one declared command.
 *
 * Through a shell on purpose, and only on purpose: `npm test -- auth` is what
 * people write, and refusing to run it because it contains a space would make
 * the feature useless. The exposure is a command already committed to a
 * reviewed document, which is the same trust boundary as a `package.json`
 * script or a git hook.
 */
export const runCheck = async (
  root: string,
  featureId: string,
  command: string,
): Promise<CheckResult> => {
  const started = Date.now();
  try {
    const { stdout, stderr } = await run(command, {
      cwd: root,
      shell: true,
      timeout: TIMEOUT_MS,
      maxBuffer: 8 << 20,
      // Nothing here should depend on the caller's terminal being interactive.
      env: { ...process.env, CI: "1" },
    } as never);
    return {
      featureId,
      command,
      ok: true,
      code: 0,
      ms: Date.now() - started,
      output: tail(`${stdout}${stderr}`),
    };
  } catch (error) {
    const failure = error as { code?: number; killed?: boolean; stdout?: string; stderr?: string };
    return {
      featureId,
      command,
      ok: false,
      // A timeout has no exit code; call it 124, as `timeout(1)` does.
      code: failure.killed ? 124 : (failure.code ?? 1),
      ms: Date.now() - started,
      output: tail(`${failure.stdout ?? ""}${failure.stderr ?? ""}`) || (failure.killed ? "Timed out." : "Failed."),
    };
  }
};

/** The last few lines, which is where a failing runner says why. */
const tail = (text: string, lines = 12): string =>
  text.trim().split("\n").slice(-lines).join("\n");
