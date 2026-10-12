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

## Fix

Places that swallow the refusal (each found by reading):

- `lib/project/store.ts:237-243`, `logEvent`'s `catch` (covers items 1, 2 and 4, and `startRun`).
- `cli/index.ts:1207-1209`, the `ingest` handler's `catch` (covers `recordSpawnRequest`, item 3).
- `lib/project/subagent.ts:19-21`, `recordSpawnRequest` (no catch of its own; it relies on the hook's).
- `cli/index.ts:1180`, `if (!run) return;` (item 5(d)): the early return that skips the budget and boundary checks.

Proposed change: one shared helper, for example `warnLogRefused(error)` next to `appendEvent` in `events.ts`.
It writes the fixed one-line message to `process.stderr` when the error is the 54b4e811 refusal (match on a
dedicated error class or code, not on message text), and does nothing for other errors that `logEvent` is meant to
absorb (a read-only checkout, a full disk); the builder and the PM may decide to warn for those too. `logEvent`,
the `ingest` catch and `recordSpawnRequest` call it. For 5(d), when the hook finds no run for the session and the
own shard is not a regular file, it uses the same helper once, so the skipped checks are no longer silent.

Line estimate: about 40 to 70 changed lines (the helper and an error class about 15 to 20, three call sites about
10, a once-per-process guard about 5, test and doc updates the rest). Basis: the three sites above and the
existing test file's size; this is an estimate, not a measurement.

The fix must NOT:

- make a task, feature or component edit fail, or change an exit code, because the log refused;
- print twice per command: one process prints at most one warning, so a command with several `logEvent` calls
  (and a hook that fails in `startRun` and then again at `if (!run)`) uses a once-per-process flag in the helper;
- put event text, card text, a task title, the symlink target or an absolute path in the warning;
- write to the log or to the target, or change `appendEvent`'s refusal;
- make a hook exit non-zero (`ingest` stays silent on an unknown event and never non-zero).

Docs in the same change (rule 12): `specs/decision-alerts/threat-model.md`, TH-7 residual 3. Remove the
"silent loss of events after a refused append (task ce914d26)" item from the open list (lines 111-113), and
change the D1 row ("An event whose append is refused can be lost with no message (task ce914d26)") and the F2 row
(the "ce914d26" clause) to say the event is still lost, but the user gets one warning line. Record the
accepted residual: the event itself is not recovered; the log is an audit trail, and `.project` has the state. The
architect owns that edit.

## Regression test

`tests/bug-ce914d26.test.ts`, 5 tests. They drive the real built CLI in a temporary git project, with a temporary
`HOME`, no `CLAUDE_PROJECT_DIR`, a 10 s timeout on every child and `PROJECT_COMPANION_NOTIFY=off` (test rules 1, 2,
3, 5). The planted shard is a symlink to a regular file in a separate temporary folder, so it cannot block.

- `ce914d26: task add after a planted own shard says the event log refused a write`: exit 0 and the task saved
  (pass before and after); outside file unchanged; exactly one stderr line that says the log refused a write, with
  no title and no outside path (fails today).
- `ce914d26: task add with a working log prints no warning (control)`: passes today and after.
- `ce914d26: a planted .project-log gives the same one warning and writes nothing outside` (fails today).
- `ce914d26: the ingest hook says so when it cannot record run.requested, and still exits 0` (fails today).
- `ce914d26: the ingest hook prints one warning, not two, for a session.start that logEvent cannot record`
  (fails today; after the fix it also guards the once-per-command rule).

Not covered by a test: the `if (!run) return;` skip of item 5(d) with a running run in a planted shard, because a
run cannot be created while the shard is planted; the builder should add a test that plants the shard after
`run start`, then sends a `tool.use` hook and expects one warning.

```
$ npm test -- bug-ce914d26
bug-ce914d26.test.ts
  FAIL ce914d26: task add after a planted own shard says the event log refused a write
       stderr must carry exactly one line that says the event log refused a write, got: "": expected 1, got 0
  ok   ce914d26: task add with a working log prints no warning (control)
  FAIL ce914d26: a planted .project-log gives the same one warning and writes nothing outside
       stderr must carry exactly one line that says the event log refused a write, got: "": expected 1, got 0
  FAIL ce914d26: the ingest hook says so when it cannot record run.requested, and still exits 0
       stderr must carry exactly one line that says the event log refused a write, got: "": expected 1, got 0
  FAIL ce914d26: the ingest hook prints one warning, not two, for a session.start that logEvent cannot record
       exactly one warning per command, got: "": expected 1, got 0

1/5 passed
```
