/**
 * Metrics by lane (devolps TR-07, MT-01..03, ADR 0007).
 *
 * People and agents obey different physics: a person's scarce resource is
 * attention, an agent's is tokens and review. So nothing here averages across
 * the two lanes. A task is in the agent lane when an agent run worked on it,
 * and in the human lane otherwise.
 *
 *   agent lane  cycle time, attempts per accepted change, wait on the PM
 *   human lane  velocity: points finished per closed sprint
 *   gates       how long each gate waits for the PM, and how often it is overridden
 */

import type { ProjectEvent } from "./events";
import type { AgentRun } from "./run";
import { burnup, doneTimes, type Sprint } from "./sprint";
import type { Task } from "./types";

export type Lane = "agent" | "human";

export const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export const laneOf = (taskId: string, runs: readonly AgentRun[]): Lane =>
  runs.some((r) => r.taskId === taskId && r.actor.kind === "agent") ? "agent" : "human";

export type GateMetric = { kind: string; decided: number; medianWaitMs: number | null; overrides: number; overrideShare: number | null };

/** Request-to-decision time and override share, for each gate kind (MT-03). */
export const gateMetrics = (events: readonly ProjectEvent[]): GateMetric[] => {
  const requestedAt = new Map<string, number>();
  const waits = new Map<string, number[]>();
  const overrides = new Map<string, number>();
  for (const e of events) {
    if (!e.kind.startsWith("gate.")) continue;
    const kind = String(e.data.kind ?? "");
    const key = `${kind}:${String(e.data.subject ?? "")}`;
    if (e.kind === "gate.requested") {
      requestedAt.set(key, e.ts);
      continue;
    }
    const from = requestedAt.get(key);
    if (from === undefined) continue;
    requestedAt.delete(key); // One decision per request.
    waits.set(kind, [...(waits.get(kind) ?? []), e.ts - from]);
    if (e.kind === "gate.approved" && typeof e.data.override === "string" && e.data.override) {
      overrides.set(kind, (overrides.get(kind) ?? 0) + 1);
    }
  }
  return Array.from(waits.entries()).map(([kind, w]) => {
    const o = overrides.get(kind) ?? 0;
    return { kind, decided: w.length, medianWaitMs: median(w), overrides: o, overrideShare: w.length ? o / w.length : null };
  });
};

export type AgentLaneMetrics = {
  lane: "agent";
  tasksDone: number;
  /** First agent run on a task to the task being done. */
  medianCycleTimeMs: number | null;
  /** Agent runs per task that reached done. 1.0 means every change landed first time. */
  attemptsPerAcceptedChange: number | null;
  /** How long work waited for the PM at gates. */
  medianWaitOnPmMs: number | null;
};

export const agentLane = (events: readonly ProjectEvent[], tasks: readonly Task[], runs: readonly AgentRun[]): AgentLaneMetrics => {
  const done = doneTimes(events);
  const agentTasks = tasks.filter((t) => laneOf(t.id, runs) === "agent" && done.has(t.id));
  const cycles: number[] = [];
  let attempts = 0;
  for (const t of agentTasks) {
    const taskRuns = runs.filter((r) => r.taskId === t.id && r.actor.kind === "agent");
    attempts += taskRuns.length;
    const first = Math.min(...taskRuns.map((r) => (r.startedAt ? Date.parse(r.startedAt) : Infinity)));
    if (Number.isFinite(first)) cycles.push(done.get(t.id)! - first);
  }
  const waits = gateMetrics(events).flatMap((g) => (g.medianWaitMs === null ? [] : [g.medianWaitMs]));
  return {
    lane: "agent",
    tasksDone: agentTasks.length,
    medianCycleTimeMs: median(cycles),
    attemptsPerAcceptedChange: agentTasks.length ? attempts / agentTasks.length : null,
    medianWaitOnPmMs: median(waits),
  };
};

export type HumanLaneMetrics = {
  lane: "human";
  /** Points (or tasks) of human-lane work finished in each closed sprint. */
  velocity: { sprint: string; delivered: number; unit: "points" | "tasks" }[];
};

/** Velocity from human-lane work only (MT-01.1). */
export const humanLane = (
  sprints: readonly Sprint[],
  events: readonly ProjectEvent[],
  tasks: readonly Task[],
  runs: readonly AgentRun[],
): HumanLaneMetrics => ({
  lane: "human",
  velocity: sprints
    .filter((s) => s.status === "closed")
    .map((s) => {
      const human = tasks.filter((t) => laneOf(t.id, runs) === "human");
      const b = burnup({ ...s, committed: s.committed.filter((id) => human.some((t) => t.id === id)), added: s.added.filter((a) => human.some((t) => t.id === a.task)) }, tasks, events);
      return { sprint: s.id, delivered: b.done, unit: b.unit };
    }),
});
