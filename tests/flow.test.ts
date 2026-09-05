import { attention, checkWip, queues, summarise, taskFlow } from "@/lib/project/flow";
import type { ProjectEvent } from "@/lib/project/events";
import type { Task, TaskStatus } from "@/lib/project/types";
import { eq, ok, runAll, test } from "./harness";

const T0 = Date.parse("2026-09-01T09:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 86_400_000;

const ev = (kind: string, data: Record<string, unknown>, atHours: number): ProjectEvent => ({
  id: `a:${atHours}`,
  ts: T0 + atHours * HOUR,
  seq: atHours,
  actor: "a",
  prev: null,
  kind: kind as ProjectEvent["kind"],
  data,
});

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id, title: id, status: "todo", order: 0,
  createdAt: "2026-09-01T09:00:00.000Z", updatedAt: "2026-09-01T09:00:00.000Z",
  ...over,
});

/* ------------------------------- the journey ------------------------------ */

test("a task's time in each stage comes out of the log", () => {
  const flows = taskFlow(
    [
      ev("task.created", { taskId: "t1", status: "todo" }, 0),
      ev("task.moved", { taskId: "t1", from: "todo", to: "in_progress" }, 2),
      ev("task.moved", { taskId: "t1", from: "in_progress", to: "review" }, 6),
      ev("task.moved", { taskId: "t1", from: "review", to: "done" }, 30),
    ],
    [task("t1", { status: "done" })],
    T0 + 30 * HOUR,
  );

  eq(flows[0].stages, [
    { status: "todo", ms: 2 * HOUR },
    { status: "in_progress", ms: 4 * HOUR },
    { status: "review", ms: 24 * HOUR },
  ]);
  eq(flows[0].cycleMs, 30 * HOUR, "created to done");
});

test("age is time in the current column, not time since creation", () => {
  const flows = taskFlow(
    [
      ev("task.created", { taskId: "t1", status: "todo" }, 0),
      ev("task.moved", { taskId: "t1", from: "todo", to: "review" }, 20),
    ],
    [task("t1", { status: "review" })],
    T0 + 24 * HOUR,
  );
  eq(flows[0].ageMs, 4 * HOUR, "it has waited four hours, not twenty-four");
});

test("leaving review for anything but done is rework", () => {
  const back = taskFlow(
    [
      ev("task.created", { taskId: "t1", status: "todo" }, 0),
      ev("task.moved", { taskId: "t1", from: "todo", to: "review" }, 1),
      ev("task.moved", { taskId: "t1", from: "review", to: "in_progress" }, 2),
    ],
    [task("t1", { status: "in_progress" })],
    T0 + 3 * HOUR,
  );
  eq(back[0].reworked, true, "it reached review and was sent back");

  const straight = taskFlow(
    [
      ev("task.created", { taskId: "t1", status: "todo" }, 0),
      ev("task.moved", { taskId: "t1", from: "review", to: "done" }, 2),
    ],
    [task("t1", { status: "done" })],
    T0 + 3 * HOUR,
  );
  eq(straight[0].reworked, false);
});

test("a task the board no longer has is not counted as in flight", () => {
  const flows = taskFlow([ev("task.created", { taskId: "gone", status: "todo" }, 0)], [], T0);
  eq(flows, [], "otherwise every deleted card inflates the queue for ever");
});

test("a deleted task leaves the flow, even though the log keeps the fact", () => {
  const flows = taskFlow(
    [
      ev("task.created", { taskId: "t1", status: "todo" }, 0),
      ev("task.deleted", { taskId: "t1" }, 1),
    ],
    [task("t1")],
    T0 + 2 * HOUR,
  );
  eq(flows, []);
});

/* --------------------------------- queues --------------------------------- */

const threeInReview = () =>
  taskFlow(
    [
      ev("task.created", { taskId: "a", status: "review" }, 0),
      ev("task.created", { taskId: "b", status: "review" }, 20),
      ev("task.created", { taskId: "c", status: "review" }, 23),
      ev("task.created", { taskId: "d", status: "todo" }, 23),
    ],
    ["a", "b", "c"].map((id) => task(id, { status: "review" })).concat(task("d")),
    T0 + 24 * HOUR,
  );

test("a queue reports its oldest, because the mean hides exactly that", () => {
  const [review] = queues(threeInReview()).filter((q) => q.status === "review");
  eq(review.count, 3);
  eq(review.oldestMs, 24 * HOUR, "one thing has been waiting a day");
  eq(review.medianAgeMs, 4 * HOUR, "and the median says four hours");
});

test("done is not a queue", () => {
  const flows = taskFlow(
    [
      ev("task.created", { taskId: "t1", status: "todo" }, 0),
      ev("task.moved", { taskId: "t1", from: "todo", to: "done" }, 1),
    ],
    [task("t1", { status: "done" })],
    T0 + 2 * HOUR,
  );
  eq(queues(flows), []);
});

test("the summary uses a median, because one abandoned card ruins a mean", () => {
  const flows = taskFlow(
    [1, 2, 300].flatMap((hours, i) => [
      ev("task.created", { taskId: `t${i}`, status: "todo" }, 0),
      ev("task.moved", { taskId: `t${i}`, from: "todo", to: "done" }, hours),
    ]),
    [0, 1, 2].map((i) => task(`t${i}`, { status: "done" })),
    T0 + 400 * HOUR,
  );
  eq(summarise(flows).cycleMs, 2 * HOUR, "not the 101-hour average");
  eq(summarise(flows).finished, 3);
});

/* ------------------------------- WIP limits ------------------------------- */

test("no limit means no refusal", () => {
  eq(checkWip(threeInReview(), {}), { ok: true });
});

test("a full column refuses, and names itself", () => {
  const verdict = checkWip(threeInReview(), { review: 3 });
  eq(verdict.ok, false);
  eq(verdict.status, "review");
  eq({ count: verdict.count, limit: verdict.limit }, { count: 3, limit: 3 });
});

test("room under the limit is room", () => {
  eq(checkWip(threeInReview(), { review: 4 }).ok, true);
});

test("a limit of zero is not a limit, it is an unset field", () => {
  eq(checkWip(threeInReview(), { review: 0 }).ok, true);
});

/* ------------------------------- attention -------------------------------- */

test("waiting on a person outranks waiting on a machine", () => {
  const flows = taskFlow(
    [
      ev("task.created", { taskId: "reviewing", status: "review" }, 0),
      ev("task.created", { taskId: "building", status: "in_progress" }, 0),
    ],
    [task("reviewing", { status: "review" }), task("building", { status: "in_progress" })],
    T0 + 48 * HOUR,
  );
  eq(attention(flows)[0].taskId, "reviewing");
  ok(attention(flows)[0].why.some((w) => w.includes("waiting on a person")));
});

test("blast radius lifts a task, but not without bound", () => {
  const flows = taskFlow(
    [
      ev("task.created", { taskId: "core", status: "in_progress" }, 0),
      ev("task.created", { taskId: "leaf", status: "in_progress" }, 0),
    ],
    [task("core", { status: "in_progress" }), task("leaf", { status: "in_progress" })],
    T0 + 24 * HOUR,
  );
  const ranked = attention(flows, {
    componentOf: { core: "core", leaf: "leaf" },
    fanIn: { core: 40, leaf: 1 },
  });
  eq(ranked[0].taskId, "core");
  ok(
    ranked[0].score < ranked[1].score * 5,
    "log, not linear -- forty dependents is not forty times more urgent",
  );
});

test("finished and unstarted work is not asking for attention", () => {
  const flows = taskFlow(
    [
      ev("task.created", { taskId: "done", status: "todo" }, 0),
      ev("task.moved", { taskId: "done", from: "todo", to: "done" }, 1),
      ev("task.created", { taskId: "someday", status: "backlog" }, 0),
    ],
    [task("done", { status: "done" }), task("someday", { status: "backlog" })],
    T0 + 2 * HOUR,
  );
  eq(attention(flows), []);
});

test("every ranking comes with the reasons behind it", () => {
  const flows = taskFlow(
    [
      ev("task.created", { taskId: "t1", status: "todo" }, 0),
      ev("task.moved", { taskId: "t1", from: "todo", to: "review" }, 1),
      ev("task.moved", { taskId: "t1", from: "review", to: "in_progress" }, 2),
      ev("task.moved", { taskId: "t1", from: "in_progress", to: "review" }, 3),
    ],
    [task("t1", { status: "review" })],
    T0 + 72 * HOUR,
  );
  const [top] = attention(flows);
  ok(top.why.length >= 3, top.why.join("; "));
  ok(top.why.some((w) => w.includes("sent back")), "a ranking nobody can argue with is not trusted");
});

runAll().then((failed) => process.exit(failed ? 1 : 0));
