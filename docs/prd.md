# Project Companion PRD

Project Companion is project management that runs alongside your coding agent. The architecture
canvas describes what the system is; the roadmap and board describe what is being built;
the git tree proves what actually got built.

This document is the source of truth for the feature list. The app reads and writes it, and
so does your agent — it is a plain markdown file, reviewed in a pull request like any other
change.

## Phase: Roadmap spine

Goal: give the board a spine, so work can be tracked per feature rather than as a flat list.

### PRD round-trip
<!-- id: prd-round-trip -->

Read `docs/prd.md` into features and phases, and write edits back without disturbing a
single byte the parser does not own.

Paths: lib/project/prd.ts, lib/project/roadmap.ts

- [x] Parse headings, phases, summaries, acceptance criteria and path globs
- [x] A heading inside a fence or an HTML comment is never mistaken for a feature
- [x] Edits splice only their own ranges; prose, tables and code survive
- [x] Feature ids survive a rename
- [x] A stale write is refused rather than clobbering an agent's edit

### Derived status
<!-- id: derived-status -->

Feature status comes from the acceptance checkboxes, so ticking a box moves the board and
moving the board never rewrites the document.

Paths: lib/project/roadmap.ts

- [x] All criteria checked means done, some means in progress, none means todo
- [x] An explicit pin overrides the derivation and can be cleared
- [x] The board surfaces a pinned status distinctly from a derived one

### Feature-linked tasks
<!-- id: feature-linked-tasks -->

A task names the feature it implements, so the board can group work by the segment of the
PRD it belongs to.

Paths: lib/project/store.ts, app/api/project/tasks/**

- [x] Tasks carry featureId and phaseId
- [x] Tasks can be reordered within a column, not just appended
- [x] The Kanban groups into swimlanes by phase or feature
- [x] A task detail panel can edit a task after creation

## Phase: Git tree

Goal: replace self-reported progress with evidence from the repository.

### Repository reading
<!-- id: repository-reading -->

Read commits, branches, worktrees and status without a git dependency and without a shell.

Paths: lib/project/git.ts

- [x] Commits parse with stats and paths, including multi-line bodies
- [x] A ref that is really an option is rejected
- [x] A project outside a repository degrades instead of erroring

### Commit attribution
<!-- id: commit-attribution -->

Attribute commits to tasks and features by recorded sha, message trailer, branch name, and
path overlap, in that order of confidence.

Paths: lib/project/git-link.ts, lib/project/git-view.ts

- [x] All four signals resolve, strongest first
- [x] Path overlap attributes to a feature and never to a task
- [x] An ambiguous path match is no match
- [x] The git surface lists unattributed commits for one-click linking

### Branch creation
<!-- id: branch-creation -->

Starting a task can open a branch, and optionally a worktree. Nothing else in the codebase
can write to a repository.

Paths: lib/project/git-write.ts

- [x] A branch is created without checking it out
- [x] A worktree outside the repository's parent is refused
- [x] The board offers it behind a confirmation

## Phase: Composable diagrams

Goal: one canvas holds several diagrams, and diagrams link to each other.

### Frames
<!-- id: frames -->

A frame is a titled region that is its own diagram, with its own type and its own layout
algorithm, so an ER diagram and a flowchart can share a canvas.

Paths: types/arch.ts, lib/arch/layout.ts

- [x] A group can declare a diagram type
- [x] Tidy up lays out each frame by its own rules
- [x] The shape palette leads with the frame's family

### Drill-down
<!-- id: drill-down -->

Any node can link to the diagram that details it, with a breadcrumb back.

Paths: app/arch/**

- [x] Nodes carry a drilldown diagram id
- [x] c4 and note nodes exist and are registered
- [x] UML class attributes and methods are editable

## Phase: Component model

Goal: make every node on the architecture canvas a unit of accountability, with its own
board, its own owner and its own evidence -- so the diagram becomes the way you navigate
the work rather than a picture beside it.

### Component catalog
<!-- id: component-catalog -->

A component is an architecture node that owns work: a title, a directly responsible
individual, a region of the source, and a place in the containment tree. Its declared
paths are the join key everything else resolves through.

Paths: lib/project/component.ts

- [x] A component has an id that survives a rename, and orphans rather than deletes
- [x] Path overlap resolves to the most specific claim, and an ambiguous one to nothing
- [x] The catalog reports what is wrong with it: unowned, pathless, ambiguous, dangling
- [x] The canvas stamps component ids onto its nodes, and orphans what it removes
- [x] A component's board, spec and evidence are one surface in the app

### The event log
<!-- id: event-log -->

An append-only record of what happened, sharded one file per actor so two writers never
touch the same file and a merge has nothing to resolve. Each shard is hash-chained, so
editing history after the fact is detectable.

Paths: lib/project/events.ts

- [x] Every state change is recorded with its actor, its component and its order
- [x] Two actors' logs merge with no conflict, by construction
- [x] Tampering with a record breaks the chain and the break is reported
- [x] A log that cannot be written never fails the write it was recording

### Concurrent PRD edits
<!-- id: prd-lock -->

The PRD had a compare-and-swap on its bytes but no mutual exclusion, so two writers could
both pass the hash check and the second rename erased the first.

Paths: lib/project/roadmap.ts, lib/project/bundle.ts

- [x] The project lock is re-entrant, so a nested write does not deadlock against itself
- [x] Editing the PRD holds that lock across the whole read-check-write
- [x] Concurrent ticks from separate processes all land, and the prose is untouched

## Phase: Agent plane

Goal: make an agent a supervised contributor rather than an anonymous one -- with a
budget, a boundary, and a record of what it actually did that the repository can be
checked against.

### Agent runs
<!-- id: agent-runs -->

A run is a unit of agent work with a state machine, a budget and a path boundary, derived
from the event log rather than stored -- a run updates on every tool call, and taking the
project lock that often would stall every other writer.

Paths: lib/project/run.ts

- [x] A run's lifecycle refuses the transitions that make no sense
- [x] A run inherits its budget and boundary from the component that owns the work
- [x] Going over budget blocks the run rather than failing the agent's session
- [x] A write outside the boundary is refused and reported, never silently counted
- [ ] Mission control shows what is in flight and what it is spending

### Harness ingestion
<!-- id: harness-ingestion -->

Runs record themselves from the coding agent's own hooks, normalised onto the
OpenTelemetry GenAI conventions so a harness other than Claude Code needs no adapter.

Paths: lib/project/ingest.ts

- [x] A session start, tool use and session end each become the right event
- [x] Only files the agent wrote are counted, not everything it read
- [x] A payload this build does not understand is ignored, never an error
- [x] `init` installs the hooks without disturbing what is already there

### Run attribution
<!-- id: run-attribution -->

The fifth and second-strongest signal: a commit of files a run was watched writing,
inside the window it was open. This is what makes attribution work without the trailer.

Paths: lib/project/git-link.ts

- [x] A commit matching a run's files and window attributes to that run's task
- [x] A window without a file overlap is not a match, and neither is the reverse
- [x] Two runs claiming one commit attribute to neither
- [x] A recorded sha still outranks it, and it outranks a trailer
