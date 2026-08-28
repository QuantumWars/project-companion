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
  readDiagram,
  readProject,
  readTasks,
  recordCommits,
  removeNode,
  tasksForFeature,
  updateTask,
  writeDiagram,
} from "../lib/project/store";
import { editPrd, readRoadmap } from "../lib/project/roadmap";
import { gitRoot, readStatus } from "../lib/project/git";
import { linkRepository } from "../lib/project/git-link";
import { branchNameFor } from "../lib/project/git-write";
import { TASK_STATUSES } from "../lib/project/types";
import { parsePrismaSchema } from "../lib/arch/import/prisma";
import { parseSqlDdl } from "../lib/arch/import/sql-ddl";
import { getTech } from "../lib/arch/tech-catalog";
import { GEOMETRY_BY_ID, type GeometryId } from "../lib/arch/shapes";
import type { ArchEdge, ArchNode, DiagramType } from "../types/arch";

const DIAGRAM_TYPES = [
  "architecture", "flowchart", "erd", "bpmn", "dfd", "uml",
  "network", "sitemap", "orgchart", "block", "venn", "mindmap",
] as const;

/** Every tool needs the project; failing loudly beats writing to the wrong tree. */
const requireRoot = (): string => {
  const root = findProjectRoot();
  if (!root) {
    throw new Error(
      "No .arch/ directory found. Run `npx archboard init` at the project root first.",
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
  x?: number;
  y?: number;
}): ArchNode => {
  const position = { x: input.x ?? 0, y: input.y ?? 0 };

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
    },
  };
};

const build = () => {
  const server = new McpServer({
    name: "archboard",
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
        "Add a node to a diagram. Pass `tech` for a technology node (e.g. postgresql, redis, nextjs) or `shape` for a diagram shape (e.g. rectangle, diamond, cylinder). Returns the created node id.",
      inputSchema: {
        diagramId: z.string(),
        label: z.string(),
        tech: z.string().optional()
          .describe("Technology id, e.g. postgresql, redis, kafka, nextjs"),
        shape: z.string().optional()
          .describe("Geometry id, e.g. rectangle, rounded, diamond, cylinder, stadium"),
        x: z.number().optional(),
        y: z.number().optional(),
      },
    },
    async ({ diagramId, label, tech, shape, x, y }) => {
      const node = makeNode({ label, tech, shape, x, y });
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
        diagramId: z.string().optional(),
        labels: z.array(z.string()).optional(),
      },
    },
    async (input) => text(createTask(requireRoot(), input)),
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
        trailer: `archboard: ${task.id}`,
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
  onerror: (error) => process.stderr.write(`archboard mcp: ${error.message}\n`),
});
