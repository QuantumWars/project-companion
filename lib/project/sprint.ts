/**
 * Sprints: a goal, a week, and the stories committed to it (devolps TR-05).
 *
 * Like gates and runs, a sprint is nothing but events -- `sprint.created`,
 * `sprint.committed`, `sprint.scope_added`, `sprint.closed` -- and its state is
 * a fold. Work added after the commitment is kept apart as added scope, so the
 * burn-up shows the plan honestly: a line that rises because work was added is
 * a different story from a line that rises because work was finished.
 *
 * ---- what the numbers mean ----
 *
 * Burn-up counts story points when every task in the sprint has them, and
 * tasks otherwise. It measures delivery -- how much of the committed scope is
 * done -- and says nothing about who did it. Productivity is measured per lane
 * in `metrics.ts`, and never across lanes.
 */

import type { ProjectEvent } from "./events";
import type { Task } from "./types";

export type SprintStatus = "planned" | "active" | "closed";

export type Sprint = {
  id: string;
  name: string;
  goal?: string;
  /** ISO dates, `YYYY-MM-DD`. */
  start: string;
  end: string;
  capacity?: number;
  committed: string[];
  committedAt?: number;
  added: { task: string; at: number }[];
  closedAt?: number;
  status: SprintStatus;
};

const day = (ts: number): string => new Date(ts).toISOString().slice(0, 10);

export const foldSprints = (events: readonly ProjectEvent[], today = day(Date.now())): Map<string, Sprint> => {
  const sprints = new Map<string, Sprint>();
  for (const e of events) {
    const d = e.data ?? {};
    const id = typeof d.sprintId === "string" ? d.sprintId : undefined;
    if (!id) continue;
    if (e.kind === "sprint.created") {
      if (sprints.has(id)) continue;
      sprints.set(id, {
        id,
        name: String(d.name ?? id),
        goal: typeof d.goal === "string" ? d.goal : undefined,
        start: String(d.start ?? today),
        end: String(d.end ?? today),
        capacity: typeof d.capacity === "number" ? d.capacity : undefined,
        committed: [],
        added: [],
        status: "planned",
      });
      continue;
    }
    const s = sprints.get(id);
    if (!s) continue;
    if (e.kind === "sprint.committed") {
      s.committed = Array.isArray(d.tasks) ? d.tasks.map(String) : [];
      s.committedAt = e.ts;
    } else if (e.kind === "sprint.scope_added" && typeof d.taskId === "string") {
      if (!s.committed.includes(d.taskId) && !s.added.some((a) => a.task === d.taskId)) s.added.push({ task: d.taskId, at: e.ts });
    } else if (e.kind === "sprint.closed") {
      s.closedAt = e.ts;
    }
  }
  for (const s of Array.from(sprints.values())) {
    s.status = s.closedAt ? "closed" : s.committedAt && s.start <= today ? "active" : "planned";
  }
  return sprints;
};

export const sprintTasks = (s: Sprint): string[] => [...s.committed, ...s.added.map((a) => a.task)];

/** The sprint a task is in, if any; the most recent one wins. */
export const sprintOf = (sprints: Map<string, Sprint>, taskId: string): Sprint | undefined =>
  Array.from(sprints.values())
    .filter((s) => sprintTasks(s).includes(taskId))
    .sort((a, b) => b.start.localeCompare(a.start))[0];

/** When each task last became done, and was not moved back out since. */
export const doneTimes = (events: readonly ProjectEvent[]): Map<string, number> => {
  const out = new Map<string, number>();
  for (const e of events) {
    if (e.kind !== "task.moved") continue;
    const id = String(e.data.taskId ?? "");
    if (e.data.to === "done") out.set(id, e.ts);
    else if (e.data.from === "done") out.delete(id);
  }
  return out;
};

export type BurnupPoint = { date: string; scope: number; done: number };

export type Burnup = {
  unit: "points" | "tasks";
  points: BurnupPoint[];
  committed: number;
  added: number;
  done: number;
};

/**
 * Scope and done, day by day, from the sprint's start to its end or today.
 *
 * `scope` starts at the committed amount and rises only when work is added;
 * `done` counts work finished by the end of each day.
 */
export const burnup = (s: Sprint, tasks: readonly Task[], events: readonly ProjectEvent[], now = Date.now()): Burnup => {
  const ids = sprintTasks(s);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const unit: Burnup["unit"] = ids.length > 0 && ids.every((id) => typeof byId.get(id)?.points === "number") ? "points" : "tasks";
  const size = (id: string) => (unit === "points" ? byId.get(id)?.points ?? 0 : 1);
  const done = doneTimes(events);

  const last = s.closedAt ? day(s.closedAt) : day(Math.min(now, Date.parse(`${s.end}T23:59:59Z`)));
  const points: BurnupPoint[] = [];
  for (let d = s.start; d <= last; d = day(Date.parse(`${d}T00:00:00Z`) + 86_400_000)) {
    const endOfDay = Date.parse(`${d}T23:59:59.999Z`);
    const scope =
      s.committed.reduce((n, id) => n + size(id), 0) +
      s.added.filter((a) => a.at <= endOfDay).reduce((n, a) => n + size(a.task), 0);
    const finished = ids.filter((id) => (done.get(id) ?? Infinity) <= endOfDay).reduce((n, id) => n + size(id), 0);
    points.push({ date: d, scope, done: finished });
    if (points.length > 62) break; // A sprint longer than two months is a data error, not a chart.
  }
  return {
    unit,
    points,
    committed: s.committed.reduce((n, id) => n + size(id), 0),
    added: s.added.reduce((n, a) => n + size(a.task), 0),
    done: ids.filter((id) => done.has(id)).reduce((n, id) => n + size(id), 0),
  };
};

export type Forecast = {
  /** Remaining work, in the burn-up's unit. */
  remaining: number;
  /** Delivered per sprint over the last finished sprints: slowest and fastest. */
  rate: { slowest: number; fastest: number };
  /** Sprints needed at the fastest and the slowest rate. */
  sprints: { best: number; worst: number };
  /** Finish dates, assuming one-week sprints back to back from today. */
  finish: { earliest: string; latest: string };
};

/**
 * A finish range from the last three finished sprints (devolps PC-03.2).
 *
 * Returns null with fewer than three, so the cockpit can say "not enough
 * history" instead of drawing a guess as a forecast (PC-03.3).
 */
export const forecast = (
  remaining: number,
  finished: readonly Burnup[],
  now = Date.now(),
  sprintDays = 7,
): Forecast | null => {
  const recent = finished.slice(-3);
  if (recent.length < 3) return null;
  const rates = recent.map((b) => b.done);
  const slowest = Math.min(...rates);
  const fastest = Math.max(...rates);
  if (fastest <= 0) return null;
  const best = Math.ceil(remaining / fastest);
  const worst = slowest > 0 ? Math.ceil(remaining / slowest) : Infinity;
  const at = (n: number) => (Number.isFinite(n) ? day(now + n * sprintDays * 86_400_000) : "not in sight");
  return { remaining, rate: { slowest, fastest }, sprints: { best, worst }, finish: { earliest: at(best), latest: at(worst) } };
};
