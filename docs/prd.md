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
- [ ] The git surface lists unattributed commits for one-click linking

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

- [ ] Nodes carry a drilldown diagram id
- [ ] c4 and note nodes exist and are registered
- [ ] UML class attributes and methods are editable
