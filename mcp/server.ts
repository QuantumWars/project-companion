/**
 * MCP server for Claude Code.
 *
 * Exposes the project's diagrams and tasks as structured tools so an agent can
 * read the architecture for context, keep it in step with the code it writes,
 * and move Kanban cards as it finishes work.
 *
 * It shares `lib/project/store` with the CLI, so there is exactly one
 * implementation of the on-disk format and no chance of the two drifting.
 *
 * Claude Code starts this as a stdio subprocess and sets `CLAUDE_PROJECT_DIR`
 * to the repo root, which is what `findProjectRoot` prefers over the cwd.
 */

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

import {
  addEdge,
  addNode,
  createDiagram,
  createTask,
  findProjectRoot,
  listDiagrams,
  moveTask,
  readComponent,
  readComponents,
  readDiagram,
  readProject,
  readTasks,
  recordCommits,
  removeNode,
  tasksForFeature,
  readRun,
  readRuns,
  recordFindings,
  reportRun,
  setRunState,
  startRun,
  trackNode,
  updateComponent,
  updateTask,
  writeDiagram,
} from "../lib/project/store";
import {
  componentTree,
  resolveComponent,
  COMPONENT_LIFECYCLES,
  type ComponentNode,
} from "../lib/project/component";
import { componentContext } from "../lib/project/component-context";
import { RUN_STATES } from "../lib/project/run";
import { ground, type Finding } from "../lib/project/review";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { editPrd, readRoadmap } from "../lib/project/roadmap";
import { gitRoot, readStatus } from "../lib/project/git";
import { linkRepository } from "../lib/project/git-link";
import { branchNameFor } from "../lib/project/git-write";
import { TASK_STATUSES } from "../lib/project/types";
import { parsePrismaSchema } from "../lib/arch/import/prisma";
import { parseSqlDdl } from "../lib/arch/import/sql-ddl";
import { getTech } from "../lib/arch/tech-catalog";
import { GEOMETRY_BY_ID, type GeometryId } from "../lib/arch/shapes";
import type { ArchEdge, ArchNode, C4Element, DiagramType } from "../types/arch";

/** Kept in step with `C4Element`; zod needs the values, not just the type. */
const C4_ELEMENTS = ["person", "system", "container", "component", "external"] as const;

const DIAGRAM_TYPES = [
  "architecture", "flowchart", "erd", "bpmn", "dfd", "uml",
  "network", "sitemap", "orgchart", "block", "venn", "mindmap",
] as const;

/** Every tool needs the project; failing loudly beats writing to the wrong tree. */
const requireRoot = (): string => {
  const root = findProjectRoot();
  if (!root) {
    throw new Error(
      "No project found. Run `npx project-companion init` at the project root first.",
    );
  }
  return root;
};

const text = (value: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ],
});

/**
 * Turns the agent's intent into a node.
 *
 * The agent should not have to know React Flow's internals, so it names a
 * technology or a shape and this picks the right node type.
 */
const makeNode = (input: {
  label: string;
  tech?: string;
  shape?: string;
  c4?: C4Element;
  note?: boolean;
  technology?: string;
  description?: string;
  drilldownDiagramId?: string;
  x?: number;
  y?: number;
}): ArchNode => {
  const position = { x: input.x ?? 0, y: input.y ?? 0 };

  if (input.note) {
    return {
      id: randomUUID().slice(0, 8),
      type: "note",
      position,
      data: { kind: "note", label: input.label },
    };
  }

  if (input.c4) {
    return {
      id: randomUUID().slice(0, 8),
      type: "c4",
      position,
      data: {
        kind: "c4",
        label: input.label,
        element: input.c4,
        technology: input.technology,
        description: input.description,
        drilldownDiagramId: input.drilldownDiagramId,
      },
    };
  }

  if (input.shape && GEOMETRY_BY_ID.has(input.shape as GeometryId)) {
    const geometry = GEOMETRY_BY_ID.get(input.shape as GeometryId)!;
    return {
      id: randomUUID().slice(0, 8),
      type: "shape",
      position,
      width: geometry.defaultSize.w,
      height: geometry.defaultSize.h,
      data: {
        kind: "shape",
        label: input.label,
        geometry: geometry.id,
        translucent: geometry.translucent,
      },
    };
  }

  return {
    id: randomUUID().slice(0, 8),
    type: "service",
    position,
    data: {
      kind: "service",
      label: input.label,
      // An unknown tech id is dropped rather than stored, so the node still
      // renders with a generic glyph instead of a broken icon reference.
      tech: input.tech && getTech(input.tech) ? input.tech : undefined,
      drilldownDiagramId: input.drilldownDiagramId,
    },
  };
};

const build = () => {
  const server = new McpServer({
    name: "project-companion",
    version: "0.1.0",
  });

  /* ------------------------------- reading ------------------------------- */

  server.registerTool(
    "list_diagrams",
    {
      title: "List diagrams",
      description:
        "List every diagram in this project, with its id, title and diagram type. Call this first to find the id you need.",
      inputSchema: {},
    },
    async () => text(listDiagrams(requireRoot())),
  );

  server.registerTool(
    "get_diagram",
    {
      title: "Get a diagram",
      description:
        "Read one diagram's full contents: nodes (services, shapes, tables, containers) and the edges between them. Use this to understand the system before changing code.",
      inputSchema: { id: z.string().describe("Diagram id from list_diagrams") },
    },
    async ({ id }) => {
      const diagram = readDiagram(requireRoot(), id);
      if (!diagram) throw new Error(`No diagram "${id}"`);
      return text(diagram);
    },
  );

  server.registerTool(
    "describe_project",
    {
      title: "Describe the project",
      description:
        "A compact summary of the whole project: diagram count and task counts by status. Cheap orientation before doing anything else.",
      inputSchema: {},
    },
    async () => {
      const root = requireRoot();
      const project = readProject(root);
      const tasks = readTasks(root).tasks;

      return text({
        name: project.name,
        root,
        diagrams: project.diagrams,
        taskCounts: Object.fromEntries(
          TASK_STATUSES.map((s) => [s, tasks.filter((t) => t.status === s).length]),
        ),
      });
    },
  );

  /* ------------------------------- writing ------------------------------- */

  server.registerTool(
    "create_diagram",
    {
      title: "Create a diagram",
      description: "Create a new empty diagram and return it.",
      inputSchema: {
        title: z.string(),
        type: z.enum(DIAGRAM_TYPES).optional()
          .describe("Defaults to architecture"),
      },
    },
    async ({ title, type }) =>
      text(createDiagram(requireRoot(), title, (type ?? "architecture") as DiagramType)),
  );

  server.registerTool(
    "add_node",
    {
      title: "Add a node",
      description:
        "Add a node to a diagram. Pass `tech` for a technology node (e.g. postgresql, " +
        "redis, nextjs), `shape` for a diagram shape (e.g. rectangle, diamond, cylinder), " +
        "`c4` for a C4 element, or `note` for an annotation. Set `drilldownDiagramId` to " +
        "make the node open another diagram, which is how a context diagram becomes a " +
        "level rather than a picture. Returns the created node id.",
      inputSchema: {
        diagramId: z.string(),
        label: z.string(),
        tech: z.string().optional()
          .describe("Technology id, e.g. postgresql, redis, kafka, nextjs"),
        shape: z.string().optional()
          .describe("Geometry id, e.g. rectangle, rounded, diamond, cylinder, stadium"),
        c4: z.enum(C4_ELEMENTS).optional()
          .describe("Makes this a C4 element at the given level."),
        note: z.boolean().optional().describe("Makes this a plain annotation."),
        technology: z.string().optional()
          .describe("C4 only: the [Container: Go] line under the name."),
        description: z.string().optional().describe("C4 only: one line of body text."),
        drilldownDiagramId: z.string().optional()
          .describe("The diagram this node opens into."),
        x: z.number().optional(),
        y: z.number().optional(),
      },
    },
    async ({ diagramId, label, x, y, ...rest }) => {
      const node = makeNode({ label, x, y, ...rest });
      const diagram = addNode(requireRoot(), diagramId, node);
      if (!diagram) throw new Error(`No diagram "${diagramId}"`);
      return text({ id: node.id, type: node.type, label });
    },
  );

  server.registerTool(
    "connect_nodes",
    {
      title: "Connect two nodes",
      description:
        "Draw an edge between two existing nodes. Use `label` for the protocol or relationship, and `async` for queue/event flows (rendered dashed).",
      inputSchema: {
        diagramId: z.string(),
        source: z.string(),
        target: z.string(),
        label: z.string().optional(),
        async: z.boolean().optional(),
      },
    },
    async ({ diagramId, source, target, label, async: isAsync }) => {
      // Handles are left unset on purpose: the store picks the sides from the
      // two nodes' positions, so the agent never has to think about geometry.
      const edge: ArchEdge = {
        id: `${source}->${target}`,
        source,
        target,
        type: "flow",
        data: { kind: "flow", label, async: isAsync, arrowEnd: true },
      };

      const diagram = addEdge(requireRoot(), diagramId, edge);
      if (!diagram) {
        throw new Error(
          `Could not connect: check that diagram "${diagramId}" exists and both nodes are in it.`,
        );
      }
      return text({ id: edge.id, source, target });
    },
  );

  server.registerTool(
    "remove_node",
    {
      title: "Remove a node",
      description:
        "Delete a node and every edge attached to it. Use when a service is removed from the codebase.",
      inputSchema: { diagramId: z.string(), nodeId: z.string() },
    },
    async ({ diagramId, nodeId }) => {
      const diagram = removeNode(requireRoot(), diagramId, nodeId);
      if (!diagram) throw new Error(`No diagram "${diagramId}"`);
      return text({ removed: nodeId, remaining: diagram.nodes.length });
    },
  );

  server.registerTool(
    "import_schema",
    {
      title: "Import a database schema",
      description:
        "Parse SQL DDL or a Prisma schema into an ER diagram with tables, columns and column-level foreign keys. Pass the schema text itself. Creates a new diagram unless diagramId is given.",
      inputSchema: {
        source: z.string().describe("SQL DDL or Prisma schema text"),
        format: z.enum(["auto", "sql", "prisma"]).optional(),
        title: z.string().optional(),
        diagramId: z.string().optional().describe("Overwrite this diagram instead"),
      },
    },
    async ({ source, format, title, diagramId }) => {
      const root = requireRoot();
      const isPrisma =
        format === "prisma" ||
        (format !== "sql" &&
          /^\s*model\s+\w+\s*\{/m.test(source) &&
          !/create\s+table/i.test(source));

      const parsed = isPrisma ? parsePrismaSchema(source) : parseSqlDdl(source);
      if (!parsed.nodes.length) {
        throw new Error(`Nothing parsed. ${parsed.warnings.join(" ")}`);
      }

      const target = diagramId
        ? readDiagram(root, diagramId)
        : createDiagram(root, title ?? "Database schema", "erd");
      if (!target) throw new Error(`No diagram "${diagramId}"`);

      const saved = writeDiagram(root, {
        ...target,
        nodes: parsed.nodes,
        edges: parsed.edges,
      });

      return text({
        diagramId: saved.id,
        tables: parsed.nodes.length,
        relations: parsed.edges.length,
        warnings: parsed.warnings,
      });
    },
  );

  /* -------------------------------- tasks -------------------------------- */

  server.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description:
        "List the project's tasks, optionally filtered by status. Tasks can reference architecture nodes via nodeIds.",
      inputSchema: { status: z.enum(TASK_STATUSES).optional() },
    },
    async ({ status }) => {
      const tasks = readTasks(requireRoot()).tasks;
      return text(status ? tasks.filter((t) => t.status === status) : tasks);
    },
  );

  server.registerTool(
    "create_task",
    {
      title: "Create a task",
      description:
        "Add a task to the board. Link it to the architecture with nodeIds so the work is visible on the node it touches.",
      inputSchema: {
        title: z.string(),
        description: z.string().optional(),
        status: z.enum(TASK_STATUSES).optional().describe("Defaults to backlog"),
        nodeIds: z.array(z.string()).optional(),
        componentId: z
          .string()
          .optional()
          .describe("The component that owns this work; whose board it appears on."),
        diagramId: z.string().optional(),
        labels: z.array(z.string()).optional(),
      },
    },
    async (input) => text(createTask(requireRoot(), input)),
  );

  /* ------------------------------ components ------------------------------ */

  server.registerTool(
    "list_components",
    {
      title: "List components",
      description:
        "The architecture's components as a tree: what parts the system is made of, " +
        "who owns each, and which source paths it covers. Call this first to orient " +
        "yourself in an unfamiliar repository -- it is the cheapest map there is.",
      inputSchema: {},
    },
    async () => {
      const root = requireRoot();
      const tasks = readTasks(root).tasks;

      const flatten = (nodes: ComponentNode[], depth: number): unknown[] =>
        nodes.flatMap((n) => [
          {
            id: n.id,
            depth,
            title: n.title,
            owner: n.owner ?? null,
            paths: n.paths ?? [],
            open: tasks.filter(
              (t) => t.componentId === n.id && t.status !== "done",
            ).length,
            ...(n.orphaned ? { orphaned: true } : {}),
          },
          ...flatten(n.children, depth + 1),
        ]);

      return text(flatten(componentTree(readComponents(root)), 0));
    },
  );

  server.registerTool(
    "get_component_context",
    {
      title: "Get everything about one component",
      description:
        "Everything you need to work inside one part of the system, in a single call: " +
        "its owner and paths, the PRD features and acceptance criteria it is " +
        "responsible for, its open tasks, the commits that have landed in it, and what " +
        "has happened to it recently. Give a componentId, or a file path to look up " +
        "whichever component owns it. Prefer this over several smaller calls -- the " +
        "gathering happens here, where it costs you no context.",
      inputSchema: {
        componentId: z.string().optional(),
        path: z
          .string()
          .optional()
          .describe("A repo-relative file, resolved to whichever component owns it."),
        includeEvidence: z
          .boolean()
          .optional()
          .describe("Read the repository for commits and churn. Defaults to true."),
      },
    },
    async ({ componentId, path, includeEvidence = true }) => {
      // The same assembly the web app renders, from the same function. Two
      // implementations of "everything about a component" would drift, and the
      // failure would be an agent and a person disagreeing about what is true.
      const context = await componentContext(requireRoot(), {
        componentId,
        path,
        includeEvidence,
      });

      if (!context.found) {
        return text({
          found: false,
          reason: context.reason,
          components: readComponents(requireRoot()).map((c) => ({
            id: c.id,
            paths: c.paths ?? [],
          })),
        });
      }

      const c = context.component!;
      return text({
        found: true,
        component: {
          id: c.id,
          title: c.title,
          owner: c.owner ?? null,
          paths: c.paths ?? [],
          lifecycle: c.lifecycle,
          ...(c.orphaned ? { orphaned: true } : {}),
          ancestors: c.ancestors,
          children: c.children,
        },
        spec: context.spec.map((f) => ({
          id: f.id,
          title: f.title,
          status: f.status,
          criteria: f.criteria.map((x) => ({ text: x.text, done: x.done })),
        })),
        // Open work only, with a count for the rest: a component with two
        // hundred finished tasks should not spend an agent's context listing
        // them.
        tasks: context.tasks
          .filter((t) => t.status !== "done")
          .map((t) => ({ id: t.id, title: t.title, status: t.status })),
        doneCount: context.tasks.filter((t) => t.status === "done").length,
        evidence: context.evidence
          ? {
              commits: context.evidence.commits.slice(0, 12).map((x) => ({
                sha: x.sha,
                subject: x.subject,
                author: x.author,
                signal: x.signal,
              })),
              total: context.evidence.total,
              contributors: context.evidence.contributors,
            }
          : { skipped: true },
        recent: context.recent.slice(0, 8).map((e) => ({
          at: new Date(e.ts).toISOString(),
          kind: e.kind,
          ...e.data,
        })),
        warnings: context.warnings,
      });
    },
  );

  server.registerTool(
    "track_node",
    {
      title: "Make a canvas node a component",
      description:
        "Declare that a node on a diagram is a part of the system somebody owns, giving " +
        "it a board, an owner and a region of the source. Do this when a box on the " +
        "architecture turns out to be real work; leave decorative boxes alone. The " +
        "paths you give are how commits attribute themselves here, so make them accurate.",
      inputSchema: {
        diagramId: z.string(),
        nodeId: z.string(),
        title: z.string().optional().describe("Defaults to the node's label."),
        owner: z.string().optional(),
        paths: z
          .array(z.string())
          .optional()
          .describe('Globs, e.g. ["lib/auth/**"]. `**` crosses directories, `*` does not.'),
        parentId: z.string().optional(),
      },
    },
    async ({ diagramId, nodeId, ...input }) => {
      const tracked = trackNode(requireRoot(), diagramId, nodeId, input);
      if (!tracked) throw new Error(`No node "${nodeId}" on diagram "${diagramId}".`);
      return text(tracked);
    },
  );

  server.registerTool(
    "set_component",
    {
      title: "Update a component",
      description:
        "Change a component's owner, paths, parent or lifecycle. The id never changes -- " +
        "tasks and commits point at it -- so renaming means setting the title.",
      inputSchema: {
        componentId: z.string(),
        title: z.string().optional(),
        owner: z.string().optional(),
        paths: z.array(z.string()).optional(),
        parentId: z.string().optional(),
        lifecycle: z.enum(COMPONENT_LIFECYCLES).optional(),
      },
    },
    async ({ componentId, ...patch }) => {
      const updated = updateComponent(requireRoot(), componentId, patch);
      if (!updated) throw new Error(`No component "${componentId}".`);
      return text(updated);
    },
  );

  server.registerTool(
    "move_task",
    {
      title: "Move a task",
      description:
        "Move a task to another column. Call this as you pick work up and as you finish it, so the board reflects reality.",
      inputSchema: { id: z.string(), status: z.enum(TASK_STATUSES) },
    },
    async ({ id, status }) => {
      const task = moveTask(requireRoot(), id, status);
      if (!task) throw new Error(`No task "${id}"`);
      return text(task);
    },
  );

  server.registerTool(
    "update_task",
    {
      title: "Update a task",
      description: "Change a task's title, description, labels or linked nodes.",
      inputSchema: {
        id: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        nodeIds: z.array(z.string()).optional(),
        labels: z.array(z.string()).optional(),
      },
    },
    async ({ id, ...patch }) => {
      const task = updateTask(requireRoot(), id, patch);
      if (!task) throw new Error(`No task "${id}"`);
      return text(task);
    },
  );

  /* -------------------------------- roadmap ------------------------------- */

  server.registerTool(
    "list_features",
    {
      title: "List features",
      description:
        "Every feature in the PRD, with its phase, derived status and acceptance criteria. This is the feature list the board tracks -- read it before picking up work.",
      inputSchema: {
        phaseId: z.string().optional().describe("Only features in this phase"),
        status: z.enum(TASK_STATUSES).optional(),
      },
    },
    async ({ phaseId, status }) => {
      const roadmap = readRoadmap(requireRoot());
      const features = roadmap.features.filter(
        (f) => (!phaseId || f.phaseId === phaseId) && (!status || f.status === status),
      );
      return text({ source: roadmap.source, phases: roadmap.phases, features });
    },
  );

  server.registerTool(
    "get_feature",
    {
      title: "Get a feature",
      description:
        "One feature with its acceptance criteria, the tasks implementing it, and the commits attributed to it.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const root = requireRoot();
      const feature = readRoadmap(root).features.find((f) => f.id === id);
      if (!feature) throw new Error(`No feature "${id}"`);
      return text({ feature, tasks: tasksForFeature(root, id) });
    },
  );

  server.registerTool(
    "check_criterion",
    {
      title: "Tick an acceptance criterion",
      description:
        "Mark an acceptance criterion done or not done in the PRD. A feature's status is DERIVED from its criteria, so this is how a feature moves to done -- there is no separate status to set. Only the checkbox changes; the rest of the document is untouched.",
      inputSchema: {
        featureId: z.string(),
        criterionId: z.string().describe("Criterion id from get_feature"),
        done: z.boolean(),
      },
    },
    async ({ featureId, criterionId, done }) => {
      const root = requireRoot();
      editPrd(root, undefined, [{ op: "setCriterion", featureId, criterionId, done }]);
      const feature = readRoadmap(root).features.find((f) => f.id === featureId);
      return text({ feature });
    },
  );

  server.registerTool(
    "add_feature",
    {
      title: "Add a feature to the PRD",
      description:
        "Append a feature to docs/prd.md with a stable id marker. Prefer editing the markdown directly for prose; use this when you want the id stamped correctly.",
      inputSchema: {
        title: z.string(),
        phaseId: z.string().optional(),
        summary: z.string().optional(),
      },
    },
    async ({ title, phaseId, summary }) => {
      const root = requireRoot();
      editPrd(root, undefined, [{ op: "addFeature", title, phaseId, summary }]);
      return text(readRoadmap(root).features.find((f) => f.title === title));
    },
  );

  /* ---------------------------------- git --------------------------------- */

  /* --------------------------------- runs --------------------------------- */

  server.registerTool(
    "run_start",
    {
      title: "Open a run",
      description:
        "Declare that you are starting work, so what you do is recorded against the " +
        "right part of the system. Give the task id and the budget, autonomy and path " +
        "boundary come from whichever component owns it -- you do not have to know them. " +
        "Returns what you may write and how much you may spend.",
      inputSchema: {
        taskId: z.string().optional(),
        componentId: z.string().optional().describe("Only when there is no task."),
        model: z.string().optional().describe("The model doing the work, e.g. claude-opus-5."),
        sessionId: z.string().optional().describe("Your harness session, so hooks find this run."),
      },
    },
    async ({ taskId, componentId, model, sessionId }) => {
      const run = startRun(requireRoot(), {
        taskId,
        componentId,
        sessionId,
        actor: { model, harness: "mcp" },
      });
      return text({
        runId: run.id,
        componentId: run.componentId ?? null,
        autonomy: run.autonomy,
        budget: run.budget,
        mayWrite: run.writeGlobs ?? "anywhere",
      });
    },
  );

  server.registerTool(
    "run_report",
    {
      title: "Report progress on a run",
      description:
        "Record what a run has spent and which files it changed, and find out whether it " +
        "may continue. Call this as you work, not at the end: a run that has passed its " +
        "budget is blocked, and a file outside its boundary is refused and reported back " +
        "rather than counted. `ok: false` means stop and tell the person why.",
      inputSchema: {
        runId: z.string(),
        inputTokens: z.number().optional(),
        outputTokens: z.number().optional(),
        toolCalls: z.number().optional(),
        touched: z.array(z.string()).optional().describe("Repo-relative files you wrote."),
      },
    },
    async ({ runId, ...progress }) => {
      const result = reportRun(requireRoot(), runId, progress);
      if (!result) throw new Error(`No run "${runId}".`);
      return text({
        ok: result.verdict.ok,
        state: result.run.state,
        exceeded: result.verdict.exceeded ?? null,
        detail: result.verdict.detail ?? null,
        refused: result.refused,
        spent: result.run.spent,
      });
    },
  );

  server.registerTool(
    "run_finish",
    {
      title: "Move a run along",
      description:
        "Hand a run to review when the work is done, or abandon it. A run cannot go " +
        "straight from running to merged -- merging is a person's decision, and this tool " +
        "will refuse it.",
      inputSchema: {
        runId: z.string(),
        state: z.enum(RUN_STATES),
        reason: z.string().optional(),
      },
    },
    async ({ runId, state, reason }) => {
      const run = setRunState(requireRoot(), runId, state, reason);
      if (!run) throw new Error(`No run "${runId}".`);
      return text({ runId: run.id, state: run.state, spent: run.spent, touched: run.touched });
    },
  );

  server.registerTool(
    "report_findings",
    {
      title: "Report review findings",
      description:
        "Report what you found reviewing a commit. Every finding must anchor to a " +
        "file:line INSIDE the diff -- anything landing on a line the change did not " +
        "touch is dropped before anybody sees it, and the response tells you which and " +
        "why. Run `project-companion review <sha>` first to get the packet and the diff.",
      inputSchema: {
        sha: z.string().describe("The short sha the packet was written for."),
        findings: z.array(
          z.object({
            file: z.string(),
            line: z.number(),
            severity: z.enum(["high", "medium", "low"]),
            title: z.string(),
            detail: z.string(),
          }),
        ),
      },
    },
    async ({ sha, findings }) => {
      const root = requireRoot();
      const dir = join(root, ".project-cache", "review", sha);

      let hunks;
      try {
        hunks = JSON.parse(readFileSync(join(dir, "hunks.json"), "utf8"));
      } catch {
        throw new Error(
          `No review prepared for ${sha}. Run \`project-companion review ${sha}\` first.`,
        );
      }

      // The one step that needs no model: a finding on code this change did not
      // touch is not a finding about this change.
      const result = ground(findings as Finding[], hunks);

      // Only what survived is recorded. A dropped finding never existed as far
      // as the project is concerned, which is what makes this a floor rather
      // than a filter somebody can turn off.
      const components = readComponents(root);
      recordFindings(root, sha, result.kept, (file) => resolveComponent(file, components)?.componentId);

      return text({
        kept: result.kept,
        dropped: result.dropped.map((d) => ({
          file: d.finding.file,
          line: d.finding.line,
          title: d.finding.title,
          reason: d.reason,
        })),
        summary:
          result.dropped.length === 0
            ? `All ${result.kept.length} findings are grounded in the diff.`
            : `${result.kept.length} kept, ${result.dropped.length} dropped for landing outside the change.`,
      });
    },
  );

  server.registerTool(
    "git_status",
    {
      title: "Repository status",
      description:
        "Current branch, ahead/behind counts and how many files are uncommitted.",
      inputSchema: {},
    },
    async () => {
      const repo = await gitRoot(requireRoot());
      if (!repo) return text({ available: false, reason: "Not inside a git repository." });
      return text({ available: true, ...(await readStatus(repo)) });
    },
  );

  server.registerTool(
    "git_log",
    {
      title: "Recent commits and what they are linked to",
      description:
        "Recent commits, each with the task or feature it is attributed to and which signal produced the link (recorded sha, message trailer, branch name, or path overlap). Use this to see what has actually been built rather than what the board claims.",
      inputSchema: {
        limit: z.number().optional(),
        unlinkedOnly: z.boolean().optional().describe("Only commits with no link"),
      },
    },
    async ({ limit, unlinkedOnly }) => {
      const root = requireRoot();
      const repo = await gitRoot(root);
      if (!repo) return text({ available: false, reason: "Not inside a git repository." });

      const result = await linkRepository(
        repo,
        readTasks(root).tasks,
        readRoadmap(root).features,
        limit ?? 50,
      );
      return text(unlinkedOnly ? result.unattributed : result.commits);
    },
  );

  server.registerTool(
    "start_task",
    {
      title: "Start a task",
      description:
        "Move a task to in_progress and get the branch name to use for it. This does NOT create the branch: creating one changes the user's repository, so you run `git checkout -b <branch>` yourself, where the user's own tooling governs it. Commit with the returned trailer and the work links itself to this task.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const root = requireRoot();
      const task = readTasks(root).tasks.find((t) => t.id === id);
      if (!task) throw new Error(`No task "${id}"`);

      moveTask(root, id, "in_progress");
      const branch = branchNameFor(task.id, task.title);
      return text({
        task: { ...task, status: "in_progress" },
        branch,
        checkout: `git checkout -b ${branch}`,
        trailer: `project-companion: ${task.id}`,
      });
    },
  );

  server.registerTool(
    "record_commits",
    {
      title: "Record commits against a task",
      description:
        "Attach commit shas to a task explicitly. This is the strongest attribution signal and survives a branch being deleted. Use it when you commit without the trailer.",
      inputSchema: { id: z.string(), shas: z.array(z.string()) },
    },
    async ({ id, shas }) => {
      const task = recordCommits(requireRoot(), id, shas);
      if (!task) throw new Error(`No task "${id}"`);
      return text(task);
    },
  );

  return server;
};

serveStdio(() => build(), {
  onerror: (error) => process.stderr.write(`project-companion mcp: ${error.message}\n`),
});
