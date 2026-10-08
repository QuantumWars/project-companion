import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  checkWork,
  foldGates,
  prdSection,
  requiredGates,
  withStaleness,
  type GateBook,
} from "@/lib/project/gate";
import type { ProjectEvent } from "@/lib/project/events";
import { eq, ok, runAll, test } from "./harness";

/**
 * Gates are the one place where a wrong "yes" is silent and expensive: work
 * starts on something nobody approved. So every rule here is tested from both
 * sides -- the case it must refuse and the case it must allow -- because a gate
 * tested only on the allow side passes just as well when it is broken.
 */

let clock = Date.parse("2026-10-07T09:00:00.000Z");
const ev = (kind: string, data: Record<string, unknown>): ProjectEvent => {
  clock += 1000;
  return { id: `a:${clock}`, ts: clock, seq: 0, actor: "a", prev: null, kind: kind as ProjectEvent["kind"], data };
};

const requested = (kind: string, subject: string, refs: string[], tasks: string[] = []) =>
  ev("gate.requested", { kind, subject, artifacts: refs.map((ref) => ({ ref, sha256: `h:${ref}` })), tasks });
const approved = (kind: string, subject: string, refs: string[], extra: Record<string, unknown> = {}) =>
  ev("gate.approved", { kind, subject, via: "prompt:p1", artifacts: refs.map((ref) => ({ ref, sha256: `h:${ref}` })), ...extra });
const track = (subject: string, value: string) => ev("track.confirmed", { subject, track: value, via: "prompt:p0" });

const unchanged = (ref: string) => `h:${ref}`;
const book = (events: ProjectEvent[], hash: (ref: string) => string | null = unchanged): GateBook =>
  withStaleness(foldGates(events), hash);
const noFiles = () => false;

/* ------------------------------ PRD sections ------------------------------ */

const PRD = [
  "# Product",
  "",
  "## Phase: Checkout",
  "",
  "### Guest checkout",
  "<!-- id: guest -->",
  "- [ ] When a guest pays, the system shall send a receipt.",
  "",
  "## Phase: Refunds",
  "",
  "### Refund flow",
  "- [x] When asked, the system shall refund.",
  "",
].join("\n");

test("a PRD section runs from its phase heading to the next phase", () => {
  const section = prdSection(PRD, "checkout")!;
  ok(section.includes("Guest checkout"), "the epic's features are inside");
  ok(!section.includes("Refund flow"), "the next epic is not");
});

test("ticking a checkbox does not change the section; editing the text does", () => {
  const ticked = PRD.replace("- [ ] When a guest pays", "- [x] When a guest pays");
  eq(prdSection(ticked, "checkout"), prdSection(PRD, "checkout"), "a tick is not a change");
  const edited = PRD.replace("send a receipt", "send two receipts");
  ok(prdSection(edited, "checkout") !== prdSection(PRD, "checkout"), "a changed requirement is");
});

test("another epic's edits do not touch this section", () => {
  const other = PRD.replace("shall refund", "shall refund within 5 days");
  eq(prdSection(other, "checkout"), prdSection(PRD, "checkout"));
});

test("an unknown epic has no section", () => {
  eq(prdSection(PRD, "loyalty"), null);
});

/* --------------------------------- folding -------------------------------- */

test("request then approval opens the gate", () => {
  const b = book([requested("prd", "checkout", ["a.md"]), approved("prd", "checkout", ["a.md"])]);
  eq(b.gates.get("prd:checkout")!.state, "approved");
});

test("a new request reopens an approved gate", () => {
  const b = book([
    requested("prd", "checkout", ["a.md"]),
    approved("prd", "checkout", ["a.md"]),
    requested("prd", "checkout", ["a.md"]),
  ]);
  eq(b.gates.get("prd:checkout")!.state, "requested");
});

test("a refusal keeps its reason", () => {
  const b = book([
    requested("design", "checkout", ["d.md"]),
    ev("gate.refused", { kind: "design", subject: "checkout", via: "prompt:p2", reason: "no rollback plan" }),
  ]);
  const g = b.gates.get("design:checkout")!;
  eq([g.state, g.reason], ["refused", "no rollback plan"]);
});

test("an approval with no request decides nothing", () => {
  const b = book([approved("prd", "ghost", ["a.md"])]);
  eq(b.gates.has("prd:ghost"), false);
});

test("an approval with an override is recorded as overridden", () => {
  const b = book([requested("prd", "x", ["a.md"]), approved("prd", "x", ["a.md"], { override: "deadline" })]);
  eq(b.gates.get("prd:x")!.state, "overridden");
});

test("changed approved bytes make the gate stale and name the file", () => {
  const b = book(
    [requested("design", "x", ["d.md", "t.md"]), approved("design", "x", ["d.md", "t.md"])],
    (ref) => (ref === "t.md" ? "different" : `h:${ref}`),
  );
  const g = b.gates.get("design:x")!;
  eq([g.state, g.changed], ["stale", ["t.md"]]);
});

test("a head commit is never re-hashed, so it cannot go stale here", () => {
  const b = book([requested("merge", "12", ["head:abc"]), approved("merge", "12", ["head:abc"])], () => "x");
  eq(b.gates.get("merge:12")!.state, "approved");
});

/* --------------------------------- tracks --------------------------------- */

test("required gates follow the track", () => {
  eq(requiredGates("full", "build"), ["prd", "design", "sprint"]);
  eq(requiredGates("full", "design"), ["prd"]);
  eq(requiredGates("quick", "build"), ["prd"]);
  eq(requiredGates("bugfix", "build"), []);
  eq(requiredGates("full", "prd"), [], "writing the PRD needs no gate");
});

/* ---------------------------------- check --------------------------------- */

test("early stages need no gate and no track", () => {
  eq(checkWork(book([]), { stage: "prd", epic: "checkout" }, noFiles).ok, true);
});

test("must refuse: design before the track is confirmed", () => {
  const r = checkWork(book([]), { stage: "design", epic: "checkout" }, noFiles);
  eq([r.ok, r.missing[0].what], [false, "track"]);
  ok(r.missing[0].remedy.includes("/devolps:approve track checkout"), "the remedy names the command");
});

test("must refuse: design before the PRD gate opens", () => {
  const r = checkWork(book([track("checkout", "full"), requested("prd", "checkout", ["a.md"])]), { stage: "design", epic: "checkout" }, noFiles);
  eq([r.ok, r.missing[0].what, r.missing[0].state], [false, "prd", "requested"]);
});

test("must allow: design once the PRD gate is approved", () => {
  const r = checkWork(
    book([track("checkout", "full"), requested("prd", "checkout", ["a.md"]), approved("prd", "checkout", ["a.md"])]),
    { stage: "design", epic: "checkout" },
    noFiles,
  );
  eq(r.ok, true);
});

test("must refuse: build on the full track without an approved sprint holding the task", () => {
  const events = [
    track("checkout", "full"),
    requested("prd", "checkout", ["a.md"]), approved("prd", "checkout", ["a.md"]),
    requested("design", "checkout", ["d.md"]), approved("design", "checkout", ["d.md"]),
    requested("sprint", "s1", ["s.md"], ["t-other"]), approved("sprint", "s1", ["s.md"]),
  ];
  const r = checkWork(book(events), { stage: "build", task: { id: "t1", epic: "checkout" } }, noFiles);
  eq([r.ok, r.missing.map((m) => m.what)], [false, ["sprint"]]);
});

test("must allow: build once an approved sprint holds the task", () => {
  const events = [
    track("checkout", "full"),
    requested("prd", "checkout", ["a.md"]), approved("prd", "checkout", ["a.md"]),
    requested("design", "checkout", ["d.md"]), approved("design", "checkout", ["d.md"]),
    requested("sprint", "s1", ["s.md"], ["t1"]), approved("sprint", "s1", ["s.md"]),
  ];
  eq(checkWork(book(events), { stage: "build", task: { id: "t1", epic: "checkout" } }, noFiles).ok, true);
});

test("must refuse: build when an approved design went stale", () => {
  const events = [
    track("checkout", "quick"),
    requested("prd", "checkout", ["specs/checkout/quick.md"]),
    approved("prd", "checkout", ["specs/checkout/quick.md"]),
  ];
  const r = checkWork(book(events, () => "edited"), { stage: "build", task: { id: "t1", epic: "checkout" } }, noFiles);
  eq([r.ok, r.missing[0].state], [false, "stale"]);
  ok(r.missing[0].remedy.includes("specs/checkout/quick.md"), "the remedy names the changed file");
});

test("quick track: one sign-off opens build", () => {
  const events = [track("checkout", "quick"), requested("prd", "checkout", ["q.md"]), approved("prd", "checkout", ["q.md"])];
  eq(checkWork(book(events), { stage: "build", task: { id: "t1", epic: "checkout" } }, noFiles).ok, true);
});

test("must refuse: a bug fix with no written bugfix spec", () => {
  const r = checkWork(book([track("t9", "bugfix")]), { stage: "build", task: { id: "t9" } }, noFiles);
  eq([r.ok, r.missing[0].what], [false, "bugfix-spec"]);
});

test("must allow: a bug fix once its spec exists, with no gate", () => {
  const r = checkWork(book([track("t9", "bugfix")]), { stage: "build", task: { id: "t9" } }, (p) => p === "specs/bugs/t9/bugfix.md");
  eq(r.ok, true);
});

test("a task's own track wins over its epic's", () => {
  const r = checkWork(
    book([track("checkout", "full"), track("t9", "bugfix")]),
    { stage: "build", task: { id: "t9", epic: "checkout" } },
    (p) => p === "specs/bugs/t9/bugfix.md",
  );
  eq([r.ok, r.track], [true, "bugfix"]);
});

test("must refuse: an unknown task", () => {
  const r = checkWork(book([]), { stage: "build", taskId: "nope", task: null }, noFiles);
  eq([r.ok, r.missing[0].what], [false, "task"]);
});

/* ------------------------- the CLI, as a real process ---------------------- */

const run = promisify(execFile);
const CLI = join(process.cwd(), "dist", "project-companion.mjs");

const repo = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pc-gate-")));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "grace@example.com");
  git("config", "user.name", "Grace H");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

const pc = (dir: string, ...args: string[]) =>
  run(process.execPath, [CLI, ...args], { cwd: dir }).then((r) => r.stdout);

/** Runs the CLI and returns its exit code and output instead of throwing. */
const pcExit = async (dir: string, ...args: string[]) => {
  try {
    const r = await run(process.execPath, [CLI, ...args], { cwd: dir });
    return { code: 0, out: r.stdout, err: r.stderr };
  } catch (e) {
    const x = e as { code?: number; stdout?: string; stderr?: string };
    return { code: x.code ?? -1, out: x.stdout ?? "", err: x.stderr ?? "" };
  }
};

const setup = async () => {
  const r = repo();
  await pc(r.dir, "init", "Demo");
  mkdirSync(join(r.dir, "docs"), { recursive: true });
  mkdirSync(join(r.dir, "specs", "checkout"), { recursive: true });
  writeFileSync(join(r.dir, "docs", "prd.md"), PRD);
  writeFileSync(join(r.dir, "specs", "checkout", "requirements.md"), "# Requirements\n");
  return r;
};

test("cli: an approval without --via is refused", async () => {
  const { dir, cleanup } = await setup();
  try {
    await pc(dir, "gate", "request", "prd", "checkout", "--artifact", "specs/checkout/requirements.md", "--prd-section", "checkout");
    const r = await pcExit(dir, "gate", "approve", "prd", "checkout");
    eq(r.code, 1);
    ok(r.err.includes("--via"), r.err);
  } finally { cleanup(); }
});

test("cli: approve, then a tick keeps it approved, then an edit stales it", async () => {
  const { dir, cleanup } = await setup();
  try {
    await pc(dir, "gate", "request", "prd", "checkout", "--artifact", "specs/checkout/requirements.md", "--prd-section", "checkout");
    await pc(dir, "gate", "approve", "prd", "checkout", "--via", "prompt:test-1");
    const state = async () => (JSON.parse(await pc(dir, "gate", "status", "--json")).gates as { state: string }[])[0].state;
    eq(await state(), "approved");

    const prd = join(dir, "docs", "prd.md");
    writeFileSync(prd, readFileSync(prd, "utf8").replace("- [ ] When a guest pays", "- [x] When a guest pays"));
    eq(await state(), "approved", "ticking a box does not stale the PRD gate");

    writeFileSync(prd, readFileSync(prd, "utf8").replace("send a receipt", "send two receipts"));
    eq(await state(), "stale", "changing the requirement does");
  } finally { cleanup(); }
});

test("cli: check exits 3 and names the fix; allows once open", async () => {
  const { dir, cleanup } = await setup();
  try {
    const blocked = await pcExit(dir, "gate", "check", "--epic", "checkout", "--stage", "design", "--json");
    eq(blocked.code, 3);
    eq(JSON.parse(blocked.out).missing[0].what, "track");

    await pc(dir, "gate", "track", "checkout", "full", "--via", "prompt:t");
    await pc(dir, "gate", "request", "prd", "checkout", "--prd-section", "checkout");
    await pc(dir, "gate", "approve", "prd", "checkout", "--via", "prompt:t2");
    const open = await pcExit(dir, "gate", "check", "--epic", "checkout", "--stage", "design", "--json");
    eq([open.code, JSON.parse(open.out).ok], [0, true]);
  } finally { cleanup(); }
});

test("cli: requesting a gate on a file that does not exist is refused", async () => {
  const { dir, cleanup } = await setup();
  try {
    const r = await pcExit(dir, "gate", "request", "design", "checkout", "--artifact", "specs/checkout/design.md");
    eq(r.code, 1);
    ok(r.err.includes("do not exist"), r.err);
  } finally { cleanup(); }
});

test("cli: gate log lists each decision with its channel", async () => {
  const { dir, cleanup } = await setup();
  try {
    await pc(dir, "gate", "request", "prd", "checkout", "--prd-section", "checkout");
    await pc(dir, "gate", "approve", "prd", "checkout", "--via", "prompt:abc");
    const log = JSON.parse(await pc(dir, "gate", "log", "--json")) as { event: string; via?: string }[];
    const approval = log.find((e) => e.event === "gate.approved")!;
    eq(approval.via, "prompt:abc");
  } finally { cleanup(); }
});

test("cli: version reports the gate capability", async () => {
  const out = JSON.parse(await pc(tmpdir(), "version", "--json")) as { capabilities: string[] };
  ok(out.capabilities.includes("gate"), JSON.stringify(out));
});

test("cli: task show --json names the task's epic", async () => {
  const { dir, cleanup } = await setup();
  try {
    await pc(dir, "prd", "sync");
    const created = await pc(dir, "task", "add", "Receipt email", "--phase", "checkout");
    const id = created.split(/\s+/)[1];
    const task = JSON.parse(await pc(dir, "task", "show", id, "--json")) as { id: string; epic: string };
    eq([task.id, task.epic], [id, "checkout"]);
  } finally { cleanup(); }
});

test("cli: init hooks run the PATH binary, and an old npx hook is upgraded", async () => {
  const { dir, cleanup } = repo();
  try {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "npx project-companion ingest" }] }] } }),
    );
    await pc(dir, "init", "Demo");
    const settings = readFileSync(join(dir, ".claude", "settings.json"), "utf8");
    ok(!settings.includes("npx project-companion"), "no npx command remains");
    eq((settings.match(/"project-companion ingest"/g) ?? []).length, 6, "one hook per event, none doubled");
    ok(settings.includes('"matcher": "Agent|Task"'), "PreToolUse is hooked only for spawns");
  } finally { cleanup(); }
});

test("cli: feature list, feature show and phase list print JSON with --json", async () => {
  const { dir, cleanup } = await setup();
  try {
    await pc(dir, "prd", "sync");
    const features = JSON.parse(await pc(dir, "feature", "list", "--json")) as { id: string }[];
    ok(features.some((f) => f.id === "guest"), JSON.stringify(features));
    const feature = JSON.parse(await pc(dir, "feature", "show", "guest", "--json")) as { id: string; tasks: unknown[] };
    eq([feature.id, Array.isArray(feature.tasks)], ["guest", true]);
    const phases = JSON.parse(await pc(dir, "phase", "list", "--json")) as { id: string }[];
    eq(phases.map((p) => p.id), ["checkout", "refunds"]);
  } finally { cleanup(); }
});

runAll().then((failed) => process.exit(failed ? 1 : 0));
