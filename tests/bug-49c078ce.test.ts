/**
 * Regression test for bug 49c078ce (TH-7 residual 3, "open" parts; security review F2 of bugfix 54b4e811):
 * `readJson` (`lib/project/store.ts`) reads the older store files (`project.json`, `tasks.json`, `roadmap.json`,
 * diagrams, boards) with a plain `readFileSync`, and when a merged commit makes `.project` a FOLDER,
 * `readSidecar` / `writeSidecar` (`lib/project/roadmap.ts`) read and write `.project/roadmap.json` through
 * `readJson` / `writeJson` with no check on its kind.
 *
 * Hang cases run in a second, killable process: this same file, re-run with a flag (see
 * `tests/bug-54b4e811.test.ts` for the full reason). The blocking file is a FIFO with no writer, never
 * `/dev/zero`, which grows memory by gigabytes. Every child has a kill timeout. Write cases run in-process
 * (no device is involved). Each test uses a temporary project and a temporary HOME, no CLAUDE_PROJECT_DIR,
 * and the inherited PROJECT_COMPANION_NOTIFY (nothing here reaches the notifier).
 */

import { spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { editPrd, readRoadmap, setPrdSource } from "@/lib/project/roadmap";
import { initProject, readDiagram, readTasks, writeJson } from "@/lib/project/store";
import { emptyProject } from "@/lib/project/types";
import { eq, test, runAll } from "./harness";

const HELPER_FLAG = "--49c078ce-helper";
const PROBE_TIMEOUT_MS = 3000;
const LEGACY = ".claude/project-companion";

if (process.argv[2] === HELPER_FLAG) {
  // Helper mode: call exactly one function under test and print a JSON summary. No test is registered.
  const [action, root] = process.argv.slice(3);
  try {
    let value: unknown;
    if (action === "readRoadmap") {
      const r = readRoadmap(root);
      value = { present: r.present, phases: r.phases.length };
    } else if (action === "readTasks") {
      value = readTasks(root).tasks.length;
    } else {
      value = readDiagram(root, "d1");
    }
    process.stdout.write(JSON.stringify({ ok: true, value }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  }
  process.exit(0);
} else {
  // In-process tests: no CLAUDE_PROJECT_DIR (the runner sets a temporary HOME), set before any project call.
  delete process.env.CLAUDE_PROJECT_DIR;

  const tmpProject = () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "pc-49c078ce-")));
    const root = join(parent, "project");
    const home = join(parent, "home");
    mkdirSync(root, { recursive: true });
    mkdirSync(home, { recursive: true });
    return { parent, root, home, cleanup: () => rmSync(parent, { recursive: true, force: true }) };
  };

  const mkfifo = (path: string): boolean => {
    const made = spawnSync("mkfifo", [path]);
    return !made.error && made.status === 0;
  };

  /** The message of the error `fn` throws; "no error" when it does not throw. */
  const refusal = (fn: () => unknown): string => {
    try {
      fn();
      return "no error";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  type ProbeResult = { timedOut: boolean; ok?: boolean; value?: unknown; error?: string };

  const probe = (action: string, root: string, home: string): ProbeResult => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
    delete env.CLAUDE_PROJECT_DIR;
    const run = spawnSync(process.execPath, [process.argv[1], HELPER_FLAG, action, root], {
      timeout: PROBE_TIMEOUT_MS,
      killSignal: "SIGKILL",
      encoding: "utf8",
      env,
    });
    if (run.signal || run.error) return { timedOut: true };
    try {
      return { timedOut: false, ...(JSON.parse(run.stdout) as { ok: boolean; value?: unknown; error?: string }) };
    } catch {
      return { timedOut: false, ok: false, error: `unreadable helper output: ${JSON.stringify(run.stdout)} ${run.stderr}` };
    }
  };

  const makeLegacy = (root: string) => {
    mkdirSync(join(root, LEGACY), { recursive: true });
    writeJson(join(root, LEGACY, "project.json"), emptyProject("Legacy"));
  };

  /* --------------------------------- reads --------------------------------- */

  test("49c078ce: .project as a folder with roadmap.json a symlink to a FIFO is read as no roadmap", () => {
    const { parent, root, home, cleanup } = tmpProject();
    try {
      const fifo = join(parent, "roadmap.fifo");
      if (!mkfifo(fifo)) return;
      mkdirSync(join(root, ".project"));
      symlinkSync(fifo, join(root, ".project", "roadmap.json"));

      const result = probe("readRoadmap", root, home);
      eq(result.timedOut, false, "readRoadmap (the first call of readCockpit) must not block on .project/roadmap.json");
      eq(result.ok, true, `readRoadmap must not throw: ${JSON.stringify(result)}`);
      eq(result.value, { present: false, phases: 0 }, "a .project folder holds no roadmap");
    } finally {
      cleanup();
    }
  });

  test("49c078ce: a legacy tasks.json that is a symlink to a FIFO is not read", () => {
    const { parent, root, home, cleanup } = tmpProject();
    try {
      const fifo = join(parent, "tasks.fifo");
      if (!mkfifo(fifo)) return;
      makeLegacy(root);
      symlinkSync(fifo, join(root, LEGACY, "tasks.json"));

      const result = probe("readTasks", root, home);
      eq(result.timedOut, false, "readTasks must not block on a tasks.json that is a FIFO");
      eq(result.ok, true, `readTasks must not throw: ${JSON.stringify(result)}`);
      eq(result.value, 0, "a tasks.json that is not a regular file counts as empty");
    } finally {
      cleanup();
    }
  });

  test("49c078ce: a legacy diagram file that is a symlink to a FIFO is not read", () => {
    const { parent, root, home, cleanup } = tmpProject();
    try {
      const fifo = join(parent, "diagram.fifo");
      if (!mkfifo(fifo)) return;
      makeLegacy(root);
      mkdirSync(join(root, LEGACY, "diagrams"));
      symlinkSync(fifo, join(root, LEGACY, "diagrams", "d1.json"));

      const result = probe("readDiagram", root, home);
      eq(result.timedOut, false, "readDiagram must not block on a diagram file that is a FIFO");
      eq(result.ok, true, `readDiagram must not throw: ${JSON.stringify(result)}`);
      eq(result.value, null, "a diagram file that is not a regular file counts as missing");
    } finally {
      cleanup();
    }
  });

  /* --------------------------------- writes -------------------------------- */

  test("49c078ce: a .project that is a symlink to a folder outside the root is not written through", () => {
    const { parent, root, cleanup } = tmpProject();
    try {
      const outside = join(parent, "outside");
      mkdirSync(outside);
      symlinkSync(outside, join(root, ".project"));

      eq(refusal(() => setPrdSource(root, "docs/other.md")), `No .project at ${root}`, "the write must be refused with the No .project error");
      eq(existsSync(join(outside, "roadmap.json")), false, "roadmap.json was written outside the root through the linked .project");
    } finally {
      cleanup();
    }
  });

  test("49c078ce: a .project that is a real folder gets no roadmap.json written into it", () => {
    const { root, cleanup } = tmpProject();
    try {
      mkdirSync(join(root, ".project"));
      eq(refusal(() => setPrdSource(root, "docs/other.md")), `No .project at ${root}`, "the write must be refused with the No .project error");
      eq(existsSync(join(root, ".project", "roadmap.json")), false, "the legacy fallback wrote into a .project folder");
    } finally {
      cleanup();
    }
  });

  test("49c078ce: editPrd on a .project folder is refused before the PRD is written", () => {
    const { root, cleanup } = tmpProject();
    try {
      mkdirSync(join(root, ".project"));
      mkdirSync(join(root, "docs"));
      const body = "# Product\n\n## Phase 1\n\n### Feature one\n\n- [ ] Criterion one\n";
      writeFileSync(join(root, "docs", "prd.md"), body);

      eq(
        refusal(() => editPrd(root, undefined, [{ op: "addPhase", name: "Phase 2" }])),
        `No .project at ${root}`,
        "editPrd must refuse with the No .project error",
      );
      eq(readFileSync(join(root, "docs", "prd.md"), "utf8"), body, "the PRD file must be unchanged");
      eq(existsSync(join(root, ".project", "roadmap.json")), false, "nothing is written under .project");
    } finally {
      cleanup();
    }
  });

  /* -------------------------------- control -------------------------------- */

  test("49c078ce: a normal legacy store still reads and writes (control)", () => {
    const { root, cleanup } = tmpProject();
    try {
      makeLegacy(root);
      const task = { id: "t1", title: "Legacy task" };
      writeJson(join(root, LEGACY, "tasks.json"), { version: 1, tasks: [task] });
      writeJson(join(root, LEGACY, "diagrams", "d1.json"), { id: "d1", title: "D" });

      eq(readTasks(root).tasks.length, 1, "legacy tasks.json is still read");
      eq((readDiagram(root, "d1") as { title?: string } | null)?.title, "D", "a legacy diagram is still read");

      writeJson(join(root, LEGACY, "roadmap.json"), { version: 1, source: "docs/a.md", phases: [], overrides: {}, orphans: [] });
      eq(readRoadmap(root).source, "docs/a.md", "legacy roadmap.json is still read");
      setPrdSource(root, "docs/b.md");
      eq(JSON.parse(readFileSync(join(root, LEGACY, "roadmap.json"), "utf8")).source, "docs/b.md", "legacy roadmap.json is still written");
    } finally {
      cleanup();
    }
  });

  test("49c078ce: a normal .project file still reads and writes (control)", () => {
    const { root, cleanup } = tmpProject();
    try {
      initProject(root, "Bundle");
      setPrdSource(root, "docs/c.md");
      eq(readRoadmap(root).source, "docs/c.md", "the source set in .project is read back");
      eq(existsSync(join(root, ".project", "roadmap.json")), false, "a .project file has no roadmap.json beside it");
    } finally {
      cleanup();
    }
  });

  runAll().then((failed) => process.exit(failed ? 1 : 0));
}
