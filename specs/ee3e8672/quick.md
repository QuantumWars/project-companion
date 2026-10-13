# Quick change: Close a run's attribution window when its task is done

What: A run's attribution window now ends at the earlier of two times: when the run ends (`merged` or `abandoned`), or when the run's task first moves to `done` at or after the run started.
- **Where the done time comes from:** `runsFrom` (`lib/project/run.ts`) reads `task.moved` events with `to: "done"` and sets a new optional run field, `taskDoneAt`. These events have no `runId`, so they must be read before the `if (!id) continue` at line 206. `state`, `endedAt` and `updatedAt` do not change.
- **Attribution:** `runFor` (`lib/project/git-link.ts:142-157`) uses `taskDoneAt` as the window end when it is earlier. `AttributableRun` (line 165) gets the field.
- **Board drags:** `reorderTask` (`lib/project/store.ts:1692`) writes the same `task.moved` event `{taskId, from, to}` as `moveTask` (line 1788). It writes it only when the status changes.
- **Cache key:** the Git view cache key (`lib/project/git-view.ts:47-48`, used at line 80) adds the number of runs that have a `taskDoneAt` and the newest `taskDoneAt`.
- **Unchanged:** no new event kind, no change to `.project`, `updateTask`, `moveTask`, `createTask`, run states or run transitions.

How "done" is reached. The spec-writer checked each path by reading the code:
- **`moveTask` writes the event.** It is used by `task move`, `task done` (`cli/index.ts:554`), the MCP tool `move_task` (`mcp/server.ts:608`), and a PATCH request that has no `index`.
- **`reorderTask` writes nothing today.** The board always sends an `index`:
  - `board.tsx:258` passes `dropIndex ?? tasks.length`.
  - `use-tasks.ts:59` sends it in the request body.
  - `app/api/project/tasks/[id]/route.ts:35-37` then calls `reorderTask`.

  So every board drag to Done skips the event today. This is the gap the change closes (PM card c-4b1b61: yes).
- **`updateTask` cannot set a status from any caller found:**
  - The PATCH route removes `status` before it calls `updateTask` (route.ts:43).
  - `task set` builds its patch without `status` (cli:1630-1640).
  - The MCP `update_task` schema lists only `title`, `description`, `nodeIds` and `labels` (mcp:621-626). Not tested: whether zod strips other keys.
  - The internal callers pass only `blocked` and `pr` (store:1587, 1606).

  So `updateTask` stays unchanged. Reading `task.updated` would not help anyway: that event records only the names of the changed fields, not their values.
- **`createTask --status done`** writes `task.created`. A run cannot have started on a task before the task exists, so this path is also unchanged.

Why: Today a run without `endedAt` is open forever. In this repository's log, all 72 runs that have a task are still open, and 68 of them have a done event after their start. Source: the spec-writer's read-only count of `.project-log/*.jsonl` on this checkout, with a simple fold that does not drop illegal transitions.

An open run claims every later commit that touches a file it touched. It also outranks the trailer and the branch name. Bug spec 37f9fbce (lines 113-122) records this, and PM card c-2e1d54 decided to close the window when the task is done.

Limits: 4 source files (`run.ts`, `git-link.ts`, `git-view.ts`, `store.ts`) and 2 doc files. 1 new suite, `tests/agent-run-done-window.test.ts`. It is named so that the PRD's `Verify: npm test -- agent-run` also runs it. Estimate: about 40 changed source lines and about 200 test lines (from reading the code). No schema, no new event kind, no component.

## Requirements
| ID | Requirement (EARS) | Plain English |
|---|---|---|
| RW-01.1 | When the log holds one or more `task.moved` events with `to: "done"` for a run's `taskId`, timed at or after the run's `startedAt`, `runsFrom` shall set the run's `taskDoneAt` to the ISO time of the earliest such event, with the run's `state`, `endedAt` and `updatedAt` as before this change. | The run learns when its task was first done after the run began. Its state and end time do not change. |
| RW-01.2 | While a run has a `taskDoneAt`, attribution shall match a commit to that run only when the commit's author time is at or before `taskDoneAt`. | Work committed before "done" still belongs to the run. Later commits fall through to the trailer, the branch name or the paths. |
| RW-01.3 | If the run's task moves out of `done` after its first done time, then `runsFrom` shall keep the run's `taskDoneAt` at that first done time. | A reopened task does not reopen an old run (PM card c-55225f: stay closed at the first done time). |
| RW-01.4 | If a run has both an `endedAt` and a `taskDoneAt`, then attribution shall end the run's window at the earlier of the two. | Whichever happened first, "run ended" or "task done", closes the window. |
| RW-01.5 | If a run has no `taskId`, or the log holds no `task.moved` to `done` for its task at or after its start, then attribution shall give that run the same window as before this change. | Runs without a task, and tasks never finished, behave as today. This includes a run started on a task that is already done. |
| RW-01.6 | When `reorderTask` sets a task to a status other than its current one, the store shall append one `task.moved` event `{taskId, from, to}`, the same shape `moveTask` writes. | A drag on the board leaves the same record as `task move`. A drag within one column writes nothing (PM card c-4b1b61: yes). |
| RW-01.7 | When a `task.moved` to `done` gives any run a new `taskDoneAt`, `readGitView` shall compute attribution again instead of returning the cached one. | The app's Git view does not show stale run labels after a task is done. |
| RW-01.8 | When attribution is read (`git log`, `git unlinked`, MCP `linkRepository`, `readGitView`), the system shall leave `.project` and every file in `.project-log/` byte for byte unchanged. | The window end is computed when attribution is read. It is never stored. `.project-cache/git.json` may still change: it is a cache. |

Verify: the new suite `tests/agent-run-done-window.test.ts`, run with `npm test -- agent-run-done-window`. Its CLI tests follow `tests/bug-37f9fbce.test.ts`: a temporary project, a temporary `HOME`, no `CLAUDE_PROJECT_DIR`, `PROJECT_COMPANION_NOTIFY=off`, a 10 s timeout and an `ingest` hook with a relative path. Test rules 2, 3, 5, 6 and 8 apply.
- RW-01.1: test `RW-01.1: taskDoneAt is the first done at or after the run's start`. Synthetic events: `run.started` at ts 1000 for t1; `task.moved` t1→done at 500 (before the start, so ignored); t1→done at 2000; t1→review at 3000; t1→done at 4000. Expected: `taskDoneAt === new Date(2000).toISOString()`, `state === "running"`, `endedAt === undefined`, `updatedAt === new Date(1000).toISOString()`.
- RW-01.2: test `RW-01.2: a commit authored after taskDoneAt is not the run's; one at or before it is`. An `attribute()` unit: before → signal `run`; after → undefined; after with a trailer → `trailer`. Plus a CLI test `RW-01.2: git log shows - for a commit after task move done`.
- RW-01.3: test `RW-01.3: a reopened task keeps the first done time`, and test `RW-01.3: a new run after reopen gets its own commits`.
- RW-01.4: test `RW-01.4: the earlier of endedAt and taskDoneAt ends the window`, both orders.
- RW-01.5: test `RW-01.5: no taskId, or no done, keeps today's window`. The existing suites must stay green: `npm test -- agent-run` (includes `agent-run-paths`), `npm test -- bug-37f9fbce`, `npm test -- bug-15753492`.
- RW-01.6: test `RW-01.6: reorderTask to another column appends task.moved`. `reorderTask(root, id, "done", 0)` → the last event is `task.moved` with `{taskId: id, from: "in_progress", to: "done"}`. Then the same call again → the event count is unchanged. Then a `readRuns` run on that task gets a `taskDoneAt`. `npm test -- flow` and `npm test -- events` stay green.
- RW-01.7: test `RW-01.7: moving the task to done turns over the Git view cache`. `readGitView(root, [])` → the "after" commit shows `run`. Then `moveTask(root, id, "done")`. Then a commit authored at done + 60 s. Then `readGitView(root, [])` without `refresh` → that commit's signal is not `run`. The `fingerprint` in `.project-cache/git.json` differs from the first call.
- RW-01.8: test `RW-01.8: reading attribution writes nothing to .project or .project-log`. It compares SHA-256 hashes of `.project` and each `.project-log/*.jsonl` before and after `git log`, `git unlinked`, `linkRepository(...)` and `readGitView(...)`.
- Revert check (test rule 6): revert each part in place and keep every export. `runFor` ignores `taskDoneAt` → RW-01.2, RW-01.3 and RW-01.4 (done-first case) must fail. Remove the `logEvent` in `reorderTask` → RW-01.6 must fail. Remove the done part of the cache key → RW-01.7 must fail.

## Risk
- **Old commits change label.** Bug spec 37f9fbce records this already. Commits now shown as `run` relabel to `trailer`, `branch`, `paths` or nothing, if they were authored after their task's first done time. In this repository, 68 of 72 task-linked runs would close (see Why). How many commits move: UNKNOWN (not counted).
- **The PRD ranks the run signal second-strongest** (`docs/prd.md`, id `run-attribution`). After done, a weaker signal (trailer or branch) can now name the task for a later commit. This is intended: the run no longer claims that commit.
- **Board drags start to count (RW-01.6).** `taskFlow` (`flow.ts:86`) and `doneTimes` (`sprint.ts:85-95`) read `task.moved`. After the change, board drags start to count in cycle time and in burnup "done" from that day on. Today they are missing, which looks like an existing defect. Past drags are not backfilled (PM card c-4b1b61: yes).
- **Old board drags have no event.** Runs whose task reached Done only by a board drag stay open. Workaround: `task move <id> review`, then `task move <id> done`. This closes the window at the time of the second command, not at the original drag.
- **Commit times are to the second.** Commit author time has 1-second resolution and the done time has millisecond resolution. A commit authored in the same second as the done move still counts as before done.
- **A run started after its task was already done** (and not reopened) stays open. This matches today's behaviour (RW-01.5).
- **Clocks on different machines.** The done time comes from the clock of the machine that moved the task. The author date comes from the committer's clock. The window start has the same limit today.
- **`readGitView` recomputes once.** The new cache key changes every existing key, so the next read recomputes one time.
- **Threat model.** `specs/decision-alerts/threat-model.md` covers the notify path. It names D1 (the event log) and F0 (the existing append). This change adds only one more caller of the existing `logEvent` append, with an existing event kind. No change is expected; the EM checks this once more after the build.
- **Rollback.** Revert the commit. The only data written is extra `task.moved` events from board drags, which every reader already understands.

## Tasks
- **ee3e8672:** Close a run's attribution window when the run's task is done. Role: backend-engineer. Component: UNKNOWN; the EM sets the owner of `lib/project/`.
- **Docs (constitution rule 12), in the same pull request:**
  - `docs/prd.md`, `run-attribution`: change "inside the window it was open" to "inside the window it was open, which ends when the run ends or its task first moves to done, whichever is first". Add `- [x] A commit made after the run's task moved to done is not the run's`.
  - `README.md:37`: change "an agent run that was watched writing those files" to "an agent run that was watched writing those files, before its task was done".
  - The `git-link.ts` header (signal 2) and the comment on `runFor`.
  - `lib/project/skill-template.ts`: checked by the spec-writer. It does not describe the window, so no change.
  - Check: `grep -n "moves to done" docs/prd.md README.md lib/project/git-link.ts` shows each edit.
- **CHANGELOG:** at release, through `/devolps:release`.
- Note on the builder's write scope: `docs/prd.md` and `README.md` are outside the backend-engineer's usual scope. The EM applies the two doc edits, or widens the builder's scope in its prompt.

## Open questions
- [x] **Q1. A task reopened after done (RW-01.3).** Answered by the PM, card c-55225f: the window stays closed at the first done after the run's start.
- [x] **Q2. Board drags write `task.moved` (RW-01.6).** Answered by the PM, card c-4b1b61: yes. This also changes burnup and cycle time from now on.
