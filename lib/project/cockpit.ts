/**
 * The PM cockpit model (devolps PC-01..PC-11).
 *
 * One pure function turns everything in the store into the answers a
 * non-technical PM asks for: what needs me, is each epic OK, where is it, what
 * is stuck, what shipped, what is the story this week, what are the agents
 * doing. The web page and `project-companion cockpit --json` both render this
 * model, so the terminal and the browser can never disagree.
 *
 * The cockpit is read-only (devolps decision Q4). Every card names the exact
 * command the PM types in Claude Code to decide it.
 *
 * Wording follows devolps STE-lite output rules: the bottom line first, plain
 * words, and technical detail kept in `details`, which the page hides behind a
 * link (PC-11).
 */

import { foldCards, foldUpdates, workingDaysBetween, type Card, type Health, type WeeklyUpdate } from "./decisions";
import { readEvents, type ProjectEvent } from "./events";
import { readGates, type GateBook } from "./gate";
import type { AgentRun } from "./run";
import { burnup, doneTimes, forecast, foldSprints, sprintOf, sprintTasks, type Burnup, type Forecast, type Sprint } from "./sprint";
import { readRoadmap } from "./roadmap";
import { readProject, readRuns, readTasks } from "./store";
import type { Feature, Phase, Task } from "./types";

/** Days a decision may wait before the epic is At risk (PC-02.2). Decision record Q-series; a placeholder. */
export const DECISION_WAIT_LIMIT = 2;

export type CockpitInput = {
  name: string;
  phases: Phase[];
  features: Feature[];
  tasks: Task[];
  runs: AgentRun[];
  gates: GateBook;
  events: ProjectEvent[];
  now: number;
};

export type DecisionItem = {
  id: string;
  kind: "gate" | "question" | "track";
  /** One plain sentence: what the PM is asked to decide. */
  title: string;
  why: string;
  options: string[];
  recommendation?: string;
  costOfWaiting: string;
  deadline?: string;
  /** The exact command to type in Claude Code. */
  command: string;
  waitingDays: number;
  overdue: boolean;
  subject: string;
  details: Record<string, string>;
};

export type EpicView = {
  id: string;
  name: string;
  goal?: string;
  stage: string;
  health: { value: Health; reason: string };
  target?: string;
  features: { done: number; total: number };
  forecast: Forecast | null;
};

export type CockpitModel = {
  generatedAt: string;
  project: string;
  needsYou: DecisionItem[];
  epics: EpicView[];
  sprint: (Pick<Sprint, "id" | "name" | "goal" | "start" | "end" | "status"> & { burnup: Burnup; goalAtRisk: boolean; goalRisk?: string }) | null;
  blocked: { taskId: string; title: string; reason: string; cause: string; unblocker: string; daysBlocked: number; sprint?: string }[];
  shipped: { taskId: string; title: string; doneAt: string; pr?: { number: number; url?: string } }[];
  update: { latest: WeeklyUpdate | null; late: boolean; lateReason?: string };
  agents: { role: string; doing: string; minutes: number; state: string }[];
};

const GATE_TEXT: Record<string, (subject: string) => { title: string; why: string; command: string }> = {
  prd: (s) => ({
    title: `Approve the requirements for "${s}"`,
    why: "Design work starts only after you agree what the epic must do.",
    command: `/devolps:approve prd ${s}`,
  }),
  design: (s) => ({
    title: `Approve the technical design for "${s}"`,
    why: "Building starts only after you accept the plan and its security risks.",
    command: `/devolps:approve design ${s}`,
  }),
  sprint: (s) => ({
    title: `Approve sprint "${s}"`,
    why: "Agents build only the work you commit to for this week.",
    command: `/devolps:approve sprint ${s}`,
  }),
  merge: (s) => ({
    title: `Merge pull request #${s}`,
    why: "Finished work reaches the main code only when you merge it.",
    command: `/devolps:ship pr ${s}`,
  }),
  release: (s) => ({
    title: `Release version ${s}`,
    why: "Users get the new version only when you release it.",
    command: `/devolps:ship release ${s}`,
  }),
};

const minutes = (ms: number) => Math.max(0, Math.round(ms / 60000));
const isoDay = (ts: number) => new Date(ts).toISOString().slice(0, 10);

/** The epic a task belongs to. */
export const epicOf = (task: Task, features: readonly Feature[]): string | undefined =>
  task.phaseId ?? features.find((f) => f.id === task.featureId)?.phaseId;

/** Where an epic is in the lifecycle, derived from its gates (PC-03.1). */
export const stageOf = (epic: Phase, gates: GateBook, featuresDone: boolean): string => {
  if (epic.status === "done") return "Released";
  const state = (kind: string) => gates.gates.get(`${kind}:${epic.id}`)?.state;
  const open = (kind: string) => state(kind) === "approved" || state(kind) === "overridden";
  const track = gates.tracks.get(epic.id)?.track;
  if (track === "quick") {
    if (open("prd")) return featuresDone ? "Ready to release" : "Build";
    return state("prd") === "requested" ? "Quick spec — waiting for you" : "Quick spec";
  }
  if (open("design")) return featuresDone ? "Ready to release" : "Build";
  if (state("design") === "requested") return "Design — waiting for you";
  if (open("prd")) return "Design";
  if (state("prd") === "requested") return "Requirements — waiting for you";
  if (track) return "Requirements";
  return "Idea";
};

const RANK: Record<Health, number> = { "on-track": 0, "at-risk": 1, "off-track": 2 };

export const buildCockpit = (input: CockpitInput): CockpitModel => {
  const { now, gates, events, tasks, features, runs } = input;
  const cards = foldCards(events);
  const updates = foldUpdates(events);
  const sprints = foldSprints(events, isoDay(now));
  const done = doneTimes(events);
  const titleOf = (id: string) => tasks.find((t) => t.id === id)?.title ?? id;

  /* ---- needs you now (PC-01) ---- */
  const needsYou: DecisionItem[] = [];
  for (const g of Array.from(gates.gates.values())) {
    if (g.state !== "requested" && g.state !== "stale") continue;
    const text = (GATE_TEXT[g.kind] ?? GATE_TEXT.prd)(g.subject);
    const since = g.requestedAt ?? now;
    const waiting = workingDaysBetween(since, now);
    needsYou.push({
      id: `gate:${g.kind}:${g.subject}`,
      kind: "gate",
      title: g.state === "stale" ? `${text.title} again — it changed after you approved it` : text.title,
      why: text.why,
      options: ["approve", "send back"],
      costOfWaiting: "Work on this stops until you decide.",
      command: text.command,
      waitingDays: waiting,
      overdue: waiting > DECISION_WAIT_LIMIT,
      subject: g.subject,
      details: {
        gate: g.kind,
        files: g.requested.map((a) => a.ref).join(", "),
        ...(g.changed.length ? { changed: g.changed.join(", ") } : {}),
        "send back": `/devolps:reject ${g.kind} ${g.subject} "<reason>"`,
      },
    });
  }
  for (const c of Array.from(cards.values())) {
    if (c.answer !== undefined) continue;
    // A track card is answered by confirming the track.
    if (c.kind === "track" && (gates.tracks.get(c.subject)?.at ?? 0) > c.openedAt) continue;
    const waiting = workingDaysBetween(c.openedAt, now);
    const first = c.recommendation ?? c.options[0] ?? "<answer>";
    needsYou.push({
      id: c.id,
      kind: c.kind,
      title: c.ask,
      why: c.why ?? (c.kind === "track" ? "The track decides how much process this work needs." : "Agents need this answer to continue."),
      options: c.options,
      recommendation: c.recommendation,
      costOfWaiting: c.costOfWaiting ?? "Work on this waits for your answer.",
      deadline: c.deadline,
      command: c.kind === "track" ? `/devolps:approve track ${c.subject} ${first}` : `/devolps:answer ${c.id} "${first}"`,
      waitingDays: waiting,
      overdue: waiting > DECISION_WAIT_LIMIT || (c.deadline ? isoDay(now) > c.deadline : false),
      subject: c.subject,
      details: { card: c.id },
    });
  }
  needsYou.sort((a, b) => Number(b.overdue) - Number(a.overdue) || b.waitingDays - a.waitingDays);

  /* ---- sprint and burn-up (PC-03) ---- */
  const all = Array.from(sprints.values()).sort((a, b) => a.start.localeCompare(b.start));
  const closed = all.filter((s) => s.status === "closed");
  const active = all.filter((s) => s.status === "active").pop() ?? null;
  const finishedBurnups = closed.map((s) => burnup(s, tasks, events, now));

  /* ---- blocked (PC-04) ---- */
  const blocked = tasks
    .filter((t) => t.blocked && t.status !== "done")
    .map((t) => {
      const s = sprintOf(sprints, t.id);
      return {
        taskId: t.id,
        title: t.title,
        reason: t.blocked!.reason,
        cause: t.blocked!.cause === "decision" ? "waiting for your decision" : t.blocked!.cause === "outside" ? "waiting on someone outside the team" : "an agent failed",
        unblocker: t.blocked!.unblocker,
        daysBlocked: workingDaysBetween(Date.parse(t.blocked!.since), now),
        sprint: s?.id,
      };
    });

  let sprintView: CockpitModel["sprint"] = null;
  if (active) {
    const b = burnup(active, tasks, events, now);
    const endsIn = workingDaysBetween(now, Date.parse(`${active.end}T23:59:59`));
    const blockedHere = blocked.filter((x) => x.sprint === active.id);
    const goalAtRisk = blockedHere.length > 0 && endsIn <= DECISION_WAIT_LIMIT;
    sprintView = {
      id: active.id,
      name: active.name,
      goal: active.goal,
      start: active.start,
      end: active.end,
      status: active.status,
      burnup: b,
      goalAtRisk,
      goalRisk: goalAtRisk
        ? `${blockedHere.length === 1 ? "1 task is" : `${blockedHere.length} tasks are`} blocked, and the sprint ends ${endsIn === 0 ? "today" : `in ${endsIn} working day${endsIn === 1 ? "" : "s"}`}.`
        : undefined,
    };
  }

  /* ---- epics: stage, health, forecast (PC-02, PC-03) ---- */
  const epics: EpicView[] = input.phases.map((p) => {
    const fs = features.filter((f) => f.phaseId === p.id);
    const featuresDone = fs.length > 0 && fs.every((f) => f.status === "done");
    const epicTasks = tasks.filter((t) => epicOf(t, features) === p.id);
    const remaining = epicTasks.filter((t) => !done.has(t.id)).reduce((n, t) => n + (typeof t.points === "number" ? t.points : 1), 0);
    const fc = epicTasks.length ? forecast(remaining, finishedBurnups, now) : null;

    // Health: the worst of the published update and the floor rules.
    let value: Health = "on-track";
    let reason = p.endsAt ? "No decision is overdue, and nothing threatens the target date." : "No decision is overdue. No target date is set.";
    const raise = (to: Health, why: string) => {
      if (RANK[to] > RANK[value]) {
        value = to;
        reason = why;
      }
    };
    const published = Array.from(updates.values())
      .filter((u) => u.publishedAt && (u.epic === p.id || u.epic === undefined))
      .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))[0];
    if (published) raise(published.health, published.reason);
    const waitingHere = needsYou.filter((n) => n.subject === p.id && n.overdue);
    if (waitingHere.length) raise("at-risk", `A decision has waited ${waitingHere[0].waitingDays} working days: ${waitingHere[0].title}.`);
    if (fc && p.endsAt && fc.finish.latest !== "not in sight" && fc.finish.latest > p.endsAt) {
      raise("at-risk", `The forecast finish (up to ${fc.finish.latest}) is later than the target date (${p.endsAt}).`);
    }
    if (published && published.health === value && RANK[value] > 0) reason = published.reason;

    return {
      id: p.id,
      name: p.name,
      goal: p.goal,
      stage: stageOf(p, gates, featuresDone),
      health: { value, reason },
      target: p.endsAt,
      features: { done: fs.filter((f) => f.status === "done").length, total: fs.length },
      forecast: fc,
    };
  });

  /* ---- shipped this week (PC-05) ---- */
  const weekAgo = now - 7 * 86_400_000;
  const shipped = tasks
    .filter((t) => (done.get(t.id) ?? 0) >= weekAgo)
    .map((t) => ({ taskId: t.id, title: t.title, doneAt: isoDay(done.get(t.id)!), pr: t.pr ? { number: t.pr.number, url: t.pr.url } : undefined }))
    .sort((a, b) => b.doneAt.localeCompare(a.doneAt));

  /* ---- weekly update (PC-06) ---- */
  const latest = Array.from(updates.values()).sort((a, b) => (b.publishedAt ?? b.draftedAt) - (a.publishedAt ?? a.draftedAt))[0] ?? null;
  const lastPublished = Array.from(updates.values()).filter((u) => u.publishedAt).sort((a, b) => b.publishedAt! - a.publishedAt!)[0];
  // The end of the most recent Friday that has already ended (local time).
  const lastFridayEnd = (() => {
    const d = new Date(now);
    d.setDate(d.getDate() - ((d.getDay() + 2) % 7));
    d.setHours(23, 59, 59, 999);
    if (d.getTime() > now) d.setDate(d.getDate() - 7);
    return d.getTime();
  })();
  // Late (PC-06.2): a Friday ended, a sprint was running that week, and no update
  // was published in the week up to it. Publishing afterwards clears it.
  const fridayDate = isoDay(lastFridayEnd);
  const sprintThatWeek = all.some((s) => s.start <= fridayDate && s.end >= isoDay(lastFridayEnd - 6 * 86_400_000));
  const late = sprintThatWeek && (!lastPublished || lastPublished.publishedAt! <= lastFridayEnd - 7 * 86_400_000);
  const update = {
    latest,
    late,
    lateReason: late ? "No weekly update was published by the end of Friday." : undefined,
  };

  /* ---- agents (PC-08) ---- */
  const agents = runs
    .filter((r) => r.state === "running" || r.state === "blocked" || r.state === "awaiting_review")
    .map((r) => ({
      role: r.role ?? (r.parentRunId ? "agent" : "Engineering Manager"),
      doing: r.taskId ? titleOf(r.taskId) : "planning and coordination",
      minutes: r.startedAt ? minutes(now - Date.parse(r.startedAt)) : 0,
      state: r.state === "running" ? "working" : r.state === "blocked" ? "stopped: over its budget or blocked" : "finished, waiting for review",
    }));

  return {
    generatedAt: new Date(now).toISOString(),
    project: input.name,
    needsYou,
    epics,
    sprint: sprintView,
    blocked,
    shipped,
    update,
    agents,
  };
};

export { sprintTasks };
export type { Card };

/* --------------------------------- loader --------------------------------- */

/** Reads everything the cockpit needs from a project and builds the model. */
export const readCockpit = (root: string, now = Date.now()): CockpitModel => {
  const roadmap = readRoadmap(root);
  return buildCockpit({
    name: readProject(root).name,
    phases: roadmap.phases,
    features: roadmap.features,
    tasks: readTasks(root).tasks,
    runs: readRuns(root),
    gates: readGates(root, roadmap.source),
    events: readEvents(root),
    now,
  });
};
