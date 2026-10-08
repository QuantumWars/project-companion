import {
  activeRuns, attestation, canTransition, checkBudget, mayWrite, runsFrom,
  RUN_STATES, type AgentRun, type RunState,
} from "@/lib/project/run";
import type { ProjectEvent } from "@/lib/project/events";
import { eq, ok, runAll, test } from "./harness";

let clock = Date.parse("2026-09-01T09:00:00.000Z");

/** An event as the log would hold it. `at` advances the clock by that many ms. */
const ev = (
  kind: string,
  data: Record<string, unknown>,
  options: { at?: number; componentId?: string } = {},
): ProjectEvent => {
  clock += options.at ?? 1000;
  return {
    id: `a:${clock}`,
    ts: clock,
    seq: 0,
    actor: "a",
    prev: null,
    componentId: options.componentId,
    kind: kind as ProjectEvent["kind"],
    data,
  };
};

const started = (over: Record<string, unknown> = {}) =>
  ev("run.started", {
    runId: "r1",
    actor: { kind: "agent", model: "claude-opus-5", harness: "claude-code" },
    autonomy: "confirm",
    budget: { tokens: 1000, toolCalls: 10 },
    ...over,
  }, { componentId: "auth" });

const run = (over: Partial<AgentRun> = {}): AgentRun => ({
  id: "r1",
  state: "running",
  actor: { kind: "agent", model: "claude-opus-5" },
  autonomy: "confirm",
  budget: {},
  spent: { inputTokens: 0, outputTokens: 0, toolCalls: 0, wallClockMs: 0 },
  touched: [],
  updatedAt: "2026-09-01T09:00:00.000Z",
  ...over,
});

/* ----------------------------- state machine ------------------------------ */

test("the lifecycle only moves where it should", () => {
  ok(canTransition("proposed", "approved"));
  ok(canTransition("running", "awaiting_review"));
  ok(canTransition("awaiting_review", "merged"));
  ok(!canTransition("proposed", "running"), "approval is not skippable");
  ok(!canTransition("running", "merged"), "work does not merge without review");
  ok(!canTransition("merged", "running"), "a merged run is finished");
});

test("blocked is a decision point, not an end", () => {
  ok(canTransition("running", "blocked"));
  ok(canTransition("blocked", "running"), "raising the budget resumes it");
  ok(canTransition("blocked", "abandoned"));
});

test("every state can be abandoned except the two that are already over", () => {
  for (const state of RUN_STATES) {
    const terminal = state === "merged" || state === "abandoned";
    eq(canTransition(state as RunState, "abandoned"), !terminal, state);
  }
});

/* -------------------------------- budgets --------------------------------- */

test("an unset ceiling is silence, not zero", () => {
  const verdict = checkBudget(run({ budget: {}, spent: { inputTokens: 9e6, outputTokens: 9e6, toolCalls: 500, wallClockMs: 9e6 } }));
  ok(verdict.ok, "a project that configured no budget does not block every run");
});

test("tokens are one ceiling, counted together", () => {
  const verdict = checkBudget(run({
    budget: { tokens: 1000 },
    spent: { inputTokens: 600, outputTokens: 400, toolCalls: 0, wallClockMs: 0 },
  }));
  eq(verdict.ok, false);
  eq(verdict.exceeded, "tokens");
  ok(verdict.detail?.includes("1000"), verdict.detail);
});

test("tool calls and wall clock each stop a run, and say which", () => {
  eq(checkBudget(run({ budget: { toolCalls: 5 }, spent: { ...run().spent, toolCalls: 5 } })).exceeded, "toolCalls");
  eq(checkBudget(run({ budget: { wallClockMs: 1000 }, spent: { ...run().spent, wallClockMs: 1200 } })).exceeded, "wallClock");
});

test("a run just under its ceiling may continue", () => {
  ok(checkBudget(run({ budget: { tokens: 100 }, spent: { ...run().spent, inputTokens: 99 } })).ok);
});

/* ------------------------------- boundaries ------------------------------- */

test("a run with no boundary may write anywhere", () => {
  ok(mayWrite(run(), "anything/at/all.ts"), "an unscoped run is useless, not safe, if it can write nothing");
});

test("a boundary is the component's paths", () => {
  const scoped = run({ writeGlobs: ["lib/auth/**"] });
  ok(mayWrite(scoped, "lib/auth/token.ts"));
  ok(!mayWrite(scoped, "lib/billing/invoice.ts"));
});

/* ------------------------------- projection ------------------------------- */

test("a run is assembled from its events, not stored", () => {
  const runs = runsFrom([started()]);
  eq(runs.length, 1);
  eq(runs[0].state, "running");
  eq(runs[0].componentId, "auth", "the component comes off the event, not the payload");
  eq(runs[0].actor.model, "claude-opus-5");
  eq(runs[0].budget.tokens, 1000);
});

test("progress accumulates tokens and files, and dedupes the files", () => {
  const runs = runsFrom([
    started(),
    ev("run.progress", { runId: "r1", inputTokens: 100, outputTokens: 50, toolCalls: 1, touched: ["a.ts"] }),
    ev("run.progress", { runId: "r1", inputTokens: 200, outputTokens: 30, toolCalls: 1, touched: ["a.ts", "b.ts"] }),
  ]);
  eq(runs[0].spent.inputTokens, 300);
  eq(runs[0].spent.outputTokens, 80);
  eq(runs[0].spent.toolCalls, 2);
  eq(runs[0].touched, ["a.ts", "b.ts"], "a file touched twice is one file");
});

test("wall clock is elapsed time, not the sum of overlapping tool durations", () => {
  const runs = runsFrom([
    started(),
    ev("run.progress", { runId: "r1", toolCalls: 1 }, { at: 5000 }),
    ev("run.progress", { runId: "r1", toolCalls: 1 }, { at: 5000 }),
  ]);
  eq(runs[0].spent.wallClockMs, 10_000, "two 5s steps ten seconds apart is ten seconds");
});

test("an illegal transition in the log is dropped, not applied", () => {
  const runs = runsFrom([
    started(),
    ev("run.state", { runId: "r1", state: "awaiting_review" }),
    ev("run.state", { runId: "r1", state: "merged" }),
    // Something writes nonsense afterwards. The log cannot be edited, so the
    // projection has to refuse it.
    ev("run.state", { runId: "r1", state: "running" }),
  ]);
  eq(runs[0].state, "merged", "a merged run does not come back to life");
});

test("an unknown state is ignored rather than stored", () => {
  const runs = runsFrom([started(), ev("run.state", { runId: "r1", state: "teleported" })]);
  eq(runs[0].state, "running");
});

test("a duplicate start is a replay, not a reset", () => {
  const runs = runsFrom([
    started(),
    ev("run.progress", { runId: "r1", inputTokens: 500 }),
    started(),
  ]);
  eq(runs.length, 1);
  eq(runs[0].spent.inputTokens, 500, "the spend so far is not wiped");
});

test("progress for a run that never started is ignored", () => {
  eq(runsFrom([ev("run.progress", { runId: "ghost", inputTokens: 10 })]), []);
});

test("events with no runId are not runs", () => {
  eq(runsFrom([ev("task.created", { taskId: "t1" })]), []);
});

test("finishing records when, and why when there is a reason", () => {
  const runs = runsFrom([
    started(),
    ev("run.state", { runId: "r1", state: "blocked", reason: "Budget exhausted." }),
    ev("run.state", { runId: "r1", state: "abandoned" }),
  ]);
  eq(runs[0].state, "abandoned");
  eq(runs[0].reason, "Budget exhausted.", "the reason survives the next transition");
  ok(runs[0].endedAt, "a terminal state stamps an end");
});

test("active means running or blocked -- both still need a human", () => {
  const runs = runsFrom([
    started(),
    ev("run.state", { runId: "r1", state: "awaiting_review" }),
  ]);
  eq(activeRuns(runs).length, 0, "waiting for review is not the agent's turn");
  eq(activeRuns([run({ state: "blocked" })]).length, 1);
});

/* ------------------------------- attestation ------------------------------ */

test("a human always signs, because a model cannot be accountable", () => {
  const lines = attestation(run(), { name: "Grace H", email: "grace@example.com" });
  ok(lines.some((l) => l.startsWith("Signed-off-by: Grace H")), lines.join(" "));
  ok(lines.some((l) => l.startsWith("Co-authored-by: claude-opus-5")), lines.join(" "));
  ok(lines.some((l) => l.includes("project-companion-run: r1")), "the run is nameable afterwards");
});

test("the trailer states how much of the change the model made", () => {
  const who = { name: "G", email: "g@e.com" };
  ok(attestation(run(), who, "assisted")[0].startsWith("Assisted-by:"));
  ok(attestation(run(), who, "generated")[0].startsWith("Generated-by:"));
});

runAll().then((failed) => process.exit(failed ? 1 : 0));
