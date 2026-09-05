/**
 * Project CLI.
 *
 * The Bash-facing half of the agent integration: any agent that can run a
 * command can read and edit the boards, which covers Codex and anything else
 * without MCP support. The MCP server in `mcp/` exposes the same operations to
 * Claude Code as structured tools; both go through `lib/project/store`, so
 * there is one source of truth and no second implementation to drift.
 */

import { basename, dirname, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import {
  createDiagram,
  createTask,
  createWhiteboard,
  deleteDiagram,
  deleteProject,
  deleteTask,
  findProject,
  findProjectRoot,
  initProject,
  migrateProject,
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
  createComponent,
  deleteComponent,
  readRun,
  readRuns,
  recordVerification,
  reportRun,
  resolvePolicy,
  runForSession,
  setRunState,
  startRun,
  declaredEdges,
  readComponent,
  readBundleWip,
  setWipLimit,
  wipRoom,
  readComponents,
  updateComponent,
} from "../lib/project/store";
import {
  ancestorsOf,
  catalogWarnings,
  componentTree,
  resolveComponent,
  withDescendants,
  COMPONENT_LIFECYCLES,
  type ComponentLifecycle,
  type ComponentNode,
} from "../lib/project/component";
import { readEvents } from "../lib/project/events";
import { componentContext } from "../lib/project/component-context";
import { parseHook } from "../lib/project/ingest";
import { mergeBundles } from "../lib/project/merge";
import { runCheck } from "../lib/project/verify";
import { dependencyGraph, drift } from "../lib/project/deps";
import { packet, route, type PacketInput } from "../lib/project/review";
import { attention, checkWip, summarise as summariseFlow, taskFlow } from "../lib/project/flow";
import { RUN_STATES, type RunState } from "../lib/project/run";
import {
  editPrd,
  readRoadmap,
  setFeatureOverride,
  setPhase,
  setPrdSource,
} from "../lib/project/roadmap";
import { gitRoot, readCommits, readDiffHunks, readStatus, GitError } from "../lib/project/git";
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

  project-companion init [name]              create a .project file here
  project-companion status                   summarise the project

  project-companion component list           the architecture's components
  project-companion component show <id>      owner, paths, tasks, children
  project-companion component add <title> [--paths "a/**,b/**"] [--owner WHO]
                                             [--parent ID] [--node ID] [--diagram ID]
  project-companion component set <id> [--paths P] [--owner W] [--parent ID]
                                             [--lifecycle proposed|active|deprecated]
  project-companion component rm <id>        delete it; children are promoted
  project-companion component doctor         what is wrong with the catalog
  project-companion whose <path>             which component owns a file
  project-companion drift                    the canvas, against what the code does
  project-companion review [sha]             write a review packet for your agent
  project-companion flow                     where work is piling up
  project-companion wip [status] [n]         limit a column; starting is refused when full
  project-companion next                     what to look at first

  project-companion diagram list             list diagrams
  project-companion diagram show <id>        print a diagram as text
  project-companion diagram json <id>        print a diagram as JSON
  project-companion diagram new <title> [--type architecture|flowchart|erd|...]
  project-companion diagram import <file> [--title T] [--id ID]
                                     SQL DDL or Prisma schema -> ER diagram

  project-companion diagram rm <id>          delete a diagram

  project-companion board new <title>        create a freehand whiteboard

  project-companion prd sync                 re-read the PRD into the roadmap
  project-companion prd path <file>          point at a different PRD
  project-companion feature list [--phase P] [--status S]
  project-companion feature show <id>        criteria, tasks and commits
  project-companion feature add <title> [--phase P] [--summary S]
  project-companion feature check <id> <criterion>   tick an acceptance criterion
  project-companion feature pin <id> <status>        override the derived status
  project-companion verify [featureId]       run the PRD's Verify: commands
  project-companion phase list               phases, in document order
  project-companion phase add <name> [--goal G]
  project-companion phase set <id> [--status S] [--starts D] [--ends D]

  project-companion task list [--status S] [--feature F] [--component C]
  project-companion task add <title> [--status S] [--node ID] [--feature F]
                                             [--component C]
  project-companion task move <id> <status>  ${TASK_STATUSES.join(" | ")}
  project-companion task start <id> [--branch] [--worktree]
                                     open a branch for a task
  project-companion task done <id> [--commit SHA]
  project-companion task rm <id>

  project-companion merge-driver <base> <ours> <theirs>
                                             git calls this; init registers it
  project-companion run start [taskId] [--component C] [--model M] [--session S]
                                             open a run, with that work's budget
  project-companion run list [--all]         runs still in flight
  project-companion run show <id>            spend, boundary, files touched
  project-companion run <state> <id> [reason]
                                             ${RUN_STATES.join(" | ")}
  project-companion ingest                   a harness hook payload, on stdin

  project-companion log [--limit N] [--component ID]
                                             the event log: what happened, in order

  project-companion git status               branch, ahead/behind, working tree
  project-companion git log [--limit N]      recent commits and what they are linked to
  project-companion git unlinked             commits with nothing on the board

  project-companion move <dir>               move the store, e.g. .claude/project-companion
  project-companion reindex          rebuild the diagram index from disk
  project-companion migrate          convert a split store into one .project file

  project-companion projects                 every project on this machine
  project-companion projects forget <path>   drop one from the global index

Run inside a repo containing a .project file, or any directory below it.
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

/**
 * Stops starting when the queue in front of the bottleneck is full.
 *
 * Theory of constraints, applied literally: the useful action when review is
 * backed up is to go and finish something, not to add a fifth thing to it. The
 * message names the column and the numbers, because a refusal somebody cannot
 * argue with is a refusal they route around.
 */
const requireWipRoom = (root: string) => {
  const verdict = wipRoom(root);
  if (verdict.ok) return;
  die(
    `${fmtStatus(verdict.status!)} is full: ${verdict.count} of ${verdict.limit}.\n` +
      `Finish something there before starting more, or raise the limit with ` +
      `\`project-companion wip ${verdict.status} <n>\`.`,
  );
};

const asDays = (ms: number) =>
    ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : ms < 86_400_000 ? `${Math.round(ms / 3_600_000)}h` : `${Math.round(ms / 86_400_000)}d`;

/**
 * Which agent directory the skill belongs in.
 *
 * An existing one wins, so a Codex or Cursor user is not handed a `.claude/`
 * they never asked for. Otherwise `.claude/`, which is the common case and the
 * one the README documents.
 */
const AGENT_DIRS = [".claude", ".codex", ".cursor", ".gemini"] as const;

const agentDirFor = (root: string): string =>
  AGENT_DIRS.find((dir) => existsSync(join(root, dir))) ?? AGENT_DIRS[0];

/**
 * Teaches this clone to merge `.project` structurally.
 *
 * Two halves, because git needs both: `.gitattributes` says which driver a path
 * uses and is committed, so everybody gets it; `.git/config` says what the
 * driver actually runs and is local, because a repository that could ship
 * executable commands to whoever clones it would be a supply-chain problem.
 *
 * That split is why this is idempotent and why a clone that never runs `init`
 * simply falls back to git's line merge -- degraded, not broken.
 */
const installMergeDriver = (root: string): "added" | "present" => {
  const attributes = join(root, ".gitattributes");
  const line = ".project merge=project-companion";
  const existing = existsSync(attributes) ? readFileSync(attributes, "utf8") : "";

  let added: "added" | "present" = "present";
  if (!existing.includes(line)) {
    writeFileSync(
      attributes,
      `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${line}\n`,
      "utf8",
    );
    added = "added";
  }

  try {
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString();
    git("config", "merge.project-companion.name", "project-companion structural merge");
    git("config", "merge.project-companion.driver", "npx project-companion merge-driver %O %A %B");
  } catch {
    // Not a repository, or git is unavailable. The attribute is still correct
    // for whenever it becomes one.
  }
  return added;
};

const HOOK_EVENTS = ["SessionStart", "PostToolUse", "SessionEnd"] as const;
const HOOK_COMMAND = "npx project-companion ingest";

/**
 * Wires the agent's hooks so runs record themselves.
 *
 * Merged into whatever is already in `settings.json` rather than written over
 * it. Somebody's formatter, their linter, their notification -- all of those
 * live in the same file, and a tool that installs itself by deleting them is a
 * tool that gets uninstalled. An existing entry for this command is left alone,
 * so running `init` twice does not stack three copies.
 */
const installHooks = (root: string, agentDir: string): "added" | "present" | "skipped" => {
  const path = join(root, agentDir, "settings.json");
  let settings: Record<string, unknown> = {};

  if (existsSync(path)) {
    try {
      settings = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      // Refusing to touch a file we cannot parse: rewriting it would lose
      // whatever is in there, and that is worse than not installing a hook.
      return "skipped";
    }
  }

  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
  let added = false;

  for (const event of HOOK_EVENTS) {
    const matchers = Array.isArray(hooks[event]) ? (hooks[event] as Record<string, unknown>[]) : [];
    const already = matchers.some((m) =>
      (Array.isArray(m.hooks) ? (m.hooks as Record<string, unknown>[]) : []).some(
        (h) => h.command === HOOK_COMMAND,
      ),
    );
    if (already) continue;

    matchers.push({ hooks: [{ type: "command", command: HOOK_COMMAND }] });
    hooks[event] = matchers;
    added = true;
  }

  if (!added) return "present";

  settings.hooks = hooks;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return "added";
};

/** `--paths "a/**,b/**"` -- comma or whitespace separated, both are natural to type. */
const splitList = (value: string | undefined): string[] | undefined =>
  value === undefined ? undefined : value.split(/[,\s]+/).filter(Boolean);

/** One line of an event's payload, for `log`. */
const summarise = (data: Record<string, unknown>): string =>
  Object.entries(data)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("|") : String(v)}`)
    .join(" ")
    .slice(0, 90);

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
  die("No project here. Run `project-companion init` at your project root.");

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
    if (sub === "delete") {
      const target = rest[0] ?? die("Usage: project-companion projects delete <path>");
      // Deleting data is not something to infer from an abbreviation, so the
      // path must be given in full and is echoed back before it happens.
      const summary = deleteProject(resolve(target));
      if (!summary) {
        die(`No project store at ${resolve(target)} (nothing was deleted).`);
      }
      forgetProject(resolve(target));
      process.stdout.write(
        `Deleted ${summary!.removed}\n  ${summary!.diagrams} diagrams, ${summary!.tasks} tasks\n` +
          `Your source files were not touched.\n`,
      );
      return;
    }

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

  /**
   * Git's merge driver for `.project`.
   *
   * Registered by `init`, invoked by git with three temporary files. Exits 0
   * when it merged cleanly and 1 when it could not, which is the contract --
   * a non-zero exit leaves git's conflict markers in place rather than
   * pretending the merge worked.
   */
  if (command === "merge-driver") {
    const [base, ours, theirs] = [sub, rest[0], rest[1]];
    if (!base || !ours || !theirs) die("Usage: project-companion merge-driver <base> <ours> <theirs>");

    const read = (path: string) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return "";
      }
    };

    const result = mergeBundles(read(base!), read(ours!), read(theirs!));
    if (!result.merged || result.conflicts.length) {
      process.stderr.write(
        `project-companion: cannot merge ${result.conflicts.join(", ")} automatically.\n`,
      );
      process.exit(1);
    }

    // Git reads the result back out of `ours`.
    writeFileSync(ours!, `${JSON.stringify(result.merged, null, 2)}\n`, "utf8");
    return;
  }

  if (command === "init") {
    const root = process.cwd();
    const name = sub ?? basename(root);
    const project = initProject(root, name);
    registerProject(root);

    // Write the skill into the agent's own directory so the tool is picked up
    // from the repository, with no MCP setup required.
    //
    // This used to derive the directory from the store path, which worked while
    // the store WAS an agent directory (`.claude/project-companion/`). Since the
    // single-file format it is `.project` -- a file -- so that derivation asked
    // for `mkdir .project/skills/...` and `init` died with ENOTDIR on every new
    // project. The agent directory is a separate question from where the data
    // lives, and is now asked separately.
    const skill = join(root, agentDirFor(root), "skills", "project-companion", "SKILL.md");
    if (!existsSync(skill)) {
      mkdirSync(dirname(skill), { recursive: true });
      writeFileSync(skill, SKILL_MD, "utf8");
    }
    const hooks = installHooks(root, agentDirFor(root));
    const merge = installMergeDriver(root);
    process.stdout.write(
      `Initialised "${project.name}" in ${root}/${findProject(root)?.storeDir}\n` +
        `Wrote ${relative(root, skill)} so your agent can use it directly.\n` +
        (merge === "added"
          ? `Registered a merge driver for .project, so two people's boards merge.\n`
          : "") +
        (hooks === "added"
          ? `Hooked ${agentDirFor(root)}/settings.json so agent runs record themselves.\n`
          : hooks === "skipped"
            ? `Left ${agentDirFor(root)}/settings.json alone -- it is not valid JSON. Add the ingest hook by hand to track runs.\n`
            : "") +
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

    if (sub === "rm" || sub === "delete") {
      const id = rest[0] ?? die("Usage: project-companion diagram rm <id>");
      if (!deleteDiagram(root, id)) die(`No diagram "${id}"`);
      process.stdout.write(`Deleted ${id}\n`);
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

  /* ------------------------------- components ------------------------------- */

  if (command === "component") {
    const components = readComponents(root);

    if (sub === "add") {
      const title = rest[0] ?? die("Usage: project-companion component add <title>");
      const lifecycle = flag("lifecycle");
      if (lifecycle && !COMPONENT_LIFECYCLES.includes(lifecycle as never)) {
        die(`Unknown lifecycle "${lifecycle}" (${COMPONENT_LIFECYCLES.join(" | ")})`);
      }
      const parent = flag("parent");
      if (parent && !components.some((c) => c.id === parent)) {
        // Same rule as `task add --feature`: refuse a dangling link rather than
        // storing one that puts the component nowhere in the tree.
        die(`No component "${parent}". Run \`project-companion component list\`.`);
      }

      const component = createComponent(root, {
        title,
        owner: flag("owner"),
        paths: splitList(flag("paths")),
        parentId: parent,
        nodeId: flag("node"),
        diagramId: flag("diagram"),
        drilldownDiagramId: flag("drilldown"),
        lifecycle: lifecycle as ComponentLifecycle | undefined,
      });
      process.stdout.write(`Created ${component.id}  ${component.title}\n`);
      if (!component.paths?.length) {
        process.stdout.write(
          `\nNo paths yet, so nothing will attribute here. Add them:\n` +
            `  project-companion component set ${component.id} --paths "lib/${component.id}/**"\n`,
        );
      }
      return;
    }

    if (sub === "set") {
      const id = rest[0] ?? die("Usage: project-companion component set <id> [--owner W] [--paths P]");
      const lifecycle = flag("lifecycle");
      if (lifecycle && !COMPONENT_LIFECYCLES.includes(lifecycle as never)) {
        die(`Unknown lifecycle "${lifecycle}" (${COMPONENT_LIFECYCLES.join(" | ")})`);
      }
      const paths = splitList(flag("paths"));
      const updated =
        updateComponent(root, id, {
          ...(flag("owner") ? { owner: flag("owner") } : {}),
          ...(paths ? { paths } : {}),
          ...(flag("parent") ? { parentId: flag("parent") } : {}),
          ...(flag("drilldown") ? { drilldownDiagramId: flag("drilldown") } : {}),
          ...(lifecycle ? { lifecycle: lifecycle as ComponentLifecycle } : {}),
        }) ?? die(`No component "${id}"`);
      process.stdout.write(
        `${updated.id}  ${updated.lifecycle}  ${updated.owner ?? "(unowned)"}  ${(updated.paths ?? []).join(", ")}\n`,
      );
      return;
    }

    if (sub === "rm" || sub === "delete") {
      const id = rest[0] ?? die("Usage: project-companion component rm <id>");
      if (!deleteComponent(root, id)) die(`No component "${id}"`);
      process.stdout.write(`Deleted ${id}  (children were promoted, not deleted)\n`);
      return;
    }

    if (sub === "show") {
      const id = rest[0] ?? die("Usage: project-companion component show <id>");
      const component = readComponent(root, id) ?? die(`No component "${id}"`);
      const family = withDescendants(id, components);
      const tasks = readTasks(root).tasks.filter((t) => family.includes(t.componentId ?? ""));
      const trail = ancestorsOf(id, components).map((c) => c.id);

      const lines = [
        `${component.title}  [${component.lifecycle}]  id=${component.id}`,
        trail.length ? `path:  ${[...trail, component.id].join(" / ")}` : "",
        `owner: ${component.owner ?? "(unowned)"}`,
        `paths: ${(component.paths ?? []).join(", ") || "(none declared)"}`,
        component.orphaned ? "orphaned: the canvas node is gone" : "",
        "",
      ].filter((l) => l !== "");

      const children = components.filter((c) => c.parentId === id);
      if (children.length) {
        lines.push("children:");
        for (const c of children) lines.push(`  ${c.id.padEnd(24)} ${c.title}`);
        lines.push("");
      }

      if (tasks.length) {
        lines.push(`tasks (${tasks.length}, including children):`);
        for (const t of tasks) {
          lines.push(`  ${t.id}  ${fmtStatus(t.status).padEnd(12)} ${t.title}`);
        }
      } else {
        lines.push("No tasks on this component yet.");
      }

      process.stdout.write(`${lines.join("\n")}\n`);
      return;
    }

    if (sub === "doctor") {
      const warnings = catalogWarnings(components);
      if (!warnings.length) {
        process.stdout.write(
          components.length
            ? `${components.length} components, nothing wrong.\n`
            : "No components yet. `project-companion component add <title>`\n",
        );
        return;
      }
      for (const w of warnings) {
        process.stdout.write(`${w.componentId.padEnd(24)} ${w.kind.padEnd(17)} ${w.detail}\n`);
      }
      process.stdout.write(
        `\n${warnings.length} problems. A component with no paths attributes nothing, ` +
          `and two claiming the same paths attribute nothing either.\n`,
      );
      return;
    }

    if (!components.length) {
      process.stdout.write("No components yet. `project-companion component add <title>`\n");
      return;
    }

    // Listed as the tree, because containment is how the architecture reads.
    const render = (nodes: ComponentNode[], depth: number) => {
      for (const node of nodes) {
        const indent = "  ".repeat(depth);
        const owner = node.owner ?? "(unowned)";
        process.stdout.write(
          `${(indent + node.id).padEnd(30)} ${owner.padEnd(22)} ${(node.paths ?? []).join(", ")}\n`,
        );
        render(node.children, depth + 1);
      }
    };
    render(componentTree(components), 0);
    return;
  }

  if (command === "whose") {
    const path = sub ?? die("Usage: project-companion whose <path>");
    const owner = resolveComponent(path, readComponents(root));
    if (!owner) {
      process.stdout.write(
        `${path} belongs to no component.\n` +
          `Either nothing claims it, or two things claim it equally -- ` +
          `\`project-companion component doctor\` says which.\n`,
      );
      return;
    }
    const component = readComponent(root, owner.componentId)!;
    process.stdout.write(
      `${owner.componentId}  ${component.owner ?? "(unowned)"}\n  matched ${owner.glob}\n`,
    );
    return;
  }

  if (command === "log") {
    const limit = Number(flag("limit")) || 40;
    const component = flag("component");
    const events = readEvents(root)
      .filter((e) => e.kind !== "actor.identified")
      .filter((e) => !component || e.componentId === component)
      .slice(-limit);

    if (!events.length) {
      process.stdout.write("Nothing logged yet.\n");
      return;
    }

    // Actor ids are hashes; the log states each one's identity in its own first
    // event, so resolve them back to something a person recognises.
    const names = new Map<string, string>();
    for (const e of readEvents(root)) {
      if (e.kind === "actor.identified") names.set(e.actor, String(e.data.name ?? e.actor));
    }

    for (const e of events) {
      const when = new Date(e.ts).toISOString().replace("T", " ").slice(0, 19);
      const who = (names.get(e.actor) ?? e.actor).slice(0, 14);
      const scope = e.componentId ? `[${e.componentId}] ` : "";
      process.stdout.write(
        `${when}  ${who.padEnd(14)} ${e.kind.padEnd(20)} ${scope}${summarise(e.data)}\n`,
      );
    }
    return;
  }

  /* ---------------------------------- runs ---------------------------------- */

  if (command === "run") {
    if (sub === "start") {
      const taskId = rest[0];
      if (taskId && !readTasks(root).tasks.some((t) => t.id === taskId)) {
        die(`No task "${taskId}".`);
      }
      requireWipRoom(root);
      const run = startRun(root, {
        taskId,
        componentId: flag("component"),
        sessionId: flag("session"),
        actor: { model: flag("model"), harness: flag("harness") },
      });

      const policy = [
        run.componentId ? `component ${run.componentId}` : "no component",
        `autonomy ${run.autonomy}`,
        run.budget.tokens ? `${run.budget.tokens} tokens` : "no token ceiling",
      ].join("  ");

      process.stdout.write(
        `Run ${run.id}  ${policy}\n` +
          (run.writeGlobs?.length
            ? `May write: ${run.writeGlobs.join(", ")}\n`
            : `May write: anywhere (this run is not scoped to a component)\n`),
      );
      return;
    }

    if (sub === "show") {
      const id = rest[0] ?? die("Usage: project-companion run show <id>");
      const run = readRun(root, id) ?? die(`No run "${id}"`);
      const spent = run.spent;
      process.stdout.write(
        [
          `${run.id}  ${run.state}${run.reason ? `  (${run.reason})` : ""}`,
          `actor:    ${run.actor.model ?? "?"}${run.actor.harness ? ` via ${run.actor.harness}` : ""}`,
          run.componentId ? `component: ${run.componentId}` : "",
          run.taskId ? `task:     ${run.taskId}` : "",
          `spent:    ${spent.inputTokens + spent.outputTokens} tokens, ${spent.toolCalls} tool calls, ${Math.round(spent.wallClockMs / 1000)}s`,
          `boundary: ${run.writeGlobs?.join(", ") || "anywhere"}`,
          run.touched.length ? `touched:\n${run.touched.map((f) => `  ${f}`).join("\n")}` : "touched: nothing yet",
        ].filter(Boolean).join("\n") + "\n",
      );
      return;
    }

    if (sub && (RUN_STATES as readonly string[]).includes(sub)) {
      const id = rest[0] ?? die(`Usage: project-companion run ${sub} <id>`);
      try {
        const run = setRunState(root, id, sub as RunState, rest.slice(1).join(" ") || undefined);
        if (!run) die(`No run "${id}"`);
        process.stdout.write(`${id} -> ${run!.state}\n`);
      } catch (error) {
        die(error instanceof Error ? error.message : String(error));
      }
      return;
    }

    // `run list`, and the default.
    const runs = readRuns(root).filter(
      (r) => has("all") || (r.state !== "merged" && r.state !== "abandoned"),
    );
    if (!runs.length) {
      process.stdout.write(
        has("all") ? "No runs yet.\n" : "Nothing in flight. `project-companion run list --all` for finished ones.\n",
      );
      return;
    }
    for (const r of runs) {
      const tokens = r.spent.inputTokens + r.spent.outputTokens;
      process.stdout.write(
        `${r.id}  ${r.state.padEnd(16)} ${(r.componentId ?? "-").padEnd(18)} ` +
          `${String(tokens).padStart(7)} tok  ${String(r.touched.length).padStart(3)} files  ${r.actor.model ?? ""}\n`,
      );
    }
    return;
  }

  /**
   * A harness hook, on stdin.
   *
   * Silent on anything it does not recognise, and never non-zero: this runs
   * inside somebody's coding session, and a tracking tool that can break the
   * session it is tracking will be removed from the settings within a day.
   */
  if (command === "ingest") {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (raw += chunk));
    process.stdin.on("end", () => {
      try {
        const event = parseHook(JSON.parse(raw));
        if (event.kind === "unknown") return;

        if (event.kind === "session.start") {
          if (runForSession(root, event.sessionId)) return; // A resume, not a new run.
          startRun(root, {
            sessionId: event.sessionId,
            actor: { model: event.model, harness: event.harness },
          });
          return;
        }

        const run = runForSession(root, event.sessionId);
        if (!run) return;

        if (event.kind === "tool.use") {
          const result = reportRun(root, run.id, {
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            toolCalls: 1,
            touched: event.touched,
          });
          // The one thing worth interrupting for: the agent is about to keep
          // going past a ceiling somebody set, or outside a boundary.
          if (result && !result.verdict.ok) {
            process.stderr.write(
              `project-companion: run ${run.id} is over budget (${result.verdict.detail}) and is now blocked.\n`,
            );
          }
          if (result?.refused.length) {
            process.stderr.write(
              `project-companion: ${result.refused.join(", ")} is outside ${run.componentId ?? "this run"}'s boundary.\n`,
            );
          }
          return;
        }

        if (event.kind === "session.end" && run.state === "running") {
          setRunState(root, run.id, "awaiting_review", event.reason);
        }
      } catch {
        // See above: a hook must not fail the session it is observing.
      }
    });
    return;
  }

  if (command === "task") {
    if (sub === "list") {
      const status = flag("status");
      if (status && !isTaskStatus(status)) {
        die(`Unknown status "${status}" (${TASK_STATUSES.join(" | ")})`);
      }
      const feature = flag("feature");
      // A component's board includes its children's, because that is what
      // "everything happening inside this part of the system" means.
      const scope = flag("component")
        ? withDescendants(flag("component")!, readComponents(root))
        : undefined;
      const tasks = readTasks(root).tasks.filter(
        (t) =>
          (!status || t.status === status) &&
          (!feature || t.featureId === feature) &&
          (!scope || scope.includes(t.componentId ?? "")),
      );
      if (!tasks.length) {
        process.stdout.write("No tasks.\n");
        return;
      }
      for (const t of tasks) {
        const nodes = t.nodeIds?.length ? `  -> ${t.nodeIds.join(",")}` : "";
        const linked = t.featureId ? `  [${t.featureId}]` : "";
        const owner = t.componentId ? `  @${t.componentId}` : "";
        process.stdout.write(
          `${t.id}  ${t.status.padEnd(12)} ${t.title}${owner}${linked}${nodes}\n`,
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
      const component = flag("component");
      if (component && !readComponent(root, component)) {
        die(`No component "${component}". Run \`project-companion component list\`.`);
      }
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
        componentId: component,
        diagramId: flag("diagram"),
        featureId: feature,
        phaseId: flag("phase"),
      });
      process.stdout.write(`Created ${task.id}  [${task.status}]  ${task.title}\n`);
      return;
    }

    if (sub === "start" || sub === "done") {
      const id = rest[0] ?? die(`Usage: project-companion task ${sub} <id>`);
      if (sub === "start") requireWipRoom(root);
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

    if (command === "wip") {
    if (!sub) {
      const limits = readBundleWip(root);
      const set = Object.entries(limits);
      process.stdout.write(
        set.length
          ? set.map(([status, n]) => `${fmtStatus(status).padEnd(14)} ${n}\n`).join("")
          : "No limits set. `project-companion wip review 3` caps how much can wait on a person.\n",
      );
      return;
    }
    if (!isTaskStatus(sub)) return die(`Unknown status "${sub}" (${TASK_STATUSES.join(" | ")})`);
    const raw = rest[0];
    const limit = raw === undefined || raw === "none" ? null : Number(raw);
    if (limit !== null && (!Number.isFinite(limit) || limit < 0)) die(`"${raw}" is not a limit.`);
    setWipLimit(root, sub, limit);
    process.stdout.write(
      limit === null ? `${fmtStatus(sub)} is no longer limited\n` : `${fmtStatus(sub)} limited to ${limit}\n`,
    );
    return;
  }

  if (command === "flow" || command === "next") {
    const tasks = readTasks(root).tasks;
    const flows = taskFlow(readEvents(root), tasks);

    if (!flows.length) {
      process.stdout.write(
        "Nothing to measure yet. The log records a task's journey from the moment it is created.\n",
      );
      return;
    }

    if (command === "next") {
      // Fan-in from the dependency graph: how many components import this one.
      const components = readComponents(root);
      const fanIn: Record<string, number> = {};
      for (const edge of dependencyGraph(root, components)) {
        fanIn[edge.to] = (fanIn[edge.to] ?? 0) + 1;
      }
      const componentOf = Object.fromEntries(
        tasks.filter((t) => t.componentId).map((t) => [t.id, t.componentId!]),
      );
      const titles = new Map(tasks.map((t) => [t.id, t.title]));

      const ranked = attention(flows, { fanIn, componentOf }).slice(0, 10);
      if (!ranked.length) {
        process.stdout.write("Nothing waiting. Everything is either done or not started.\n");
        return;
      }
      for (const item of ranked) {
        process.stdout.write(
          `${item.taskId}  ${(titles.get(item.taskId) ?? "").slice(0, 46).padEnd(46)} ${item.why.join("; ")}\n`,
        );
      }
      return;
    }

    const summary = summariseFlow(flows);
    process.stdout.write(
      `${summary.inFlight} in flight, ${summary.finished} finished` +
        (summary.cycleMs ? `, median ${asDays(summary.cycleMs)} to done` : "") +
        (summary.reworked ? `, ${summary.reworked} sent back from review` : "") +
        "\n\n",
    );
    for (const queue of summary.queues) {
      process.stdout.write(
        `${fmtStatus(queue.status).padEnd(14)} ${String(queue.count).padStart(3)}  ` +
          `oldest ${asDays(queue.oldestMs).padStart(5)}  median ${asDays(queue.medianAgeMs)}\n`,
      );
    }
    process.stdout.write("\nThe oldest thing in a queue says more than the average; the average hides it.\n");
    return;
  }

  if (command === "review") {
    void (async () => {
      const repo = await gitRoot(root);
      if (!repo) die("Not inside a git repository.");

      const ref = sub ?? "HEAD";
      const [commit] = await readCommits(repo!, { ref: ref === "HEAD" ? undefined : ref, limit: 1 });
      if (!commit) die(`No commit "${ref}".`);

      const components = readComponents(root);
      const routed = route(commit, components);
      const roadmap = readRoadmap(root);
      const touched = new Set(routed.map((f) => f.componentId).filter(Boolean) as string[]);

      // Only the spec the touched components are responsible for. A reviewer
      // given the whole PRD reads none of it.
      const spec: PacketInput["spec"] = [];
      for (const componentId of Array.from(touched)) {
        const context = await componentContext(root, { componentId, includeEvidence: false });
        for (const feature of context.spec) {
          spec.push({
            componentId,
            featureId: feature.id,
            title: feature.title,
            criteria: feature.criteria.map((c) => ({ text: c.text, done: c.done })),
          });
        }
      }

      const checks = roadmap.features
        .filter((f) => f.verify && spec.some((s) => s.featureId === f.id))
        .map((f) => ({ featureId: f.id, ok: true, command: f.verify! }));

      // Only crossings THIS change is part of. Filtering by component instead
      // lists every boundary the two touched components have ever crossed --
      // fourteen of them on a commit that crossed none, which buries the
      // finding that matters under a standing report of the codebase.
      const changed = new Set(routed.map((f) => f.path));
      const crossings = drift(declaredEdges(root), dependencyGraph(root, components))
        .undeclared.filter((e) => e.examples.some((x) => changed.has(x.from) || changed.has(x.to)))
        .map((e) => ({ from: e.from, to: e.to }));

      const text = packet({ commit, routed, components, spec, checks, drift: crossings });
      const dir = join(root, ".project-cache", "review", commit.short);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "packet.md"), text, "utf8");

      const hunks = await readDiffHunks(repo!, commit.sha);
      writeFileSync(join(dir, "hunks.json"), JSON.stringify(hunks), "utf8");

      const logic = routed.filter((f) => f.kind === "logic").length;
      process.stdout.write(
        `${relative(root, join(dir, "packet.md"))}\n\n` +
          `${logic} of ${routed.length} files need reading, across ${touched.size || "no"} component${touched.size === 1 ? "" : "s"}.\n` +
          `Hand the packet to your agent; findings come back through report_findings.\n`,
      );
    })();
    return;
  }

  if (command === "drift") {
    const components = readComponents(root);
    if (components.length < 2) {
      process.stdout.write("Drift needs at least two components with paths.\n");
      return;
    }

    const actual = dependencyGraph(root, components);
    const result = drift(declaredEdges(root), actual);

    if (result.undeclared.length) {
      process.stdout.write(`${result.undeclared.length} undeclared dependencies:\n\n`);
      for (const edge of result.undeclared) {
        process.stdout.write(`  ${edge.from} -> ${edge.to}  (${edge.count} imports)\n`);
        for (const example of edge.examples) {
          process.stdout.write(`      ${example.from} imports ${example.to}\n`);
        }
      }
      process.stdout.write("\nEither the canvas is missing an edge, or the code should not cross there.\n");
    } else {
      process.stdout.write("No undeclared dependencies. The canvas covers what the code does.\n");
    }

    if (result.unverifiable.length) {
      process.stdout.write(
        `\n${result.unverifiable.length} declared relations no import backs:\n` +
          result.unverifiable.map((e) => `  ${e.from} -> ${e.to}`).join("\n") +
          `\n\nNot necessarily wrong -- an import graph cannot see an HTTP call or a queue.\n`,
      );
    }
    return;
  }

  if (command === "verify") {
    const roadmap = readRoadmap(root);
    if (!roadmap.present) die(`No PRD at ${roadmap.source}.`);

    const targets = roadmap.features.filter(
      (f) => f.verify && (!sub || f.id === sub),
    );
    if (!targets.length) {
      process.stdout.write(
        sub
          ? `"${sub}" declares no Verify: command.\n`
          : "No feature declares a Verify: command.\n\n" +
            "Add one under a feature in the PRD:\n  Verify: npm test -- auth\n",
      );
      return;
    }

    void (async () => {
      let failed = 0;
      for (const feature of targets) {
        const result = await runCheck(root, feature.id, feature.verify!);
        process.stdout.write(
          `${result.ok ? "ok  " : "FAIL"} ${feature.id.padEnd(26)} ${result.command}  (${Math.round(result.ms / 1000)}s)\n`,
        );

        if (!result.ok) {
          failed++;
          process.stdout.write(`${result.output.split("\n").map((l) => `       ${l}`).join("\n")}\n`);

          // The consequence, and the whole point: a claim the repository just
          // refused cannot stay standing.
          const untick = feature.acceptance.filter((c) => c.done);
          if (untick.length) {
            editPrd(root, undefined, untick.map((c) => ({
              op: "setCriterion" as const,
              featureId: feature.id,
              criterionId: c.id,
              done: false,
            })));
            process.stdout.write(
              `       unticked ${untick.length} criteri${untick.length === 1 ? "on" : "a"} -- the check does not pass\n`,
            );
          }
        }
        recordVerification(root, feature.id, result);
      }
      process.stdout.write(`\n${targets.length - failed}/${targets.length} verified\n`);
      if (failed) process.exit(1);
    })();
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

  if (command === "migrate") {
    const result = migrateProject(root);
    if (!result) {
      process.stdout.write("Already a single .project file; nothing to migrate.\n");
      return;
    }
    process.stdout.write(
      `Migrated to .project\n  ${result.diagrams} diagrams, ${result.boards} whiteboards, ${result.tasks} tasks\n` +
        `Removed ${result.removed}\n`,
    );
    return;
  }

  if (command === "reindex") {
    process.stdout.write(`Reindexed ${reindexDiagrams(root)} diagrams\n`);
    return;
  }

  die(HELP);
};

main();
