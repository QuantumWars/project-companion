/**
 * Project CLI.
 *
 * The Bash-facing half of the agent integration: any agent that can run a
 * command can read and edit the boards, which covers Codex and anything else
 * without MCP support. The MCP server in `mcp/` exposes the same operations to
 * Claude Code as structured tools; both go through `lib/project/store`, so
 * there is one source of truth and no second implementation to drift.
 */

import { basename, dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import {
  createDiagram,
  createTask,
  createWhiteboard,
  deleteTask,
  findProject,
  findProjectRoot,
  initProject,
  moveStore,
  isTaskStatus,
  listDiagrams,
  moveTask,
  readDiagram,
  readProject,
  readTasks,
  recordCommits,
  reindexDiagrams,
  tasksForFeature,
  updateTask,
  writeDiagram,
} from "../lib/project/store";
import {
  editPrd,
  readRoadmap,
  setFeatureOverride,
  setPhase,
  setPrdSource,
} from "../lib/project/roadmap";
import { gitRoot, readCommits, readStatus, GitError } from "../lib/project/git";
import { branchNameFor, createBranch, addWorktree } from "../lib/project/git-write";
import { linkRepository } from "../lib/project/git-link";
import {
  PHASE_STATUSES,
  TASK_STATUSES,
  type DiagramFile,
  type TaskStatus,
} from "../lib/project/types";
import { parseSqlDdl } from "../lib/arch/import/sql-ddl";
import { parsePrismaSchema } from "../lib/arch/import/prisma";
import { SKILL_MD } from "../lib/project/skill-template";
import {
  forgetProject,
  globalIndexPath,
  listProjects,
  registerProject,
} from "../lib/project/registry";
import type { DiagramType } from "../types/arch";

const HELP = `
project-companion - architecture and task boards that live in your repo

  project-companion init [name]              create .arch/ in this directory
  project-companion status                   summarise the project

  project-companion diagram list             list diagrams
  project-companion diagram show <id>        print a diagram as text
  project-companion diagram json <id>        print a diagram as JSON
  project-companion diagram new <title> [--type architecture|flowchart|erd|...]
  project-companion diagram import <file> [--title T] [--id ID]
                                     SQL DDL or Prisma schema -> ER diagram

  project-companion board new <title>        create a freehand whiteboard

  project-companion prd sync                 re-read the PRD into the roadmap
  project-companion prd path <file>          point at a different PRD
  project-companion feature list [--phase P] [--status S]
  project-companion feature show <id>        criteria, tasks and commits
  project-companion feature add <title> [--phase P] [--summary S]
  project-companion feature check <id> <criterion>   tick an acceptance criterion
  project-companion feature pin <id> <status>        override the derived status
  project-companion phase list               phases, in document order
  project-companion phase add <name> [--goal G]
  project-companion phase set <id> [--status S] [--starts D] [--ends D]

  project-companion task list [--status S] [--feature F]
  project-companion task add <title> [--status S] [--node ID] [--feature F]
  project-companion task move <id> <status>  ${TASK_STATUSES.join(" | ")}
  project-companion task start <id> [--branch] [--worktree]
                                     open a branch for a task
  project-companion task done <id> [--commit SHA]
  project-companion task rm <id>

  project-companion git status               branch, ahead/behind, working tree
  project-companion git log [--limit N]      recent commits and what they are linked to
  project-companion git unlinked             commits with nothing on the board

  project-companion move <dir>               move the store, e.g. .claude/project-companion
  project-companion reindex                  rebuild the diagram index from disk

  project-companion projects                 every project on this machine
  project-companion projects forget <path>   drop one from the global index

Run inside a repo containing .arch/, or any directory below it.
`;

/* -------------------------------- helpers --------------------------------- */

const argv = process.argv.slice(2);

/**
 * Flags that take no value.
 *
 * The parser has to be told, because `--worktree feat/x` is indistinguishable
 * from `--branch feat/x` without it -- and guessing wrong silently eats the
 * next positional argument.
 */
const BOOLEAN_FLAGS = new Set(["worktree", "branch", "json", "refresh", "all", "force"]);

const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1 || BOOLEAN_FLAGS.has(name)) return undefined;
  const value = argv[i + 1];
  return value && !value.startsWith("--") ? value : undefined;
};

const has = (name: string): boolean => argv.includes(`--${name}`);

/** Positional arguments, with flags and their values removed. */
const positional = (): string[] => {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const name = token.slice(2);
      // Only skip the following token when this flag actually takes a value.
      if (!BOOLEAN_FLAGS.has(name) && argv[i + 1] && !argv[i + 1].startsWith("--")) i++;
      continue;
    }
    out.push(token);
  }
  return out;
};

const die = (message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

const fmtStatus = (value: string) => value.replace("_", " ");

const PRD_TEMPLATE = `# Product requirements

One paragraph on what this project is for.

## Phase: First phase

Goal: what this phase delivers.

### First feature

What it does, in a sentence.

Paths: src/**

- [ ] An acceptance criterion
`;

/**
 * The git subcommands, which are the only asynchronous part of the CLI.
 *
 * Every one of them reads. Branch creation lives under `task start`, where the
 * user has typed an explicit command -- that is the confirmation.
 */
const runGit = async (root: string, sub: string | undefined, rest: string[]) => {
  const repo = await gitRoot(root);
  if (!repo) die("Not inside a git repository.");

  if (sub === "status") {
    const status = await readStatus(repo!);
    process.stdout.write(
      `${status.branch ?? "(detached)"}  ahead ${status.ahead}  behind ${status.behind}  ${status.dirty} changed\n`,
    );
    return;
  }

  const roadmap = readRoadmap(root);
  const limit = Number(flag("limit")) || 50;
  const linked = await linkRepository(repo!, readTasks(root).tasks, roadmap.features, limit);

  if (sub === "unlinked") {
    if (!linked.unattributed.length) {
      process.stdout.write("Every recent commit is linked.\n");
      return;
    }
    for (const c of linked.unattributed) {
      process.stdout.write(`${c.short}  ${c.subject}\n`);
    }
    process.stdout.write(
      `\n${linked.unattributed.length} unlinked. Add \`project-companion: <taskId>\` to a commit message, or work on a branch named after the task.\n`,
    );
    return;
  }

  const titles = new Map(readTasks(root).tasks.map((t) => [t.id, t.title]));
  for (const c of linked.commits) {
    const label = c.taskId ? titles.get(c.taskId) ?? c.taskId : c.featureId ?? "";
    process.stdout.write(
      `${c.short}  ${(c.signal ?? "-").padEnd(9)} ${label.slice(0, 34).padEnd(34)} ${c.subject}\n`,
    );
  }
};

/** `task start` and `task done`: the two points where work meets the repository. */
const runTaskGit = async (root: string, sub: string, id: string) => {
  const task = readTasks(root).tasks.find((t) => t.id === id) ?? die(`No task "${id}"`);

  if (sub === "done") {
    const sha = flag("commit");
    if (sha) {
      const repo = await gitRoot(root);
      const resolved = repo
        ? (await readCommits(repo, { ref: sha === "HEAD" ? undefined : sha, limit: 1 }))[0]
        : undefined;
      recordCommits(root, id, [resolved?.sha ?? sha]);
    }
    moveTask(root, id, "done");
    process.stdout.write(`${id} -> done${sha ? `  (recorded ${sha})` : ""}\n`);
    return;
  }

  moveTask(root, id, "in_progress");
  const name = branchNameFor(task.id, task.title);

  if (!has("branch") && !has("worktree")) {
    // Without an explicit flag this only moves the task and SUGGESTS the name.
    // Creating a branch is a change to the repository, so it waits to be asked.
    process.stdout.write(
      `${id} -> in progress\n\nSuggested branch:\n  git checkout -b ${name}\n\nCommit with a trailer so the work links itself:\n  project-companion: ${id}\n`,
    );
    return;
  }

  const repo = await gitRoot(root);
  if (!repo) die("Not inside a git repository.");

  try {
    const branch = await createBranch(repo!, name);
    updateTask(root, id, { branch: name });
    process.stdout.write(
      `${id} -> in progress\n${branch.created ? "Created" : "Reusing"} ${name} (not checked out)\n`,
    );
    if (has("worktree")) {
      const tree = await addWorktree(repo!, `../${name.replace(/\//g, "-")}`, name);
      process.stdout.write(`Worktree ${tree.created ? "created" : "reused"} at ${tree.path}\n`);
    }
  } catch (error) {
    die(error instanceof GitError ? error.message : String(error));
  }
};

const requireRoot = (): string =>
  findProjectRoot() ??
  die("No .arch/ found. Run `project-companion init` at your project root.");

const describeDiagram = (diagram: DiagramFile): string => {
  const lines: string[] = [
    `${diagram.title}  [${diagram.type}]  id=${diagram.id}`,
    `${diagram.nodes.length} nodes, ${diagram.edges.length} edges`,
    "",
  ];

  for (const node of diagram.nodes) {
    const data = node.data as { label?: string; kind?: string };
    lines.push(`  ${node.id}  ${data.label ?? "(untitled)"}  <${data.kind ?? node.type}>`);
  }

  if (diagram.edges.length) {
    lines.push("");
    for (const edge of diagram.edges) {
      const label = (edge.data as { label?: string } | undefined)?.label;
      lines.push(`  ${edge.source} -> ${edge.target}${label ? `  (${label})` : ""}`);
    }
  }

  return lines.join("\n");
};

/* -------------------------------- commands -------------------------------- */

const main = () => {
  const args = positional();
  const [command, sub, ...rest] = args;

  if (!command || command === "help" || command === "--help") {
    process.stdout.write(HELP);
    return;
  }

  // The global index is machine-wide, so it works with no project in scope.
  if (command === "projects") {
    if (sub === "forget") {
      const path = rest[0] ?? die("Usage: project-companion projects forget <path>");
      process.stdout.write(
        forgetProject(path) ? `Forgot ${path}\n` : `Not indexed: ${path}\n`,
      );
      return;
    }

    const projects = listProjects();
    if (!projects.length) {
      process.stdout.write(
        `No projects indexed yet.\nRun \`project-companion init\` in a repository.\n`,
      );
      return;
    }

    for (const p of projects) {
      process.stdout.write(
        `${p.name.padEnd(24)} ${String(p.diagrams).padStart(2)} diagrams  ` +
          `${String(p.tasks).padStart(3)} tasks  ${p.path}\n`,
      );
    }
    process.stdout.write(`\nindex: ${globalIndexPath()}\n`);
    return;
  }

  if (command === "init") {
    const root = process.cwd();
    const name = sub ?? basename(root);
    const project = initProject(root, name);
    registerProject(root);

    // Write the skill next to the store so the agent picks the tool up from
    // the repository, with no MCP setup required.
    const storeDir = findProject(root)?.storeDir ?? "";
    const agentDir = storeDir.split("/")[0];
    if (agentDir && agentDir !== ".arch") {
      const skill = join(root, agentDir, "skills", "project-companion", "SKILL.md");
      if (!existsSync(skill)) {
        mkdirSync(dirname(skill), { recursive: true });
        writeFileSync(skill, SKILL_MD, "utf8");
      }
    }
    process.stdout.write(
      `Initialised "${project.name}" in ${root}/${findProject(root)?.storeDir}\n` +
        `Wrote the project-companion skill so your agent can use it directly.\n` +
        `Next: project-companion diagram new "System architecture"\n`,
    );
    return;
  }

  const root = requireRoot();

  // Touching a project is what puts it in (or refreshes it in) the index.
  registerProject(root);

  if (command === "status") {
    const project = readProject(root);
    const tasks = readTasks(root).tasks;
    const byStatus = TASK_STATUSES.map(
      (s) => `${s}: ${tasks.filter((t) => t.status === s).length}`,
    ).join("  ");

    const store = findProject(root)?.storeDir ?? "?";
    process.stdout.write(
      `${project.name}\n${root}/${store}\n\n` +
        `diagrams: ${project.diagrams.length}\n` +
        `tasks:    ${tasks.length}   ${byStatus}\n`,
    );
    return;
  }

  if (command === "diagram") {
    if (sub === "list") {
      const diagrams = listDiagrams(root);
      if (!diagrams.length) {
        process.stdout.write("No diagrams yet. `project-companion diagram new <title>`\n");
        return;
      }
      for (const d of diagrams) {
        const kind = d.kind === "whiteboard" ? "whiteboard" : d.type;
        process.stdout.write(`${d.id.padEnd(28)} ${kind.padEnd(14)} ${d.title}\n`);
      }
      return;
    }

    if (sub === "show" || sub === "json") {
      const id = rest[0] ?? die("Usage: project-companion diagram show <id>");
      const diagram = readDiagram(root, id) ?? die(`No diagram "${id}"`);
      process.stdout.write(
        sub === "json"
          ? `${JSON.stringify(diagram, null, 2)}\n`
          : `${describeDiagram(diagram)}\n`,
      );
      return;
    }

    if (sub === "new") {
      const title = rest[0] ?? die("Usage: project-companion diagram new <title>");
      const type = (flag("type") ?? "architecture") as DiagramType;
      const diagram = createDiagram(root, title, type);
      process.stdout.write(`Created ${diagram.id}\n`);
      return;
    }

    if (sub === "import") {
      const file = rest[0] ?? die("Usage: project-companion diagram import <file>");
      const source = readFileSync(resolve(file), "utf8");
      // Prisma declares `model X {`; SQL says CREATE TABLE. Either is decisive.
      const isPrisma =
        /^\s*model\s+\w+\s*\{/m.test(source) && !/create\s+table/i.test(source);
      const parsed = isPrisma ? parsePrismaSchema(source) : parseSqlDdl(source);

      if (!parsed.nodes.length) {
        die(`Nothing parsed from ${file}. ${parsed.warnings.join(" ")}`);
      }

      const id = flag("id");
      const target = id
        ? readDiagram(root, id) ?? die(`No diagram "${id}"`)
        : createDiagram(root, flag("title") ?? basename(file), "erd");

      writeDiagram(root, { ...target, nodes: parsed.nodes, edges: parsed.edges });
      process.stdout.write(
        `Imported ${parsed.nodes.length} tables, ${parsed.edges.length} relations into ${target.id}\n`,
      );
      for (const w of parsed.warnings) process.stderr.write(`warning: ${w}\n`);
      return;
    }

    die(HELP);
  }

  if (command === "board") {
    if (sub === "new") {
      const title = rest[0] ?? die("Usage: project-companion board new <title>");
      const board = createWhiteboard(root, title);
      process.stdout.write(`Created ${board.id}\n`);
      return;
    }

    return die(HELP);
  }

  if (command === "task") {
    if (sub === "list") {
      const status = flag("status");
      if (status && !isTaskStatus(status)) {
        die(`Unknown status "${status}" (${TASK_STATUSES.join(" | ")})`);
      }
      const feature = flag("feature");
      const tasks = readTasks(root).tasks.filter(
        (t) => (!status || t.status === status) && (!feature || t.featureId === feature),
      );
      if (!tasks.length) {
        process.stdout.write("No tasks.\n");
        return;
      }
      for (const t of tasks) {
        const nodes = t.nodeIds?.length ? `  -> ${t.nodeIds.join(",")}` : "";
        const linked = t.featureId ? `  [${t.featureId}]` : "";
        process.stdout.write(
          `${t.id}  ${t.status.padEnd(12)} ${t.title}${linked}${nodes}\n`,
        );
      }
      return;
    }

    if (sub === "add") {
      const title = rest[0] ?? die("Usage: project-companion task add <title>");
      const raw = flag("status");
      if (raw !== undefined && !isTaskStatus(raw)) {
        return die(`Unknown status "${raw}". One of: ${TASK_STATUSES.join(", ")}`);
      }
      const status: TaskStatus | undefined = raw;
      const node = flag("node");
      const feature = flag("feature");
      if (feature && !readRoadmap(root).features.some((f) => f.id === feature)) {
        // Fail rather than silently storing a dangling id: an unresolvable
        // featureId puts the task in a swimlane that does not exist.
        die(`No feature "${feature}". Run \`project-companion feature list\`.`);
      }

      const task = createTask(root, {
        title,
        status,
        description: flag("description"),
        nodeIds: node ? [node] : undefined,
        diagramId: flag("diagram"),
        featureId: feature,
        phaseId: flag("phase"),
      });
      process.stdout.write(`Created ${task.id}  [${task.status}]  ${task.title}\n`);
      return;
    }

    if (sub === "start" || sub === "done") {
      const id = rest[0] ?? die(`Usage: project-companion task ${sub} <id>`);
      void runTaskGit(root, sub, id);
      return;
    }

    if (sub === "move") {
      const [id, status] = rest;
      if (!id || !status) return die("Usage: project-companion task move <id> <status>");
      if (!isTaskStatus(status)) {
        return die(`Unknown status "${status}". One of: ${TASK_STATUSES.join(", ")}`);
      }
      const task = moveTask(root, id, status) ?? die(`No task "${id}"`);
      process.stdout.write(`${task.id} -> ${task.status}\n`);
      return;
    }

    if (sub === "rm") {
      const id = rest[0] ?? die("Usage: project-companion task rm <id>");
      if (!deleteTask(root, id)) die(`No task "${id}"`);
      process.stdout.write(`Deleted ${id}\n`);
      return;
    }

    die(HELP);
  }

  if (command === "move") {
    const target = sub ?? die("Usage: project-companion move <dir>   e.g. .claude/project-companion");
    const moved = moveStore(root, target);
    if (!moved) {
      return die(`Nothing to move (store is already at ${findProject(root)?.storeDir}).`);
    }
    process.stdout.write(`Moved ${moved.from} -> ${moved.to}\n`);
    return;
  }

  /* ---------------------------------- prd ---------------------------------- */

  if (command === "prd") {
    if (sub === "path") {
      const file = rest[0] ?? die("Usage: project-companion prd path <file>");
      const roadmap = setPrdSource(root, file);
      process.stdout.write(`PRD source is now ${roadmap.source}\n`);
      return;
    }

    if (sub === "init") {
      const roadmap = readRoadmap(root);
      if (roadmap.present) die(`${roadmap.source} already exists.`);
      writeFileSync(join(root, roadmap.source), PRD_TEMPLATE, "utf8");
      process.stdout.write(`Created ${roadmap.source}\n`);
      return;
    }

    // `sync` is a read: the roadmap is assembled from the markdown every time,
    // so there is nothing to import. It exists to report what was parsed.
    const roadmap = readRoadmap(root);
    if (!roadmap.present) die(`No PRD at ${roadmap.source}. Run \`project-companion prd init\`.`);
    process.stdout.write(
      `${roadmap.source}\n${roadmap.phases.length} phases, ${roadmap.features.length} features\n`,
    );
    for (const warning of roadmap.warnings) process.stderr.write(`warning: ${warning}\n`);
    return;
  }

  /* -------------------------------- features -------------------------------- */

  if (command === "feature") {
    const roadmap = readRoadmap(root);
    if (!roadmap.present) die(`No PRD at ${roadmap.source}. Run \`project-companion prd init\`.`);

    if (sub === "show") {
      const id = rest[0] ?? die("Usage: project-companion feature show <id>");
      const feature =
        roadmap.features.find((f) => f.id === id) ?? die(`No feature "${id}"`);
      const lines = [
        `${feature.title}  [${fmtStatus(feature.status)}]  id=${feature.id}`,
        feature.phaseId ? `phase: ${feature.phaseId}` : "",
        feature.summary ?? "",
        "",
      ].filter((l) => l !== "");
      for (const c of feature.acceptance) lines.push(`  [${c.done ? "x" : " "}] ${c.text}`);
      const tasks = tasksForFeature(root, feature.id);
      if (tasks.length) {
        lines.push("", "tasks:");
        for (const t of tasks) lines.push(`  ${t.id}  ${fmtStatus(t.status).padEnd(12)} ${t.title}`);
      }
      process.stdout.write(`${lines.join("\n")}\n`);
      return;
    }

    if (sub === "add") {
      const title = rest[0] ?? die("Usage: project-companion feature add <title> [--phase P]");
      editPrd(root, undefined, [
        { op: "addFeature", title, phaseId: flag("phase"), summary: flag("summary") },
      ]);
      process.stdout.write(`Added "${title}"\n`);
      return;
    }

    if (sub === "check" || sub === "uncheck") {
      const id = rest[0] ?? die("Usage: project-companion feature check <id> <criterion>");
      const needle = rest.slice(1).join(" ").toLowerCase();
      const feature = roadmap.features.find((f) => f.id === id) ?? die(`No feature "${id}"`);
      const criterion =
        feature.acceptance.find((c) => c.id === needle) ??
        feature.acceptance.find((c) => c.text.toLowerCase().includes(needle)) ??
        die(`No criterion matching "${needle}" on ${id}`);
      editPrd(root, undefined, [
        { op: "setCriterion", featureId: id, criterionId: criterion.id, done: sub === "check" },
      ]);
      const after = readRoadmap(root).features.find((f) => f.id === id)!;
      process.stdout.write(`[${sub === "check" ? "x" : " "}] ${criterion.text}\n${id} is now ${fmtStatus(after.status)}\n`);
      return;
    }

    if (sub === "pin") {
      const id = rest[0] ?? die("Usage: project-companion feature pin <id> <status|none>");
      const value = rest[1] ?? die("Usage: project-companion feature pin <id> <status|none>");
      if (value !== "none" && !isTaskStatus(value)) die(`Unknown status "${value}"`);
      const feature =
        setFeatureOverride(root, id, {
          statusOverride: value === "none" ? undefined : (value as TaskStatus),
        }) ?? die(`No feature "${id}"`);
      process.stdout.write(`${id} -> ${fmtStatus(feature.status)}${feature.statusOverride ? " (pinned)" : " (derived)"}\n`);
      return;
    }

    const phase = flag("phase");
    const status = flag("status");
    const rows = roadmap.features.filter(
      (f) => (!phase || f.phaseId === phase) && (!status || f.status === status),
    );
    if (!rows.length) {
      process.stdout.write("No features.\n");
      return;
    }
    for (const f of rows) {
      const done = f.acceptance.filter((c) => c.done).length;
      process.stdout.write(
        `${f.id.padEnd(26)} ${fmtStatus(f.status).padEnd(12)} ${String(done).padStart(2)}/${f.acceptance.length}  ${f.title}\n`,
      );
    }
    return;
  }

  /* --------------------------------- phases --------------------------------- */

  if (command === "phase") {
    const roadmap = readRoadmap(root);

    if (sub === "add") {
      const name = rest[0] ?? die("Usage: project-companion phase add <name> [--goal G]");
      editPrd(root, undefined, [{ op: "addPhase", name, goal: flag("goal") }]);
      process.stdout.write(`Added phase "${name}"\n`);
      return;
    }

    if (sub === "set") {
      const id = rest[0] ?? die("Usage: project-companion phase set <id> [--status S]");
      const status = flag("status");
      if (status && !PHASE_STATUSES.includes(status as never)) {
        die(`Unknown phase status "${status}" (${PHASE_STATUSES.join(" | ")})`);
      }
      const phase =
        setPhase(root, {
          id,
          status: status as never,
          startsAt: flag("starts"),
          endsAt: flag("ends"),
        }) ?? die(`No phase "${id}"`);
      process.stdout.write(`${phase.id}  ${phase.status}${phase.startsAt ? `  ${phase.startsAt}` : ""}\n`);
      return;
    }

    if (!roadmap.phases.length) {
      process.stdout.write("No phases. Add `## Phase: <name>` to the PRD.\n");
      return;
    }
    for (const p of roadmap.phases) {
      const features = roadmap.features.filter((f) => f.phaseId === p.id);
      const done = features.filter((f) => f.status === "done").length;
      process.stdout.write(
        `${p.id.padEnd(24)} ${p.status.padEnd(8)} ${done}/${features.length}  ${p.goal ?? ""}\n`,
      );
    }
    return;
  }

  /* ----------------------------------- git ---------------------------------- */

  if (command === "git") {
    void runGit(root, sub, rest);
    return;
  }

  if (command === "reindex") {
    process.stdout.write(`Reindexed ${reindexDiagrams(root)} diagrams\n`);
    return;
  }

  die(HELP);
};

main();
