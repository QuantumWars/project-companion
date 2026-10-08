import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parsePrd, applyOps } from "@/lib/project/prd";
import { readRoadmap, editPrd } from "@/lib/project/roadmap";
import { initProject } from "@/lib/project/store";
import { proofState, runCheck, verifications } from "@/lib/project/verify";
import { eq, ok, runAll, test } from "./harness";

const PRD = `# Gated

## Phase: One

### Auth
<!-- id: auth -->

What it does.

Paths: lib/auth/**

Verify: npm test -- auth

- [ ] It rejects a replayed token
`;

const project = (prd = PRD) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pc-verify-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "g@e.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "G"], { cwd: dir });
  initProject(dir, "Gated");
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "docs", "prd.md"), prd, "utf8");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

/* ---------------------------------- parse --------------------------------- */

test("a Verify line is read, and is not mistaken for the summary", () => {
  const feature = parsePrd(PRD).features[0];
  eq(feature.verify, "npm test -- auth");
  eq(feature.summary, "What it does.", "the prose above it is still the summary");
  eq(feature.paths, ["lib/auth/**"]);
});

test("a feature with no Verify line simply has none", () => {
  const prd = PRD.replace("Verify: npm test -- auth\n\n", "");
  eq(parsePrd(prd).features[0].verify, undefined);
});

test("a Verify line inside a fence is not a command", () => {
  const prd = `# P\n\n## Phase: One\n\n### Auth\n<!-- id: auth -->\n\n\`\`\`\nVerify: rm -rf /\n\`\`\`\n\n- [ ] a\n`;
  eq(parsePrd(prd).features[0].verify, undefined, "a code sample is not an instruction");
});

/* ---------------------------------- edit ---------------------------------- */

test("setting a command adds the line, and the rest survives byte for byte", () => {
  const prd = PRD.replace("Verify: npm test -- auth\n\n", "");
  const next = applyOps(prd, [{ op: "setVerify", featureId: "auth", value: "make check" }]);
  ok(next.includes("Verify: make check"), next);
  ok(next.includes("What it does."), "the summary is untouched");
  ok(next.includes("Paths: lib/auth/**"), "and so are the paths");
});

test("changing a command replaces it rather than adding a second", () => {
  const next = applyOps(PRD, [{ op: "setVerify", featureId: "auth", value: "make check" }]);
  eq(next.match(/^Verify:/gm)?.length, 1);
  ok(next.includes("Verify: make check"));
});

test("clearing a command removes the line", () => {
  const next = applyOps(PRD, [{ op: "setVerify", featureId: "auth", value: null }]);
  ok(!next.includes("Verify:"), next);
  ok(next.includes("Paths: lib/auth/**"), "and takes nothing else with it");
});

test("editing one feature's command leaves its neighbours identical", () => {
  const two = PRD + `\n### Billing\n<!-- id: billing -->\n\nProse that must survive.\n\n- [ ] b\n`;
  const next = applyOps(two, [{ op: "setVerify", featureId: "auth", value: "x" }]);
  ok(next.includes("Prose that must survive."), "the verification would have thrown otherwise");
});

/* --------------------------------- running -------------------------------- */

test("a command that succeeds reports so, with its timing", async () => {
  const { dir, cleanup } = project();
  try {
    const result = await runCheck(dir, "auth", "true");
    eq(result.ok, true);
    eq(result.code, 0);
    ok(result.ms >= 0);
  } finally { cleanup(); }
});

test("a failing command carries its exit code and its last words", async () => {
  const { dir, cleanup } = project();
  try {
    const result = await runCheck(dir, "auth", "echo 'the reason' >&2; exit 3");
    eq(result.ok, false);
    eq(result.code, 3);
    ok(result.output.includes("the reason"), result.output);
  } finally { cleanup(); }
});

test("a command runs in the project, not wherever the caller was", async () => {
  const { dir, cleanup } = project();
  try {
    const result = await runCheck(dir, "auth", "test -f docs/prd.md");
    eq(result.ok, true);
  } finally { cleanup(); }
});

test("a shell-shaped command works, because that is what people write", async () => {
  const { dir, cleanup } = project();
  try {
    eq((await runCheck(dir, "auth", "echo a && echo b")).ok, true);
  } finally { cleanup(); }
});

/* ------------------------------- the gate --------------------------------- */

test("a criterion the check refuses cannot stay ticked", () => {
  const { dir, cleanup } = project(PRD.replace("- [ ] It rejects", "- [x] It rejects"));
  try {
    eq(readRoadmap(dir).features[0].status, "done", "claimed, before anything checked it");

    // What the CLI does on a failure.
    const feature = readRoadmap(dir).features[0];
    editPrd(dir, undefined, feature.acceptance.filter((c) => c.done).map((c) => ({
      op: "setCriterion" as const, featureId: feature.id, criterionId: c.id, done: false,
    })));

    eq(readRoadmap(dir).features[0].status, "todo", "and not, after");
    ok(
      readFileSync(join(dir, "docs", "prd.md"), "utf8").includes("Verify: npm test -- auth"),
      "the command itself is untouched",
    );
  } finally { cleanup(); }
});

/* ----------------------------- what is proven ----------------------------- */

const verified = (featureId: string, ok: boolean, ts: number) => ({
  kind: "criterion.verified",
  ts,
  data: { featureId, ok, command: "npm test" },
});

test("only the latest result counts", () => {
  const state = verifications([
    verified("auth", false, 100),
    verified("auth", true, 200),
  ]);
  eq(state.auth.ok, true, "a check that failed on Tuesday and passes now is passing");
});

test("results arriving out of order do not overwrite a newer one", () => {
  const state = verifications([verified("auth", true, 200), verified("auth", false, 100)]);
  eq(state.auth.ok, true, "the log merges across actors, so order is not guaranteed");
});

test("other events are not verifications", () => {
  eq(verifications([{ kind: "task.moved", ts: 1, data: { featureId: "auth" } }]), {});
});

test("claimed and proven are different states, and drawn differently", () => {
  const done = { status: "done", verify: "npm test" };
  eq(proofState(done, { ok: true, at: 1, command: "npm test" }), "proven");
  eq(proofState(done, { ok: false, at: 1, command: "npm test" }), "failing");
  eq(proofState(done, undefined), "claimed", "every box ticked, and nobody has run the check");
  eq(proofState({ status: "done" }, undefined), "claimed", "no command means nothing checks it");
});

test("work that is not claiming to be done is not failing verification", () => {
  eq(proofState({ status: "in_progress", verify: "npm test" }, undefined), "unclaimed");
});

runAll().then((failed) => process.exit(failed ? 1 : 0));
