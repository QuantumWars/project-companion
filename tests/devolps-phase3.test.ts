import { execFile, execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { buildCockpit, stageOf, type CockpitInput } from "@/lib/project/cockpit";
import { foldCards, foldUpdates, weekId, workingDaysBetween } from "@/lib/project/decisions";
import type { ProjectEvent } from "@/lib/project/events";
import { foldGates } from "@/lib/project/gate";
import { agentLane, gateMetrics, humanLane, laneOf, median } from "@/lib/project/metrics";
import type { AgentRun } from "@/lib/project/run";
import { burnup, foldSprints, forecast } from "@/lib/project/sprint";
import type { Phase, Task } from "@/lib/project/types";
import { eq, ok, runAll, test } from "./harness";

/**
 * devolps Phase 3: sprints, decision cards, weekly updates, lane metrics, the
 * PM cockpit, subagent runs and pull-request links. Every rule is tested on
 * the side it must refuse as well as the side it must allow.
 */

const DAY = 86_400_000;
const T0 = Date.parse("2026-10-05T09:00:00.000Z"); // a Monday
let seq = 0;
const ev = (kind: string, data: Record<string, unknown>, ts: number): ProjectEvent => ({
  id: `a:${++seq}`, ts, seq, actor: "a", prev: null, kind: kind as ProjectEvent["kind"], data,
});
const task = (id: string, over: Partial<Task> = {}): Task => ({
  id, title: `Task ${id}`, status: "todo", createdAt: "", updatedAt: "", order: 0, ...over,
});
const run = (over: Partial<AgentRun>): AgentRun => ({
  id: `r${++seq}`, state: "running", actor: { kind: "agent" }, autonomy: "confirm", budget: {},
  spent: { inputTokens: 0, outputTokens: 0, toolCalls: 0, wallClockMs: 0 }, touched: [], updatedAt: "", ...over,
});
const moved = (taskId: string, to: string, ts: number, from = "in_progress") => ev("task.moved", { taskId, from, to }, ts);

/* --------------------------------- sprints --------------------------------- */

const sprintEvents = (): ProjectEvent[] => [
  ev("sprint.created", { sprintId: "s1", start: "2026-10-05", end: "2026-10-09", goal: "Receipts" }, T0),
  ev("sprint.committed", { sprintId: "s1", tasks: ["a", "b"] }, T0 + 1000),
  moved("a", "done", T0 + 1 * DAY),
  ev("sprint.scope_added", { sprintId: "s1", taskId: "c" }, T0 + 2 * DAY),
];

test("burn-up: committed scope, added scope apart, and done by day", () => {
  const s = foldSprints(sprintEvents(), "2026-10-07").get("s1")!;
  eq(s.status, "active");
  const b = burnup(s, [task("a", { points: 3 }), task("b", { points: 5 }), task("c", { points: 2 })], sprintEvents(), T0 + 2 * DAY + 1000);
  eq(b.unit, "points");
  eq([b.committed, b.added, b.done], [8, 2, 3]);
  eq(b.points.map((p) => [p.date, p.scope, p.done]), [["2026-10-05", 8, 0], ["2026-10-06", 8, 3], ["2026-10-07", 10, 3]]);
});

test("burn-up counts tasks when any task lacks points", () => {
  const s = foldSprints(sprintEvents(), "2026-10-07").get("s1")!;
  eq(burnup(s, [task("a", { points: 3 }), task("b"), task("c")], sprintEvents(), T0 + 3 * DAY).unit, "tasks");
});

test("a task moved back out of done no longer counts as done", () => {
  const events = [...sprintEvents(), moved("a", "in_progress", T0 + 2 * DAY + 5, "done")];
  const s = foldSprints(events, "2026-10-09").get("s1")!;
  eq(burnup(s, [task("a"), task("b"), task("c")], events, T0 + 3 * DAY).done, 0);
});

test("forecast: none with fewer than three finished sprints (PC-03.3)", () => {
  const b = { unit: "tasks" as const, points: [], committed: 5, added: 0, done: 5 };
  eq(forecast(10, [b, b], T0), null);
});

test("forecast: a range from the slowest and fastest of the last three (PC-03.2)", () => {
  const done = (n: number) => ({ unit: "points" as const, points: [], committed: n, added: 0, done: n });
  const f = forecast(20, [done(1), done(4), done(5), done(10)], T0)!;
  eq([f.rate.slowest, f.rate.fastest, f.sprints.best, f.sprints.worst], [4, 10, 2, 5]);
});

/* ------------------------------ cards, updates ------------------------------ */

test("a card's first answer stands; a later one is ignored", () => {
  const cards = foldCards([
    ev("card.opened", { cardId: "c1", subject: "checkout", ask: "Which email provider?", options: ["a", "b"] }, T0),
    ev("card.answered", { cardId: "c1", answer: "a", via: "prompt:1" }, T0 + 1),
    ev("card.answered", { cardId: "c1", answer: "b", via: "prompt:2" }, T0 + 2),
  ]);
  eq([cards.get("c1")!.answer, cards.get("c1")!.via], ["a", "prompt:1"]);
});

test("a re-draft replaces a draft, but not a published update", () => {
  const u = foldUpdates([
    ev("update.drafted", { updateId: "w41", health: "on-track", reason: "first" }, T0),
    ev("update.drafted", { updateId: "w41", health: "at-risk", reason: "second" }, T0 + 1),
    ev("update.published", { updateId: "w41", via: "prompt:p" }, T0 + 2),
    ev("update.drafted", { updateId: "w41", health: "off-track", reason: "third" }, T0 + 3),
  ]).get("w41")!;
  eq([u.health, u.reason, Boolean(u.publishedAt)], ["at-risk", "second", true]);
});

test("working days skip the weekend", () => {
  const fri = Date.parse("2026-10-09T10:00:00");
  eq(workingDaysBetween(fri, fri + 3 * DAY), 1, "Friday to Monday is one working day");
  eq(workingDaysBetween(fri, fri), 0);
});

test("week ids follow ISO weeks", () => {
  eq(weekId(Date.parse("2026-10-07T12:00:00Z")), "2026-w41");
});

/* ---------------------------------- metrics --------------------------------- */

test("lanes: a task an agent worked on is agent lane; the rest are human", () => {
  const runs = [run({ taskId: "a" }), run({ taskId: "b", actor: { kind: "human" } })];
  eq([laneOf("a", runs), laneOf("b", runs), laneOf("c", runs)], ["agent", "human", "human"]);
});

test("agent lane: attempts per accepted change counts every run on a done task", () => {
  const runs = [
    run({ taskId: "a", startedAt: new Date(T0).toISOString() }),
    run({ taskId: "a", startedAt: new Date(T0 + DAY).toISOString() }),
    run({ taskId: "b", startedAt: new Date(T0).toISOString() }),
  ];
  const m = agentLane([moved("a", "done", T0 + 2 * DAY), moved("b", "done", T0 + DAY)], [task("a"), task("b")], runs);
  eq([m.tasksDone, m.attemptsPerAcceptedChange], [2, 1.5]);
  eq(m.medianCycleTimeMs, 1.5 * DAY);
});

test("human lane velocity excludes agent work (MT-01.1)", () => {
  const events = [
    ev("sprint.created", { sprintId: "s1", start: "2026-10-05", end: "2026-10-09" }, T0),
    ev("sprint.committed", { sprintId: "s1", tasks: ["h", "g"] }, T0 + 1),
    moved("h", "done", T0 + DAY),
    moved("g", "done", T0 + DAY),
    ev("sprint.closed", { sprintId: "s1" }, T0 + 4 * DAY),
  ];
  const m = humanLane(Array.from(foldSprints(events).values()), events, [task("h"), task("g")], [run({ taskId: "g" })]);
  eq(m.velocity, [{ sprint: "s1", delivered: 1, unit: "tasks" }]);
});

test("gate metrics: median wait and override share per kind (MT-03.1)", () => {
  const m = gateMetrics([
    ev("gate.requested", { kind: "prd", subject: "x" }, T0),
    ev("gate.approved", { kind: "prd", subject: "x", via: "p" }, T0 + 2 * DAY),
    ev("gate.requested", { kind: "prd", subject: "y" }, T0),
    ev("gate.approved", { kind: "prd", subject: "y", via: "p", override: "deadline" }, T0 + 4 * DAY),
  ]);
  eq(m, [{ kind: "prd", decided: 2, medianWaitMs: 3 * DAY, overrides: 1, overrideShare: 0.5 }]);
  eq(median([]), null);
});

/* ---------------------------------- cockpit --------------------------------- */

const phase = (id: string, over: Partial<Phase> = {}): Phase => ({ id, name: id, status: "active", order: 0, ...over });
const cockpit = (events: ProjectEvent[], over: Partial<CockpitInput> = {}) =>
  buildCockpit({
    name: "Demo", phases: [phase("checkout")], features: [], tasks: [], runs: [],
    gates: foldGates(events), events, now: T0 + 4 * DAY, ...over,
  });

test("needs you: a requested gate becomes a card with the exact command", () => {
  const m = cockpit([ev("gate.requested", { kind: "prd", subject: "checkout", artifacts: [] }, T0)]);
  eq(m.needsYou.map((n) => n.command), ["/devolps:approve prd checkout"]);
  eq(m.needsYou[0].overdue, true, "requested Monday, it is Friday: more than 2 working days");
});

test("needs you: an approved gate is not shown; an open question is, with /devolps:answer", () => {
  const m = cockpit([
    ev("gate.requested", { kind: "prd", subject: "checkout", artifacts: [] }, T0),
    ev("gate.approved", { kind: "prd", subject: "checkout", via: "p", artifacts: [] }, T0 + 1),
    ev("card.opened", { cardId: "c1", subject: "checkout", ask: "Which provider?", options: ["mailgun", "ses"], recommendation: "ses" }, T0 + 2),
  ]);
  eq(m.needsYou.map((n) => n.command), ['/devolps:answer c1 "ses"']);
});

test("needs you: a track card closes when the track is confirmed", () => {
  const m = cockpit([
    ev("card.opened", { cardId: "c2", kind: "track", subject: "checkout", ask: "Which track?", options: ["full", "quick", "bugfix"] }, T0),
    ev("track.confirmed", { subject: "checkout", track: "full", via: "p" }, T0 + 5),
  ]);
  eq(m.needsYou.length, 0);
});

test("health: an overdue decision makes the epic At risk, with the reason (PC-02.2)", () => {
  const m = cockpit([ev("gate.requested", { kind: "design", subject: "checkout", artifacts: [] }, T0)]);
  eq(m.epics[0].health.value, "at-risk");
  ok(m.epics[0].health.reason.includes("waited"), m.epics[0].health.reason);
});

test("health: On track when nothing is overdue", () => {
  const m = cockpit([ev("gate.requested", { kind: "design", subject: "checkout", artifacts: [] }, T0 + 4 * DAY - 1000)]);
  eq(m.epics[0].health.value, "on-track");
});

test("health: a published Off-track update wins over the floor rules", () => {
  const m = cockpit([
    ev("update.drafted", { updateId: "w41", health: "off-track", reason: "The provider contract fell through." }, T0),
    ev("update.published", { updateId: "w41", via: "p" }, T0 + 1),
  ]);
  eq([m.epics[0].health.value, m.epics[0].health.reason], ["off-track", "The provider contract fell through."]);
});

test("stage follows the gates", () => {
  const p = phase("checkout");
  const stage = (events: ProjectEvent[]) => stageOf(p, foldGates(events), false);
  eq(stage([]), "Idea");
  eq(stage([ev("track.confirmed", { subject: "checkout", track: "full", via: "p" }, T0)]), "Requirements");
  eq(stage([ev("gate.requested", { kind: "prd", subject: "checkout", artifacts: [] }, T0)]), "Requirements — waiting for you");
  eq(stage([
    ev("gate.requested", { kind: "prd", subject: "checkout", artifacts: [] }, T0),
    ev("gate.approved", { kind: "prd", subject: "checkout", via: "p", artifacts: [] }, T0 + 1),
    ev("gate.requested", { kind: "design", subject: "checkout", artifacts: [] }, T0 + 2),
    ev("gate.approved", { kind: "design", subject: "checkout", via: "p", artifacts: [] }, T0 + 3),
  ]), "Build");
});

test("blocked: a blocked task in the active sprint near its end puts the goal at risk (PC-04.2)", () => {
  const events = [
    ev("sprint.created", { sprintId: "s1", start: "2026-10-05", end: "2026-10-09" }, T0),
    ev("sprint.committed", { sprintId: "s1", tasks: ["a"] }, T0 + 1),
  ];
  const m = cockpit(events, {
    tasks: [task("a", { blocked: { reason: "Waiting for the email provider choice", cause: "decision", unblocker: "PM", since: new Date(T0 + DAY).toISOString() } })],
  });
  eq(m.blocked[0].cause, "waiting for your decision");
  eq(m.sprint?.goalAtRisk, true);
});

test("shipped: tasks done in the last 7 days, newest first", () => {
  const m = cockpit([moved("a", "done", T0 - 10 * DAY), moved("b", "done", T0 + DAY)], { tasks: [task("a"), task("b")] });
  eq(m.shipped.map((s) => s.taskId), ["b"]);
});

test("agents: running subagent runs show their role and task in plain words", () => {
  const m = cockpit([], {
    tasks: [task("a", { title: "Receipt email" })],
    runs: [run({ taskId: "a", role: "frontend-engineer", parentRunId: "p", startedAt: new Date(T0 + 4 * DAY - 600_000).toISOString() })],
  });
  eq(m.agents, [{ role: "frontend-engineer", doing: "Receipt email", minutes: 10, state: "working" }]);
});

test("weekly update: late only after a Friday that ended during a sprint (PC-06.2)", () => {
  const sprint = (start: string, end: string) => [
    ev("sprint.created", { sprintId: "s", start, end }, T0),
    ev("sprint.committed", { sprintId: "s", tasks: [] }, T0 + 1),
  ];
  const thursday = Date.parse("2026-10-08T12:00:00");
  eq(cockpit(sprint("2026-10-05", "2026-10-09"), { now: thursday }).update.late, false, "the sprint began after the last Friday");
  eq(cockpit(sprint("2026-09-28", "2026-10-09"), { now: thursday }).update.late, true, "a sprint ran through last Friday, and nothing was published");
  const published = [
    ...sprint("2026-09-28", "2026-10-09"),
    ev("update.drafted", { updateId: "w40", health: "on-track", reason: "ok" }, Date.parse("2026-10-02T15:00:00")),
    ev("update.published", { updateId: "w40", via: "p" }, Date.parse("2026-10-02T16:00:00")),
  ];
  eq(cockpit(published, { now: thursday }).update.late, false, "published on Friday");
});

/* ------------------------- the CLI, as a real process ------------------------ */

const execFileP = promisify(execFile);
const CLI = join(process.cwd(), "dist", "project-companion.mjs");

const repo = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pc-p3-")));
  for (const a of [["init", "-q", "-b", "main"], ["config", "user.email", "pm@example.com"], ["config", "user.name", "PM"]]) {
    execFileSync("git", a, { cwd: dir, stdio: "pipe" });
  }
  execFileSync(process.execPath, [CLI, "init", "Demo"], { cwd: dir, stdio: "pipe" });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

const pc = async (dir: string, args: string[], env: Record<string, string> = {}) => {
  try {
    const r = await execFileP(process.execPath, [CLI, ...args], { cwd: dir, env: { ...process.env, ...env } });
    return { code: 0, out: r.stdout, err: r.stderr };
  } catch (e) {
    const x = e as { code?: number; stdout?: string; stderr?: string };
    return { code: x.code ?? -1, out: x.stdout ?? "", err: x.stderr ?? "" };
  }
};

test("cli: a sprint, its gate covering its tasks, and its burn-up", async () => {
  const { dir, cleanup } = repo();
  try {
    const a = (await pc(dir, ["task", "add", "A", "--points", "3", "--kind", "story"])).out.split(/\s+/)[1];
    const b = (await pc(dir, ["task", "add", "B", "--points", "5"])).out.split(/\s+/)[1];
    eq((await pc(dir, ["sprint", "add", "2026-w41", "--start", "2026-10-05", "--end", "2026-10-09", "--goal", "Receipts", "--tasks", `${a},${b}`])).code, 0);
    mkdirSync(join(dir, "docs", "sprints"), { recursive: true });
    writeFileSync(join(dir, "docs", "sprints", "2026-w41.md"), "# Sprint\n");
    await pc(dir, ["gate", "request", "sprint", "2026-w41", "--artifact", "docs/sprints/2026-w41.md"]);
    const status = JSON.parse((await pc(dir, ["gate", "status", "--json"])).out) as { gates: { tasks: string[] }[] };
    eq(status.gates[0].tasks, [a, b], "the sprint gate covers the sprint's tasks");
    const shown = JSON.parse((await pc(dir, ["sprint", "show", "2026-w41", "--json"])).out) as { burnup: { unit: string; committed: number } };
    eq([shown.burnup.unit, shown.burnup.committed], ["points", 8]);
    eq((await pc(dir, ["sprint", "commit", "2026-w41", "--tasks", a])).code, 1, "a committed sprint cannot be re-committed");
    eq((await pc(dir, ["sprint", "add", "x", "--start", "2026-10-05", "--end", "2026-10-09", "--tasks", "nope"])).code, 1, "unknown tasks are refused");
  } finally { cleanup(); }
});

test("cli: answering a card and publishing an update need --via; they then appear as decided", async () => {
  const { dir, cleanup } = repo();
  try {
    const id = (JSON.parse((await pc(dir, ["card", "open", "--subject", "checkout", "--ask", "Which provider?", "--options", "ses|mailgun", "--json"])).out) as { id: string }).id;
    eq((await pc(dir, ["card", "answer", id, "ses"])).code, 1, "no --via, no answer");
    eq((await pc(dir, ["card", "answer", id, "ses", "--via", "prompt:pm"])).code, 0);
    eq((JSON.parse((await pc(dir, ["card", "list", "--open", "--json"])).out) as unknown[]).length, 0);

    await pc(dir, ["update", "draft", "2026-w41", "--health", "at-risk", "--reason", "Waiting on the provider."]);
    eq((await pc(dir, ["update", "publish", "2026-w41"])).code, 1, "no --via, no publish");
    eq((await pc(dir, ["update", "publish", "2026-w41", "--via", "prompt:pm"])).code, 0);
    eq((await pc(dir, ["update", "draft", "2026-w41", "--health", "on-track", "--reason", "x"])).code, 1, "a published update is final");
    const log = JSON.parse((await pc(dir, ["gate", "log", "--json"])).out) as { event: string; via: string }[];
    eq(log.map((e) => [e.event, e.via]), [["card.answered", "prompt:pm"], ["update.published", "prompt:pm"]], "PM decisions are in the decision log");
  } finally { cleanup(); }
});

test("cli: block and unblock a task; the cockpit shows it as blocked", async () => {
  const { dir, cleanup } = repo();
  try {
    const a = (await pc(dir, ["task", "add", "A"])).out.split(/\s+/)[1];
    await pc(dir, ["task", "block", a, "--reason", "Waiting for the provider choice", "--cause", "decision"]);
    let model = JSON.parse((await pc(dir, ["cockpit", "--json"])).out) as { blocked: { taskId: string; unblocker: string }[] };
    eq(model.blocked.map((b) => [b.taskId, b.unblocker]), [[a, "PM"]]);
    await pc(dir, ["task", "unblock", a]);
    model = JSON.parse((await pc(dir, ["cockpit", "--json"])).out);
    eq(model.blocked.length, 0);
    eq((await pc(dir, ["task", "block", a, "--reason", "x", "--cause", "weather"])).code, 1, "unknown causes are refused");
  } finally { cleanup(); }
});

test("cli: pr link reads GitHub through gh and never stores a token", async () => {
  const { dir, cleanup } = repo();
  try {
    const bin = join(dir, "fake-bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "gh"), `#!/bin/sh\necho '{"number":12,"url":"https://github.com/o/r/pull/12","state":"OPEN","headRefOid":"abc123"}'\n`);
    chmodSync(join(bin, "gh"), 0o755);
    const a = (await pc(dir, ["task", "add", "A"])).out.split(/\s+/)[1];
    eq((await pc(dir, ["pr", "link", a, "12"], { PATH: `${bin}:${process.env.PATH}` })).code, 0);
    const shown = JSON.parse((await pc(dir, ["task", "show", a, "--json"])).out) as { pr: { number: number; state: string; headSha: string } };
    eq([shown.pr.number, shown.pr.state, shown.pr.headSha], [12, "OPEN", "abc123"]);
  } finally { cleanup(); }
});

test("cli: a subagent's spawn, start, tool use and stop become a child run with its role and task", async () => {
  const { dir, cleanup } = repo();
  try {
    const a = (await pc(dir, ["task", "add", "Receipt email"])).out.split(/\s+/)[1];
    const hook = (payload: Record<string, unknown>) =>
      new Promise<void>((done) => {
        const child = execFile(process.execPath, [CLI, "ingest"], { cwd: dir }, () => done());
        child.stdin!.end(JSON.stringify({ session_id: "s1", cwd: dir, ...payload }));
      });
    await hook({ hook_event_name: "SessionStart" });
    await hook({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: "devolps:frontend-engineer", prompt: `Task: ${a}\nBuild it.` } });
    await hook({ hook_event_name: "SubagentStart", agent_id: "ag1", agent_type: "devolps:frontend-engineer" });
    await hook({ hook_event_name: "PostToolUse", agent_id: "ag1", tool_name: "Write", tool_input: { file_path: "components/Receipt.tsx" } });
    await hook({ hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "README.md" } });
    await hook({ hook_event_name: "SubagentStop", agent_id: "ag1" });
    const runs = JSON.parse((await pc(dir, ["run", "list", "--all", "--json"])).out || "[]") as AgentRun[];
    const child = runs.find((r) => r.role === "frontend-engineer");
    const parent = runs.find((r) => !r.parentRunId);
    ok(child, `a child run exists: ${JSON.stringify(runs)}`);
    eq([child!.taskId, child!.parentRunId, child!.state, child!.touched], [a, parent!.id, "awaiting_review", ["components/Receipt.tsx"]]);
    eq(parent!.spent.toolCalls, 1, "the main session's tool call stays with the main session");
  } finally { cleanup(); }
});

test("cli: flow --lane and gate metrics print JSON", async () => {
  const { dir, cleanup } = repo();
  try {
    eq((JSON.parse((await pc(dir, ["flow", "--lane", "agent", "--json"])).out) as { lane: string }).lane, "agent");
    eq((JSON.parse((await pc(dir, ["flow", "--lane", "human", "--json"])).out) as { lane: string }).lane, "human");
    eq(JSON.parse((await pc(dir, ["gate", "metrics", "--json"])).out), []);
    eq((await pc(dir, ["flow", "--lane", "robots"])).code, 1);
  } finally { cleanup(); }
});

runAll().then((failed) => process.exit(failed ? 1 : 0));
