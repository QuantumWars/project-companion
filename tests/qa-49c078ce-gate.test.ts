/**
 * QA gap test for bug 49c078ce. The revert check "no isLegacyStore gate in readSidecar" passed 7 of 7 in
 * tests/bug-49c078ce.test.ts: no test puts a REGULAR roadmap.json inside a `.project` folder. This test does.
 * A `.project` that is a folder holds no roadmap, so a roadmap.json inside it must not be read.
 * No device or FIFO is involved, so no child process is needed (test rules 3 and 4 do not apply).
 * Temporary HOME, no CLAUDE_PROJECT_DIR (test rule 5); the temporary folder is removed (rule 8).
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readRoadmap } from "@/lib/project/roadmap";
import { eq, test, runAll } from "./harness";

process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "pc-qa49c078ce-home-")));
delete process.env.CLAUDE_PROJECT_DIR;

test("49c078ce (QA): a regular roadmap.json inside a .project folder is not read", () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "pc-qa49c078ce-")));
  const root = join(parent, "project");
  try {
    mkdirSync(join(root, ".project"), { recursive: true });
    writeFileSync(
      join(root, ".project", "roadmap.json"),
      JSON.stringify({ version: 1, source: "docs/stale.md", phases: [], overrides: {}, orphans: [] }),
    );
    const roadmap = readRoadmap(root);
    eq(roadmap.source === "docs/stale.md", false, "a roadmap.json under a .project folder was read as the roadmap");
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(process.env.HOME as string, { recursive: true, force: true });
  }
});

runAll().then((failed) => process.exit(failed ? 1 : 0));
