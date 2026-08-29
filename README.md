<div align="center">
  <img src="public/logo.svg" width="56" alt="">
  <h1>Project Companion</h1>
  <p><strong>Project management that runs with your coding agent.</strong></p>
  <p>
    Lay out the architecture, write the PRD, track the work — and let the git
    history prove what was actually built.
  </p>
</div>

---

Most project tools ask you to report progress. This one reads it.

A task is `done` because someone dragged a card, which tells you nothing. Project
Companion links every commit back to the task and the PRD feature it belongs to,
so the board can be checked against the repository instead of trusted.

It is local-first and file-backed on purpose: everything lives in your repo as a
single `.project` file, so the coding agent you already use can read and write it
with ordinary tools.

<img src="docs/media/roadmap.png" alt="The roadmap surface, showing PRD features with derived status">

## What it does

**The PRD is the feature list.** `docs/prd.md` is an ordinary markdown document.
The app reads *and writes* it, splicing only the ranges it owns — prose, tables
and code fences survive an edit byte for byte. Ticking an acceptance criterion in
the browser changes exactly one character in the file.

**Status is derived, not stored.** All criteria checked means done, some means in
progress. Your agent ticks a box and the board moves; you move a card and the
document is untouched.

**Commits attribute themselves.** Four signals, strongest first: a recorded sha, a
`project-companion: <id>` trailer, the branch name, then overlap with a feature's
declared paths. Path overlap only ever names a *feature*, never a task — it is an
inference, and a task is a specific claim.

<img src="docs/media/git.png" alt="The git surface, with a commit graph and per-feature delivery evidence">

**Diagrams, on one canvas.** Architecture, ER schemas with column-level foreign
keys, flowcharts, UML, and the rest of the Miro diagram families. Frames let one
board hold several diagrams, each laid out under its own algorithm.

<img src="docs/media/canvas.png" alt="The architecture canvas in dark mode">

## Quick start

```bash
npm install
npm run dev
```

Then, in any repository you want to track:

```bash
npx project-companion init
```

That creates a `.project` file, writes an agent skill into `.claude/skills/`, and
registers the project so it appears in the launcher.

## For the agent

`init` writes a skill file into the agent's own directory, so Claude Code, Codex,
Cursor or Gemini CLI learn the tool from the repository itself — no MCP
configuration, no setup step.

```bash
project-companion feature list              # the PRD's features
project-companion task start <id>           # get the branch name for a task
project-companion task done <id> --commit HEAD
project-companion git unlinked              # commits linked to nothing
```

Commit with the trailer and the work links itself:

```
Add refund endpoint

project-companion: 978ce4d6
```

An MCP server with 20 tools is configured at `.mcp.json` for agents that prefer
them to a shell. The bundle it points at is gitignored, so build it once after
cloning:

```bash
npm run build:tools
```

## How a project is stored

One file at the repository root:

```
.project              diagrams, whiteboards, tasks, phases, overrides, git settings
docs/prd.md           the feature list — a document, so it stays reviewable
.project-cache/       derived git attribution; gitignored, safe to delete
```

Writes hold an exclusive lock and run as transactions, so a canvas autosave and a
CLI edit in another terminal compose rather than collide.

Projects created before the single-file format keep opening unchanged;
`project-companion migrate` converts one when you are ready.

## Development

```bash
npm run dev          # the app
npm test             # 106 assertions across seven suites
npm run build:tools  # rebuild the CLI and MCP bundles
npx tsc --noEmit     # typecheck, CLI and MCP included
```

The test harness is dependency-free — `node:assert` plus esbuild — and runs each
suite in a fresh process against real temporary git repositories.

## Built on

This started as [Antonio Erdeljac's Miro clone tutorial][tutorial] and kept the
whiteboard engine. Convex, Clerk and hosted Liveblocks were removed in favour of
local storage and a file-backed store; the architecture canvas, roadmap, board,
git surface and agent tooling are new.

[tutorial]: https://github.com/AntonioErdeljac/next14-miro-clone
