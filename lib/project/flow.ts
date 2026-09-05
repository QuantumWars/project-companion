/**
 * Where work is piling up, and what to look at first.
 *
 * Every number here is a fold over the event log. Nothing is reported, nothing
 * is entered, and nothing can be gamed by moving a card -- moving the card is
 * the measurement. That is the whole reason the log came before this: a board
 * that asks people for status can only ever be as accurate as they are bored.
 *
 * ---- what it measures, and why those ----
 *
 * DORA's 2025 finding is that AI raises throughput while degrading stability,
 * and the mechanism is not mysterious: generation got cheap and review did not,
 * so work accumulates in front of the reviewer. The metrics that show that are
 * about queues, not about speed. Age of the thing that has been waiting longest
 * says more than a mean cycle time, which averages the pile away.
 *
 * ---- and what it deliberately does not ----
 *
 * No velocity, no points, no burndown. The product's whole argument is that
 * self-reported numbers are worthless; inventing a new one to put on a chart
 * would contradict it in the same file that proves the point.
 */

import type { ProjectEvent } from "./events";
import type { Task, TaskStatus } from "./types";

const DAY = 86_400_000;

export type StageTime = { status: TaskStatus; ms: number };

export type TaskFlow = {
  taskId: string;
  createdAt: number;
  /** Time spent in each status, in the order it passed through them. */
  stages: StageTime[];
  /** Created to done, when it is done. */
  cycleMs?: number;
  /** How long it has sat where it is now. */
  ageMs: number;
  status: TaskStatus;
  /**
   * Moved backwards out of review at least once.
   *
   * The closest thing to a rework signal the board can honestly produce: work
   * that reached review and was sent back is work that was not finished when
   * somebody said it was.
   */
  reworked: boolean;
};

/**
 * Reconstructs each task's journey from the log.
 *
 * `now` is a parameter rather than `Date.now()` so a test can assert an age
 * without racing the clock, and so a report can be regenerated for a past
 * moment and give the same answer it gave then.
 */
export const taskFlow = (
  events: readonly ProjectEvent[],
  tasks: readonly Task[],
  now = Date.now(),
): TaskFlow[] => {
  type Working = TaskFlow & { since: number };
  const flows = new Map<string, Working>();

  for (const event of events) {
    const id = typeof event.data.taskId === "string" ? event.data.taskId : undefined;
    if (!id) continue;

    if (event.kind === "task.created") {
      flows.set(id, {
        taskId: id,
        createdAt: event.ts,
        stages: [],
        ageMs: 0,
        status: (event.data.status as TaskStatus) ?? "backlog",
        reworked: false,
        since: event.ts,
      });
      continue;
    }

    const flow = flows.get(id);
    if (!flow) continue;

    if (event.kind === "task.moved") {
      const from = event.data.from as TaskStatus | undefined;
      const to = event.data.to as TaskStatus;

      if (from) flow.stages.push({ status: from, ms: event.ts - flow.since });
      // Leaving review for anything other than done is a return trip.
      if (from === "review" && to !== "done") flow.reworked = true;

      flow.status = to;
      flow.since = event.ts;
      if (to === "done") flow.cycleMs = event.ts - flow.createdAt;
      continue;
    }

    if (event.kind === "task.deleted") flows.delete(id);
  }

  const known = new Set(tasks.map((t) => t.id));
  return Array.from(flows.values())
    // A task the log knows about but the board does not was deleted outside the
    // tool, or belongs to a branch this checkout does not have. Either way it is
    // not work in flight, and counting it would inflate every queue.
    .filter((f) => known.has(f.taskId))
    .map(({ since, ...flow }) => ({ ...flow, ageMs: now - since }));
};

export type Queue = {
  status: TaskStatus;
  count: number;
  /** The longest anything has waited here. The mean hides exactly this. */
  oldestMs: number;
  medianAgeMs: number;
};

export const queues = (flows: readonly TaskFlow[]): Queue[] => {
  const byStatus = new Map<TaskStatus, number[]>();
  for (const flow of flows) {
    if (flow.status === "done") continue;
    const ages = byStatus.get(flow.status) ?? [];
    ages.push(flow.ageMs);
    byStatus.set(flow.status, ages);
  }

  return Array.from(byStatus.entries())
    .map(([status, ages]) => {
      const sorted = [...ages].sort((a, b) => a - b);
      return {
        status,
        count: ages.length,
        oldestMs: sorted[sorted.length - 1] ?? 0,
        medianAgeMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
      };
    })
    .sort((a, b) => b.oldestMs - a.oldestMs);
};

export type Summary = {
  /** Median of finished work. The median, because one abandoned card ruins a mean. */
  cycleMs?: number;
  finished: number;
  reworked: number;
  inFlight: number;
  queues: Queue[];
};

export const summarise = (flows: readonly TaskFlow[]): Summary => {
  const done = flows.filter((f) => f.cycleMs !== undefined);
  const cycles = done.map((f) => f.cycleMs!).sort((a, b) => a - b);

  return {
    cycleMs: cycles.length ? cycles[Math.floor(cycles.length / 2)] : undefined,
    finished: done.length,
    reworked: flows.filter((f) => f.reworked).length,
    inFlight: flows.filter((f) => f.status !== "done").length,
    queues: queues(flows),
  };
};

/* ------------------------------ WIP limits -------------------------------- */

export type WipVerdict = { ok: boolean; status?: TaskStatus; count?: number; limit?: number };

/**
 * Whether starting more work is a good idea.
 *
 * A limit is a refusal, not a warning. Theory of constraints is uncomfortably
 * literal about this: when the queue in front of the bottleneck is full, the
 * useful action is to stop starting and go help finish. A dashboard that only
 * reports the pile is a dashboard everybody learns to scroll past.
 *
 * Only stages a person owns are limited. Capping `todo` limits how much you
 * plan; capping `review` limits how much you can hand somebody -- and review is
 * where AI-assisted work actually accumulates.
 */
export const checkWip = (
  flows: readonly TaskFlow[],
  limits: Partial<Record<TaskStatus, number>>,
): WipVerdict => {
  for (const [status, limit] of Object.entries(limits) as [TaskStatus, number][]) {
    if (!limit) continue;
    const count = flows.filter((f) => f.status === status).length;
    if (count >= limit) return { ok: false, status, count, limit };
  }
  return { ok: true };
};

/* --------------------------- the attention router -------------------------- */

export type Attention = {
  taskId: string;
  status: TaskStatus;
  ageMs: number;
  score: number;
  why: string[];
};

/**
 * What to look at first.
 *
 * Age, weighted by how much rests on it. A task waiting in review is holding
 * somebody else up; a task against a component many others import has a blast
 * radius; a task that has already been sent back once is a task that is not
 * converging. All three are things you would want to know before choosing, and
 * none of them are visible on a board sorted by when the card was made.
 *
 * The reasons come back with the score. A ranking nobody can argue with is a
 * ranking nobody trusts -- if the top item is wrong, the `why` is what lets
 * somebody say so instead of quietly ignoring the list.
 */
export const attention = (
  flows: readonly TaskFlow[],
  options: { fanIn?: Record<string, number>; componentOf?: Record<string, string> } = {},
): Attention[] =>
  flows
    .filter((f) => f.status !== "done" && f.status !== "backlog")
    .map((flow) => {
      const why: string[] = [];
      const days = flow.ageMs / DAY;
      let score = days;
      why.push(`${days < 1 ? "under a day" : `${Math.round(days)} days`} in ${flow.status.replace("_", " ")}`);

      if (flow.status === "review") {
        score *= 2;
        why.push("waiting on a person");
      }
      if (flow.reworked) {
        score *= 1.5;
        why.push("been sent back before");
      }

      const componentId = options.componentOf?.[flow.taskId];
      const fanIn = componentId ? (options.fanIn?.[componentId] ?? 0) : 0;
      if (fanIn > 0) {
        // Log, not linear: a component with forty dependents is not forty times
        // more urgent than one with one, and treating it that way would put the
        // same few components at the top of the list for ever.
        score *= 1 + Math.log10(1 + fanIn);
        why.push(`${fanIn} component${fanIn === 1 ? "" : "s"} depend on ${componentId}`);
      }

      return { taskId: flow.taskId, status: flow.status, ageMs: flow.ageMs, score, why };
    })
    .sort((a, b) => b.score - a.score);
