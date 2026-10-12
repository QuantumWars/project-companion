# Bug: logEvent skips the event log silently when a planted shard is refused

## Observed

Bug 54b4e811 (PR 28) made `appendEvent` (`lib/project/events.ts`) refuse a planted shard or `.project-log`: it
throws `Refused to write the event log: ... is not a regular file (bug 54b4e811) ...` (`events.ts:394`) or `... is
not a real folder ...` (`events.ts:378`) and writes nothing. The PM accepted that refusal. Some callers hide it, so
the user sees no message while the event is lost. Checked by reading the code at this head:

1. `logEvent` (`lib/project/store.ts:237-243`) wraps `appendEvent` in `try { } catch { /* Deliberately silent */ }`.
   After a planted own shard, `project-companion task add X` exits 0, saves the task in `.project`, and writes no
   log line and no warning. `logEvent` has 22 call sites in `store.ts`; every task, feature, component, run and
   finding edit goes through it.
2. (a) `recordVerification` (`store.ts:1270`) logs `criterion.verified` through the same `logEvent`, so a
   verification result is lost the same way.
3. (b) The `ingest` hook (`cli/index.ts:1207-1209`) has an empty `catch` around the whole handler.
   `recordSpawnRequest` (`lib/project/subagent.ts:19-21`) calls `appendEvent` directly, not `logEvent`, so
   `run.requested` is lost in that `catch`. A warning added only in `logEvent` would not reach it.
4. (c) The same silence follows a planted `.project-log` (a symlink or a file in place of the folder;
   `requireLogFolder` throws `... is not a real folder`), not only a planted shard. Both go through the same
   `appendEvent`.
5. (d) Runs exist only as events in the log (`readRuns` = `runsFrom(readEvents(root))`, `store.ts:1390`).
   `readEvents` leaves a shard that is not a regular file out (`readShard`, `events.ts:254-256`). With the actor's
   own shard planted, its runs read as missing, so `runForSession` returns null and the hook returns early at
   `cli/index.ts:1180` (`if (!run) return;`). It skips the budget check and the boundary check with no message.
   `startRun` also logs through `logEvent`, so a new `session.start` creates no run and says nothing.

Not swallowed (checked by reading): the direct `appendEvent` calls in `gate.ts:255,300,322,334` and
`cli/index.ts:1385-1511` have no `catch` of their own, so the refusal reaches the caller. Whether the CLI's top
level prints it for each of those commands is not checked.

## Expected

When the event log refuses a write, the user is told once, on stderr, and the command goes on as before.

Requirement ID: **UNKNOWN**. No EARS criterion states this. Stand-ins: TH-7 residual 3 in
`specs/decision-alerts/threat-model.md` (the "silent loss of events after a refused append" text, lines 111-113 and
the D1 and F2 rows), and the security re-check item N3 in `specs/bugs/54b4e811/bugfix.md:192` ("the wording in TH-7
about silent event loss, and the widened task ce914d26"). Flag to the PM and the architect: give this a criterion
id, or name where it lives.

Decision for the PM (the spec proposes; the PM decides):

- The warning is **one line on stderr**. Standard output, the exit code and the saved result do not change.
- Its text is fixed and says the event log refused a write, for example
  `project-companion: the event log refused a write (<reason class>); the change is saved in .project but not in the log.`
- It holds **no event text and nothing from a card or a task** (the notifier's rule, TH-5), and **no path of the
  outside target**. The refusal message in `events.ts` today holds the shard path inside the project
  (`.project-log/<actor>.jsonl`) and the project path in front of it, never the symlink target. The warning may name
  the shard path as `.project-log/<actor>.jsonl` (relative). It must not use `error.message` unchanged if that
  carries an absolute path the user did not need; the recommended text uses a fixed reason class, `not a regular
  file` or `not a real folder`.
- Exit code: unchanged. `task add` must still exit 0 and save the task (the log is an audit trail beside the
  state; the design of `logEvent` stays).

## Steps to reproduce

1. In a temporary git project run `project-companion init Demo` and `project-companion task add "First task"`.
   This creates the actor's own shard, `.project-log/<actor>.jsonl`.
2. Replace the shard with a symlink to a regular file in another folder (the "outside file").
3. Run `project-companion task add "Second task"`.
4. Observe: exit code 0, "Second task" is in `task list`, the outside file is unchanged, and stderr is empty. No
   line was added to the log and nothing says so.
5. Same for the hook: pipe `{"hook_event_name":"PreToolUse","tool_name":"Agent","session_id":"s1","tool_input":{"subagent_type":"devolps:backend-engineer","prompt":"Task: x"}}`
   to `project-companion ingest`. Exit 0, stderr empty, `run.requested` lost.
6. Replace `.project-log` with a symlink to an empty folder instead: the same silence, and the folder stays empty.

## Root cause

The "never fail the thing that happened" rule of `logEvent` was written when the only expected failures were a
read-only checkout or a full disk. It uses an empty `catch`, so it cannot tell those apart from a refusal that
means something is wrong or hostile (a merged symlink). Bug 54b4e811 added the refusal but kept the callers
silent, which turned a loud failure into a silent loss. The `ingest` hook and `recordSpawnRequest` have the same
shape, with their own empty `catch` and a direct `appendEvent`.

## Fix (as built, commit 9b8f21e)

PM decisions: card c-20c120 chose one fixed line on stderr with no event text, no task or card text, no symlink
target and no absolute path. Card c-e9c7ce chose to warn only for the bug-54b4e811 refusal, not for a read-only
checkout or a full disk.

- `LogRefusedError` (`lib/project/events.ts`, `code = "LOG_REFUSED"`): `appendEvent` throws it for a planted shard
  and for a planted `.project-log`. Callers match on the class, not on the message.
- `warnLogRefused(error)` (`events.ts:171`): writes `LOG_REFUSED_WARNING` to stderr only when `error` is a
  `LogRefusedError`, and only once per process (module flag `warned`). Any other error: nothing, and the flag is
  not used up.
- `warnIfLogPlanted(root)` (`events.ts:181`): for the hook that finds no run. It checks with `lstat` whether
  `.project-log` is not a folder, or the actor's own shard is not a regular file. If so it calls `warnLogRefused`.
  It never throws.
- Call sites: `logEvent` catch (`store.ts:243`); the `ingest` handler's catch (`cli/index.ts:1209`, covers
  `recordSpawnRequest`); the `if (!run)` skip (`cli/index.ts:1180`, calls `warnIfLogPlanted`).
- Exact warning text (one line, ends with a newline):
  `project-companion: the event log refused a write (not a regular file or not a real folder); events are not being recorded. Fix: remove the planted file in .project-log/.`
- Exit code, standard output and the saved result do not change. `appendEvent`'s refusal is unchanged.

## Regression test

`tests/bug-ce914d26.test.ts` (6 tests, built CLI, temporary project, temporary `HOME`, no `CLAUDE_PROJECT_DIR`,
10 s timeout on each child, `PROJECT_COMPANION_NOTIFY=off`; test rules 1, 2, 3, 5):

1. `ce914d26: task add after a planted own shard says the event log refused a write`
2. `ce914d26: task add with a working log prints no warning (control)`
3. `ce914d26: a planted .project-log gives the same one warning and writes nothing outside`
4. `ce914d26: the ingest hook says so when it cannot record run.requested, and still exits 0`
5. `ce914d26: the ingest hook prints one warning, not two, for a session.start that logEvent cannot record`
6. `ce914d26: a tool.use hook that finds no run because the shard was planted after run start warns once and exits 0`

`tests/log-refused-warning.test.ts` (5 unit tests):

1. `ce914d26: warnLogRefused prints the fixed line once for the refusal, not twice`
2. `ce914d26: warnLogRefused prints nothing for other errors`
3. `ce914d26: a non-refusal error does not use up the once-per-process flag`
4. `ce914d26: the warning holds no event text, path or message of the error`
5. `ce914d26: appendEvent throws the dedicated class for a log folder that is a file`

Result at head 6798024: `npm test -- ce914d26` 6 of 6; `npm test -- log-refused` 5 of 5. Before the fix (branch
`fix/ce914d26-bug-spec`) the CLI test file gives 1 of 5 (the control passes, 4 fail).

Note: removing the once-per-process flag fails only unit test 1, because no CLI command reaches two refused writes
in one process (the builder's finding; QA did not re-run this).
