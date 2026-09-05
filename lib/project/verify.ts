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

/* ------------------------------- what is proven --------------------------- */

export type Verification = { ok: boolean; at: number; command: string };

/**
 * The last thing each declared check said.
 *
 * Folded from the log rather than stored, so it cannot disagree with the run
 * that produced it. Only the latest matters: a check that failed on Tuesday and
 * passes now is passing, and keeping the history here would invite somebody to
 * average it.
 *
 * This is what makes a third status possible. A feature whose boxes are all
 * ticked is `done`; a feature whose boxes are all ticked and whose check has
 * never been run is CLAIMED, and those are different things that every board
 * before this one has drawn identically.
 */
export const verifications = (
  events: readonly { kind: string; ts: number; data: Record<string, unknown> }[],
): Record<string, Verification> => {
  const latest: Record<string, Verification> = {};

  for (const event of events) {
    if (event.kind !== "criterion.verified") continue;
    const featureId = event.data.featureId;
    if (typeof featureId !== "string") continue;

    const previous = latest[featureId];
    if (previous && previous.at > event.ts) continue;
    latest[featureId] = {
      ok: event.data.ok === true,
      at: event.ts,
      command: String(event.data.command ?? ""),
    };
  }

  return latest;
};

export type ProofState = "proven" | "failing" | "claimed" | "unclaimed";

/**
 * How much a feature's "done" is worth.
 *
 * `claimed` is the interesting one and the reason this exists: every box
 * ticked, a command declared, and nobody has ever run it. That is the state
 * most boards are permanently in and none of them can express.
 */
export const proofState = (
  feature: { status: string; verify?: string },
  verification: Verification | undefined,
): ProofState => {
  if (feature.status !== "done") return "unclaimed";
  if (!feature.verify) return "claimed";
  if (!verification) return "claimed";
  return verification.ok ? "proven" : "failing";
};
