import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hashSource } from "@/lib/project/prd";
import {
  deriveStatus,
  editPrd,
  readRoadmap,
  RoadmapConflictError,
  setFeatureOverride,
  setPhase,
} from "@/lib/project/roadmap";
import { initProject } from "@/lib/project/store";
import { eq, ok, runAll, test } from "./harness";

/**
 * A throwaway project per test. `realpath` because /tmp is a symlink on macOS,
 * and a project registered under two paths is a bug I would rather not chase
 * again.
 */
const project = (prd?: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "archboard-roadmap-")));
  initProject(dir, "Test");
  if (prd !== undefined) {
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "docs", "prd.md"), prd, "utf8");
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

const PRD = `# Checkout PRD

Intro prose that must survive.

## Phase: Foundations

Goal: ship a working cart.

### Guest checkout
<!-- id: guest-checkout -->

Allow purchase without an account.

- [x] No login prompt
- [ ] Email receipt sent

### Saved cards
<!-- id: saved-cards -->

- [ ] Tokenised
`;

test("a project with no PRD reports it instead of failing", () => {
  const { dir, cleanup } = project();
  try {
    const roadmap = readRoadmap(dir);
    eq(roadmap.present, false);
    eq(roadmap.features, []);
    ok(roadmap.warnings.some((w) => w.includes("No PRD")), "no warning");
  } finally {
    cleanup();
  }
});

test("features and phases assemble from the markdown", () => {
  const { dir, cleanup } = project(PRD);
  try {
    const roadmap = readRoadmap(dir);
    eq(roadmap.present, true);
    eq(roadmap.title, "Checkout PRD");
    eq(roadmap.phases.map((p) => p.id), ["foundations"]);
    eq(roadmap.features.map((f) => f.id), ["guest-checkout", "saved-cards"]);
  } finally {
    cleanup();
  }
});

test("status is derived from the checkboxes", () => {
  eq(deriveStatus([{ done: true }, { done: true }]), "done");
  eq(deriveStatus([{ done: true }, { done: false }]), "in_progress");
  eq(deriveStatus([{ done: false }]), "todo");
  eq(deriveStatus([]), "todo");
  const { dir, cleanup } = project(PRD);
  try {
    const roadmap = readRoadmap(dir);
    eq(roadmap.features.find((f) => f.id === "guest-checkout")!.status, "in_progress");
    eq(roadmap.features.find((f) => f.id === "saved-cards")!.status, "todo");
  } finally {
    cleanup();
  }
});

test("ticking the last box moves the feature to done, with no sidecar write", () => {
  const { dir, cleanup } = project(PRD);
  try {
    editPrd(dir, undefined, [
      { op: "setCriterion", featureId: "guest-checkout", criterionId: "email-receipt-sent", done: true },
    ]);
    const roadmap = readRoadmap(dir);
    eq(roadmap.features.find((f) => f.id === "guest-checkout")!.status, "done");
    // Nothing was pinned, so nothing should have been stored.
    const sidecar = JSON.parse(readFileSync(join(dir, ".claude/archboard/roadmap.json"), "utf8"));
    eq(sidecar.overrides, {});
  } finally {
    cleanup();
  }
});

test("an override pins status, and clearing it returns to derived", () => {
  const { dir, cleanup } = project(PRD);
  try {
    const pinned = setFeatureOverride(dir, "guest-checkout", { statusOverride: "review" });
    eq(pinned!.status, "review");
    eq(pinned!.statusOverride, "review");

    const cleared = setFeatureOverride(dir, "guest-checkout", { statusOverride: undefined });
    eq(cleared!.status, "in_progress", "should fall back to derived");

    // An empty override is removed rather than left as a husk.
    const sidecar = JSON.parse(readFileSync(join(dir, ".claude/archboard/roadmap.json"), "utf8"));
    eq(sidecar.overrides, {});
  } finally {
    cleanup();
  }
});

test("architecture node links survive on the sidecar", () => {
  const { dir, cleanup } = project(PRD);
  try {
    setFeatureOverride(dir, "guest-checkout", { nodeIds: ["node-a", "node-b"] });
    eq(readRoadmap(dir).features.find((f) => f.id === "guest-checkout")!.nodeIds, ["node-a", "node-b"]);
  } finally {
    cleanup();
  }
});

test("phase dates live in the sidecar; order comes from the document", () => {
  const { dir, cleanup } = project(PRD);
  try {
    setPhase(dir, { id: "foundations", startsAt: "2026-09-01", endsAt: "2026-09-14", status: "active" });
    const phase = readRoadmap(dir).phases.find((p) => p.id === "foundations")!;
    eq(phase.startsAt, "2026-09-01");
    eq(phase.status, "active");
    eq(phase.order, 0);
    // The name still comes from the PRD, not the sidecar.
    eq(phase.name, "Foundations");
  } finally {
    cleanup();
  }
});

test("a stale baseHash is refused rather than clobbering the file", () => {
  const { dir, cleanup } = project(PRD);
  try {
    const before = readRoadmap(dir).sourceHash;

    // An agent edits the PRD in the terminal.
    writeFileSync(join(dir, "docs", "prd.md"), PRD + "\n## Late arrival\n", "utf8");

    let caught: unknown;
    try {
      editPrd(dir, before, [{ op: "setTitle", featureId: "guest-checkout", value: "Nope" }]);
    } catch (error) {
      caught = error;
    }

    ok(caught instanceof RoadmapConflictError, "expected a conflict");
    eq((caught as RoadmapConflictError).sourceHash, hashSource(readFileSync(join(dir, "docs", "prd.md"), "utf8")));
    // The agent's edit is intact and ours was not applied.
    const text = readFileSync(join(dir, "docs", "prd.md"), "utf8");
    ok(text.includes("Late arrival"), "agent edit lost");
    ok(!text.includes("Nope"), "our edit was applied despite the conflict");
  } finally {
    cleanup();
  }
});

test("retrying against the fresh hash succeeds", () => {
  const { dir, cleanup } = project(PRD);
  try {
    writeFileSync(join(dir, "docs", "prd.md"), PRD + "\n## Late arrival\n", "utf8");
    const fresh = readRoadmap(dir).sourceHash;
    const after = editPrd(dir, fresh, [
      { op: "setTitle", featureId: "guest-checkout", value: "Guest checkout v2" },
    ]);
    eq(after.features.find((f) => f.id === "guest-checkout")!.title, "Guest checkout v2");
  } finally {
    cleanup();
  }
});

test("a heading that vanishes orphans rather than deletes", () => {
  const { dir, cleanup } = project(PRD);
  try {
    setFeatureOverride(dir, "saved-cards", { nodeIds: ["node-x"] });
    // Simulate the sidecar having recorded the feature, then the heading going.
    const path = join(dir, ".claude/archboard/roadmap.json");
    const sidecar = JSON.parse(readFileSync(path, "utf8"));
    sidecar.orphans = [
      {
        id: "saved-cards",
        idSource: "marker",
        title: "Saved cards",
        status: "todo",
        order: 1,
        acceptance: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    writeFileSync(path, JSON.stringify(sidecar, null, 2), "utf8");

    // While the heading is still there, it is not an orphan.
    eq(readRoadmap(dir).orphans.length, 0);

    writeFileSync(join(dir, "docs", "prd.md"), PRD.split("### Saved cards")[0], "utf8");
    const roadmap = readRoadmap(dir);
    eq(roadmap.features.map((f) => f.id), ["guest-checkout"]);
    eq(roadmap.orphans.map((o) => o.id), ["saved-cards"]);
    eq(roadmap.orphans[0].orphaned, true);
  } finally {
    cleanup();
  }
});

test("editing through the app leaves the prose alone", () => {
  const { dir, cleanup } = project(PRD);
  try {
    editPrd(dir, undefined, [
      { op: "addCriterion", featureId: "saved-cards", text: "PCI scope documented" },
    ]);
    const text = readFileSync(join(dir, "docs", "prd.md"), "utf8");
    ok(text.includes("Intro prose that must survive."), "prose lost");
    ok(text.includes("Goal: ship a working cart."), "phase goal lost");
    eq(readRoadmap(dir).features.find((f) => f.id === "saved-cards")!.acceptance.length, 2);
  } finally {
    cleanup();
  }
});

runAll().then((failed) => process.exit(failed ? 1 : 0));
