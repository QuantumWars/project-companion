/**
 * Agent runs: who did the work, under what constraints, and what came of it.
 *
 * A commit tells you a change happened. It does not tell you that a model made
 * it, which model, under whose supervision, against what budget, or whether a
 * human ever looked. As soon as some of the work on a repository is done by
 * agents, that is the difference between a history you can audit and one you
 * can only read -- and every measurement built on top inherits the gap.
 *
 * ---- why runs live in the log ----
 *
 * A run is updated constantly: a tool call, a token count, a file touched.
 * Putting it in `.project` would mean taking the project-wide write lock
 * hundreds of times per session, so a single agent working would stall every
 * other writer and the canvas autosave alongside it.
 *
 * So a run is not stored; it is DERIVED. The log records what happened -- it
 * started, it spent, it blocked, it finished -- and the current state is a fold
 * over those events. That is what an append-only log is for, and it makes the
 * run's whole history free rather than something that needs its own table.
 *
 * ---- what this can and cannot enforce ----
 *
 * It cannot stop an agent. Nothing here runs inside the model's process, and a
 * budget is not a sandbox. What it does is refuse: an over-budget run is marked
 * `blocked` and every tool that checks first will decline to proceed, so the
 * agent is told rather than trusted. That is the honest boundary, and stating
 * it is better than implying a containment this design does not have.
 */

import { matchesAny } from "./git-link";
import type { ProjectEvent } from "./events";
import type { AgentPolicy, AutonomyLevel } from "./bundle";

/**
 * A run's lifecycle.
 *
 * `blocked` is deliberately not terminal. A run that exhausts its budget or
 * tries to write outside its boundary has hit a decision point, not an end --
 * a human raises the budget, or narrows the task, or abandons it. Making it
 * terminal would turn every ceiling into a lost session.
 */
export const RUN_STATES = [
  "proposed",
  "approved",
  "running",
  "blocked",
  "awaiting_review",
  "merged",
  "abandoned",
] as const;

export type RunState = (typeof RUN_STATES)[number];

const TRANSITIONS: Record<RunState, readonly RunState[]> = {
  proposed: ["approved", "abandoned"],
  approved: ["running", "abandoned"],
  running: ["blocked", "awaiting_review", "abandoned"],
  // Back to running once whatever blocked it is resolved.
  blocked: ["running", "abandoned"],
  awaiting_review: ["merged", "running", "abandoned"],
  merged: [],
  abandoned: [],
};

export const canTransition = (from: RunState, to: RunState): boolean =>
  TRANSITIONS[from].includes(to);

export type RunActor = {
  kind: "human" | "agent";
  /** `claude-opus-5`, `gpt-5-codex`. Absent for a human. */
  model?: string;
  /** `claude-code`, `codex`, `cursor`, `ci`. */
  harness?: string;
  version?: string;
};

export type RunSpend = {
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  wallClockMs: number;
};

export type AgentRun = {
  id: string;
  state: RunState;
  actor: RunActor;
  autonomy: AutonomyLevel;
  componentId?: string;
  taskId?: string;
  /** The harness session that owns it, so a hook can find it again. */
  sessionId?: string;
  branch?: string;
  worktree?: string;
  /** Globs this run may write. Inherited from its component unless overridden. */
  writeGlobs?: string[];
  budget: NonNullable<AgentPolicy["budget"]>;
  spent: RunSpend;
  /** Why it stopped, when it stopped for a reason worth keeping. */
  reason?: string;
  /** Files it actually touched, for the review packet and the attestation. */
  touched: string[];
  startedAt?: string;
  endedAt?: string;
  updatedAt: string;
};

const ZERO: RunSpend = { inputTokens: 0, outputTokens: 0, toolCalls: 0, wallClockMs: 0 };

/* -------------------------------- budgets --------------------------------- */

export type BudgetVerdict = {
  ok: boolean;
  /** Which ceiling was hit, for a message a person can act on. */
  exceeded?: "tokens" | "toolCalls" | "wallClock";
  detail?: string;
};

/**
 * Whether a run may keep going.
 *
 * Tokens are counted together rather than separately: input and output are the
 * same resource from the budget's point of view, and splitting the ceiling
 * would make the number somebody has to reason about twice as hard for nothing.
 *
 * An unset ceiling is not zero. A budget with no `tokens` means nobody has
 * expressed an opinion about tokens, and reading that as "spend nothing" would
 * block every run in a project that never configured one.
 */
export const checkBudget = (run: AgentRun): BudgetVerdict => {
  const { budget, spent } = run;
  const tokens = spent.inputTokens + spent.outputTokens;

  if (budget.tokens !== undefined && tokens >= budget.tokens) {
    return {
      ok: false,
      exceeded: "tokens",
      detail: `${tokens} of ${budget.tokens} tokens.`,
    };
  }
  if (budget.toolCalls !== undefined && spent.toolCalls >= budget.toolCalls) {
    return {
      ok: false,
      exceeded: "toolCalls",
      detail: `${spent.toolCalls} of ${budget.toolCalls} tool calls.`,
    };
  }
  if (budget.wallClockMs !== undefined && spent.wallClockMs >= budget.wallClockMs) {
    return {
      ok: false,
      exceeded: "wallClock",
      detail: `${Math.round(spent.wallClockMs / 1000)}s of ${Math.round(
        budget.wallClockMs / 1000,
      )}s.`,
    };
  }
  return { ok: true };
};

/**
 * Whether a path is inside what this run may write.
 *
 * A run with no boundary may write anywhere, which is the right default for a
 * run against no component -- there is nothing to scope it to, and refusing
 * everything would make an unscoped run useless rather than safe.
 *
 * A write outside the boundary is more interesting than a violation. It usually
 * means the task genuinely spans two components, and the architecture says they
 * are separate. That is a fact about the design, and it is worth surfacing as
 * one rather than only as a refusal.
 */
export const mayWrite = (run: AgentRun, path: string): boolean =>
  !run.writeGlobs?.length || matchesAny(path, run.writeGlobs);

/* ------------------------------- projection ------------------------------- */

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/**
 * The current state of every run, folded out of the log.
 *
 * Unknown event kinds are ignored rather than treated as corruption: a newer
 * build will write kinds this one has never heard of, and a teammate pulling an
 * older checkout must still see their runs.
 *
 * An illegal transition is dropped, not applied. The log is append-only, so a
 * bad event cannot be taken back -- but it also cannot be allowed to move a
 * merged run back into `running`, which would make every count downstream wrong.
 */
export const runsFrom = (events: readonly ProjectEvent[]): AgentRun[] => {
  const runs = new Map<string, AgentRun>();

  for (const event of events) {
    const data = event.data;
    const id = typeof data.runId === "string" ? data.runId : undefined;
    if (!id) continue;
    const at = new Date(event.ts).toISOString();

    if (event.kind === "run.started") {
      if (runs.has(id)) continue; // A duplicate start is a replay, not a reset.
      runs.set(id, {
        id,
        state: "running",
        actor: { kind: "agent", ...asRecord(data.actor) } as RunActor,
        autonomy: (data.autonomy as AutonomyLevel) ?? "confirm",
        componentId: event.componentId,
        taskId: typeof data.taskId === "string" ? data.taskId : undefined,
        sessionId: typeof data.sessionId === "string" ? data.sessionId : undefined,
        branch: typeof data.branch === "string" ? data.branch : undefined,
        worktree: typeof data.worktree === "string" ? data.worktree : undefined,
        writeGlobs: Array.isArray(data.writeGlobs) ? (data.writeGlobs as string[]) : undefined,
        budget: asRecord(data.budget) as AgentRun["budget"],
        spent: { ...ZERO },
        touched: [],
        startedAt: at,
        updatedAt: at,
      });
      continue;
    }

    const run = runs.get(id);
    if (!run) continue;

    if (event.kind === "run.progress") {
      run.spent = {
        inputTokens: run.spent.inputTokens + num(data.inputTokens),
        outputTokens: run.spent.outputTokens + num(data.outputTokens),
        toolCalls: run.spent.toolCalls + num(data.toolCalls ?? 0),
        // Elapsed since the run started, not a sum of reported durations:
        // durations overlap when tools run in parallel, and adding them makes a
        // ten-minute session look like an hour.
        wallClockMs: run.startedAt ? event.ts - Date.parse(run.startedAt) : run.spent.wallClockMs,
      };
      for (const path of Array.isArray(data.touched) ? (data.touched as string[]) : []) {
        if (!run.touched.includes(path)) run.touched.push(path);
      }
      run.updatedAt = at;
      continue;
    }

    if (event.kind === "run.state") {
      const to = data.state as RunState;
      if (!RUN_STATES.includes(to) || !canTransition(run.state, to)) continue;
      run.state = to;
      run.reason = typeof data.reason === "string" ? data.reason : run.reason;
      if (to === "merged" || to === "abandoned") run.endedAt = at;
      run.updatedAt = at;
    }
  }

  return Array.from(runs.values()).sort((a, b) =>
    (b.startedAt ?? "").localeCompare(a.startedAt ?? ""),
  );
};

export const activeRuns = (runs: readonly AgentRun[]): AgentRun[] =>
  runs.filter((r) => r.state === "running" || r.state === "blocked");

/* ------------------------------- attestation ------------------------------ */

/**
 * The provenance trailers for a commit produced by a run.
 *
 * Which trailer depends on how much of the change the model produced, following
 * the convention that has settled around this: `Assisted-by` for help,
 * `Co-authored-by` for a substantial share, `Generated-by` for mostly-model
 * work.
 *
 * `Signed-off-by` is always a person. A model cannot hold accountability, so a
 * commit that claims it does is making a false statement -- the human who
 * approved the run is the one answerable for it, and that is who signs.
 */
export const attestation = (
  run: AgentRun,
  approver: { name: string; email: string },
  share: "assisted" | "co-authored" | "generated" = "co-authored",
): string[] => {
  const model = run.actor.model ?? "unknown-model";
  const harness = run.actor.harness ? ` (${run.actor.harness})` : "";
  const line =
    share === "assisted"
      ? `Assisted-by: ${model}${harness}`
      : share === "generated"
        ? `Generated-by: ${model}${harness}`
        : `Co-authored-by: ${model}${harness} <noreply@example.invalid>`;

  return [
    line,
    `Signed-off-by: ${approver.name} <${approver.email}>`,
    `project-companion-run: ${run.id}`,
  ];
};
