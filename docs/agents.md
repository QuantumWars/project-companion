# Using the board from a coding agent

The project's diagrams and tasks live as plain JSON **inside the coding agent's
own project directory**, committed to the repository. That is deliberate on two
counts: a coding agent runs on the filesystem, so state kept in browser
localStorage would be invisible to it; and putting the data where the agent
already looks means it is found without configuration.

```
.claude/archboard/project.json          name, version, diagram index
.claude/archboard/diagrams/<id>.json    one diagram each
.claude/archboard/boards/<id>.json      one whiteboard each
.claude/archboard/tasks.json            the Kanban board
.claude/skills/archboard/SKILL.md       teaches the agent the commands
```

Discovery order is `.claude/` → `.codex/` → `.cursor/` → `.gemini/` → `.arch/`
(legacy). `init` puts the store in whichever agent directory the repo already
has, and there is exactly **one** store per project — a repo with two agent
directories must not end up with two divergent copies of its architecture. Move
an existing store with `archboard move .codex/archboard`.

Because the format is JSON in the repo, changes show up in `git diff` and in
code review like any other source change.

## Finding projects

Project data is portable because it lives in the repository, but that leaves
nothing to answer "what projects exist on this machine?". A global index does:

```
~/.claude/archboard/index.json
```

It records each project's path, name and counts, refreshed whenever a project
is touched. It is a cache, never the truth — every read prunes entries whose
store has since disappeared, so a deleted or moved repository falls out on its
own.

```bash
npx archboard projects              # every project on this machine
npx archboard projects forget <path>
```

The index is also an **allowlist**. Every page and API route accepts
`?root=<path>` to open a project the app is not running inside — so
`/project/tasks?root=/path/to/other-repo` shows that project's board, and
`/project/<id>?root=…` opens its diagrams — but only for paths that appear in
the index. Otherwise a crafted query string would be a way to read any
directory the server process can reach. Paths are canonicalised, so a
symlinked checkout resolves to the same entry rather than registering twice.

## The skill (no configuration)

`archboard init` writes `SKILL.md` into the agent's `skills/` directory, so the
agent learns the tool from the repository itself. This is the lowest-friction
path and works for Claude Code, Codex, Cursor and Gemini CLI alike — the agent
reads the store straight off disk and calls the CLI.

## Claude Code (MCP)

`.mcp.json` is committed at the repo root, so Claude Code discovers the server
automatically and prompts once to approve it.

```bash
npm run build:tools     # produces dist/archboard-mcp.mjs
claude                  # approve "archboard" when prompted
```

Claude Code starts the server as a stdio subprocess and sets
`CLAUDE_PROJECT_DIR` to the repo root, which is how the server locates `.arch/`
regardless of its own working directory.

Tools exposed:

| Tool | Purpose |
|---|---|
| `describe_project` | Diagram list and task counts. Cheap orientation. |
| `list_diagrams` / `get_diagram` | Read the architecture before changing code. |
| `create_diagram` | Start a new diagram. |
| `add_node` | Add a node by `tech` (postgresql, redis, nextjs…) or `shape` (diamond, cylinder…). |
| `connect_nodes` | Draw an edge, with an optional protocol label; `async` renders dashed. |
| `remove_node` | Delete a node and its edges. |
| `import_schema` | SQL DDL or Prisma text → ER diagram with column-level foreign keys. |
| `list_tasks` / `create_task` / `move_task` / `update_task` | The Kanban loop. |

Tasks carry `nodeIds`, which is the link between *what the system is* and *what
is being built* — a task can point at the service it touches.

## Codex, or any agent with a shell

The CLI covers the same operations for agents without MCP.

```bash
npx archboard init "My project"
npx archboard status

npx archboard diagram list
npx archboard diagram show <id>
npx archboard diagram new "Payments" --type architecture
npx archboard diagram import prisma/schema.prisma --title "Database"
npx archboard board new "Sprint sketches"      # a freehand whiteboard

npx archboard task list --status todo
npx archboard task add "Add refund endpoint" --status todo --node <nodeId>
npx archboard task move <taskId> in_progress
```

Statuses: `backlog`, `todo`, `in_progress`, `review`, `done`.

Commands work from any directory inside the project — the root is found by
walking up for `.arch/`.

## Seeing it

| Surface | URL |
|---|---|
| Project diagrams and task board | `/` (the project section) |
| A file-backed diagram | `/project/<diagramId>` |
| A file-backed whiteboard | `/project/board/<boardId>` |
| The Kanban board | `/project/tasks` |

Boards under `/project/*` read and write `.arch/` and carry an `.arch` badge.
Boards under `/arch/*` and `/board/*` are the standalone browser playground and
live in localStorage — an agent cannot see those.

Tasks that name `nodeIds` appear as a badge on those nodes on the canvas, so
work in flight is visible on the part of the system it touches.

## One implementation

The CLI and the MCP server both call `lib/project/store.ts`. There is a single
implementation of the on-disk format, so the two cannot drift. Writes are atomic
(write a temp file, then rename) because an agent and a human can be editing the
same board at the same moment.
