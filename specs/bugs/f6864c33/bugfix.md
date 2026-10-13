# Bug: the CLI prints a Node stack trace when the event log refuses a gate or card command

Track: Bugfix (confirmed by the PM, route r-1.1). Checked at head 9fae5d9. Every statement below was read in the code
or run against the built CLI at that head, unless it says "not checked".

## Observed

Bug 54b4e811 makes `appendEvent` (`lib/project/events.ts`) throw `LogRefusedError` for a planted shard
(`events.ts:447`, `... is not a regular file`) and for a planted `.project-log` (`events.ts:431`, `... is not a real
folder`). Bug ce914d26 made the callers that swallow it print one fixed warning. The commands that call
`appendEvent` directly, or through `lib/project/gate.ts`, have no `catch` for it. `main()` (`cli/index.ts:618`) has
no top-level handler, and `main();` at `cli/index.ts:2206` is a bare call. Node prints the uncaught exception.

Run against the built CLI (`dist/project-companion.mjs`), after the actor's own shard is replaced by a symlink to a
file outside the project:

- `gate request prd <subject> --artifact notes.md`: exit code 1. Standard error holds 15 lines: the bundle file URL
  and line number, a source line, a caret, `LogRefusedError: Refused to write the event log: <absolute project
  path>/.project-log/<actor>.jsonl is not a regular file (bug 54b4e811). Remove it and try again.`, 8 stack frames
  (`    at ...`, each with the absolute path of `dist/project-companion.mjs`), `code: 'LOG_REFUSED'` and `Node.js v22.23.1`.
- `card open --subject <subject> --ask <question>`: the same, with 7 stack frames.
- With `.project-log` itself replaced by a symlink: the same, with `... is not a real folder` and the path of
  `.project-log`.

The stack trace is not only noise. It holds the absolute project path and the absolute path of the installed bundle
(the threat model names the project path; the bundle path is new, see "Threat model" below). The real error is on
line 5 of 15, and nothing says what to do. It also hides the fix that the warning from bug ce914d26 already gives.

Checked by reading: the `gate` branch (`cli/index.ts:1225-1371`) wraps its work in `try { } catch (error) { if
(error instanceof GateError) die(error.message); throw error; }` (`cli/index.ts:1365-1368`). `LogRefusedError` is
not a `GateError`, so it is rethrown. The `card` branch (`cli/index.ts:1453-1495`) has no `catch`.

## Expected

When the event log refuses a write for a command that has no catch of its own, the user sees **one plain line** on
stderr, the command exits non-zero, and nothing else is printed.

Requirement ID: **UNKNOWN**. No EARS criterion states this. Nearest sources: the threat model
`specs/decision-alerts/threat-model.md`, TH-7 residual 3 (line 191: "The commands that call `appendEvent` directly
(`gate`, `sprint`, `card`, `update`) do not handle the refusal ... task f6864c33") and the F2 row; the Fix section of
`specs/bugs/ce914d26/bugfix.md`; PM card c-20c120 (the shape of the line). Flag to the PM and the architect: give this
a criterion id, or name where it lives.

### What the one line says (the spec proposes; the PM decides)

PM decision already made (card c-20c120): fixed words only. The line holds **no event text, no task or card text, no
symlink target and no absolute path**. That covers the subject, the question, the project path, the bundle path and
the actor id in the shard name.

Two ways to write it. This is a choice for the EM; the regression test accepts both.

- **Option A (recommended): a new fixed line that says the command failed.** For example
  `project-companion: the event log refused the write, so the command did not run. .project-log, or a .jsonl file in
  it, is a link or not a plain file or folder. Fix: delete that link or file (ls -ld .project-log, then ls -la
  .project-log/ to look), then run the command again.` Why: the ce914d26 line says the log "is not recording
  events", which is right for a command that goes on (`task add`). It does not say that this command failed. The user
  of `gate request` needs to know that no gate was requested.
- **Option B: reuse `LOG_REFUSED_WARNING` unchanged.** Cheaper (one fixed string, one test of equality). The
  non-zero exit code carries the "failed". Weaker for a user who reads only the text.

Either way: the line starts with `project-companion: ` and contains `event log` (the test asserts this). It does not
use `error.message`, which holds an absolute path (TH-5 rule from ce914d26).

Exit code: **non-zero**. Today it is 1 (the uncaught-exception code); keep 1, the same as `die()`. Standard output:
unchanged (empty).

### State left behind

Checked, as observed: with the actor's own shard planted, `gate request` and `card open` change **no file inside the
project**. I hashed every file outside `.git` before and after the two commands and the lists were identical (the
outside target file is unchanged too). The reason: gates, cards, sprints and updates are events only; nothing is
saved in `.project` before the log write. So a refused `gate request` or `card
open` leaves no requested gate and no card (by reading: `requestGate` and `card open` write only through
`appendEvent`; I did not run `gate status` or `card list` on that state). The spec makes no claim about rollback for other commands (see the table: only `sprint add --tasks` has two
appends in a row; a partial result there is not checked). The index under `HOME` is touched by every CLI command; I did
not examine whether the refused commands change it.

## Steps to reproduce

1. In a temporary git project run `project-companion init Demo` and `project-companion task add "First task"`. This
   creates the actor's own shard, `.project-log/<actor>.jsonl`. Create `notes.md`.
2. Replace the shard with a symlink to a regular file in another folder (the "outside file").
3. Run `project-companion gate request prd e1 --artifact notes.md`.
4. Observe: exit code 1, stderr holds a 15-line Node trace with `    at ` frames, the bundle path and the project path.
5. Run `project-companion card open --subject e1 --ask "q" --options "a|b"`. Same, 14 lines.
6. Replace `.project-log` with a symlink to an empty folder instead. Same trace with `is not a real folder`.

## Root cause

`LogRefusedError` was added for bug 54b4e811 and caught in the callers that hide errors (ce914d26). The callers that
let errors out were never given a handler: `gate.ts` throws `GateError` for bad input, and the CLI turns that into a
plain line. A refusal of a different class reaches the bare `main();` call and Node's default handler prints it. There
is no single place in the CLI that turns an error into one line.

## Where else does this happen

Checked by reading and by running each command against the planted-shard state (a second shard held the earlier
events so the command got as far as the append). "Stack" is the count of `    at ` lines on stderr.

| Command (file:line of the append) | Reaches a `LogRefusedError` throw with no catch? | Observed | Proposed scope |
|---|---|---|---|
| `gate request` (`gate.ts:255`, `cli/index.ts:1259`) | yes | exit 1, trace | **In scope** (PM named) |
| `gate approve` (`gate.ts:300`) | yes | exit 1, trace | In scope: same function family, same branch |
| `gate refuse` (`gate.ts:322`) | yes | exit 1, trace | In scope: same |
| `gate track` (`gate.ts:334`) | yes | exit 1, trace | In scope: same |
| `card open` (`cli/index.ts:1462`) | yes | exit 1, trace | **In scope** (PM named) |
| `card answer` (`cli/index.ts:1476`) | yes | exit 1, trace | In scope: same branch |
| `sprint add` (`cli/index.ts:1389,1396`) | yes | exit 1, trace | EM choice. Proposed: in scope (one top-level catch covers it for free) |
| `sprint commit` (`:1406`), `add-task` (`:1414`), `close` (`:1420`) | yes | exit 1, trace | EM choice. Proposed: in scope, same |
| `update draft` (`:1506`), `update publish` (`:1515`) | yes | exit 1, trace | EM choice. Proposed: in scope, same |
| `run start` (`store.ts:1451` through `logEvent`, then `store.ts:1474`) | **no, a different error** | `logEvent` prints the ce914d26 warning, then `startRun` throws a plain `Error("Could not record the run. The event log is not writable ...")`. Exit 1, trace of 6 frames | EM choice. **Out of scope by the PM's rule** ("do not widen to other error types"). Proposed: a separate task. The same `startRun` is called by the MCP tool (`mcp/server.ts:732`); not checked |
| `ingest` hook (`recordSpawnRequest` `subagent.ts:20`, `startRun`) | no, caught (`cli/index.ts:1210`) | exit 0, ce914d26 warning | Out of scope: fixed by ce914d26 |
| `task`, `component`, `pr link/sync`, `verify`, `review`, `feature`, `prd`, `phase`, `move`, `wip`, `migrate` (all through `logEvent`) | no, caught in `logEvent` (`store.ts:243-250`) | `task add`, `component add`: exit 0 and the ce914d26 warning. `verify`: stopped earlier ("No PRD"). `pr link`: stopped at `gh` login. The others: not run, same `logEvent` path by reading | Out of scope: fixed by ce914d26 |
| `log`, `whose`, `status`, `projects`, `cockpit`, `gate status/check/metrics`, `card list`, `sprint list/show`, `update show/list` | no append (reads only) | not run, by reading | Not affected |
| `merge-driver`, `init`, `diagram`, `board`, `reindex`, `git` | no event-log append found by reading | not run | Not affected |

Recommended scope: all six `appendEvent` call families that have no catch (`gate`, `card`, `sprint`, `update`),
because one handler at the top of `main` covers all of them and a per-command catch would leave a hole each time a
command is added. The regression test covers `gate request` and `card open`, as the PM asked; adding a case for each
other command is the EM's choice and costs one test each. The `run start` plain `Error` is a different class: it is
not caught by a `LogRefusedError` handler and is left out unless the PM widens the scope.

## Fix (proposed; the builder decides the code)

Lead from the strategist, checked: one handler of `LogRefusedError` works. At the head, `main` is synchronous
(`const main = () => {`), so a `try { main(); } catch (error) { ... }` around the call at `cli/index.ts:2206` sees
every throw from the `gate`, `card`, `sprint` and `update` branches. The `gate` branch's own `catch` rethrows a
non-`GateError`, so the error reaches the top. The `ingest` handler runs in an event callback with its own `catch`,
so it is not affected. Steps:

1. Catch only `LogRefusedError` (`error instanceof LogRefusedError`). Write the fixed line from the section above,
   then `process.exit(1)`. Rethrow any other error unchanged (no widening).
2. Do not print `error.message`, the `code`, the stack or any argument.
3. Do not call `warnLogRefused` for this (its once-per-process flag would hide the line if `logEvent` had already
   warned in the same process).
4. A catch only around the `gate` and `card` branches is the narrower alternative; it leaves `sprint` and `update`
   with the trace (see the table).

No change to `appendEvent`, to the refusal, or to `GateError` handling.

## Threat model

Does `specs/decision-alerts/threat-model.md` need a change? **Yes, for the architect to make; I did not edit it.**

- TH-7 residual 3 (line 191) says the four commands "still fail with an uncaught error, and its stack trace holds the
  path of the shard, or of `.project-log`, inside the project: task f6864c33". After the fix that sentence is wrong:
  close the bullet and name the fixed line.
- The F2 row mentions task f6864c33. It must say that the stack trace is gone and what the line holds.
- New, to check: the trace also holds the absolute path of the installed bundle (`file:///.../dist/project-
  companion.mjs`) and the Node version. The threat model names only the project path. If the architect wants it
  recorded as an information-disclosure point, it goes away with the fix.
- If the PM widens scope to `run start`, the D1 row and the same bullet need the new case.

## Regression test

`tests/bug-f6864c33.test.ts` (6 tests; built CLI in a child process with a 10 s timeout; temporary project and
temporary `HOME`; `CLAUDE_PROJECT_DIR` removed; `PROJECT_COMPANION_NOTIFY=off` is required by the file and set by the
runner):

1. `f6864c33: gate request after a planted own shard prints one plain line and exits non-zero`
2. `f6864c33: card open after a planted own shard prints one plain line and exits non-zero`
3. `f6864c33: gate request with a planted .project-log prints one plain line and writes nothing outside`
4. `f6864c33: card open with a planted .project-log prints one plain line and writes nothing outside`
5. `f6864c33: gate request and card open in a normal project still work, with no extra output (control)`
6. `f6864c33: a gate error that is not a log refusal keeps its own plain line (control)`

Tests 1 to 4 assert: exit code non-zero (and not a timeout); no line that starts with whitespace and `at `; no
`Node.js v` footer; exactly one non-empty stderr line; that line starts with `project-companion: ` and contains
`event log`; and stderr holds none of: the subject, the question, the outside target, the project path, the
repository path, the temporary root, `file://`, `.mjs`. The outside target file or folder is unchanged.

Commands and results at head 9fae5d9, before any fix:

```
npm test -- bug-f6864c33
```

Result: **2 of 6 passed.** Tests 1 to 4 fail, tests 5 and 6 (the controls) pass. A failure reads, for test 1:
`stderr must hold no stack frame ("    at "): "file:///.../dist/project-companion.mjs:1078\n  const notAFile = () => new
LogRefusedError(`Refused to write the event log: ${path} is not a regular file ... Remove it and try again.`);\n ^\n\nLogRefusedError: Refused to write the event log: /private/var/folders/.../.project-log/a4af7018f744.jsonl is not a regular file (bug 54b4e811). Remove it and try again.\n    at notAFile (...) ... Node.js v22.23.1\n"`.
The other three fail with the same trace (tests 3 and 4: `... is not a real folder ...`).

Not in the test, and why: `sprint`, `update` and `gate approve/refuse/track` (the PM named gate and card commands;
they share the same handler, so they are the EM's choice, one test each); `run start` (a different error class);
the Windows path (no `O_NOFOLLOW`; the refusal class is the same; not run here); the MCP server (not checked).

## Test rules (docs/test-rules.md)

1. Met: no notifier is reached; the file exits unless `PROJECT_COMPANION_NOTIFY` is `off`, and no env turns it on.
2. Met: the child's env is `{ ...process.env, HOME }`, so it keeps the runner's `off`.
3. Met: every child has a 10 s timeout; a hang gives exit -1, which the test treats as a failure.
4. Not applicable: no FIFO or endless read.
5. Met: new `mktemp -d` projects; temporary `HOME`; `CLAUDE_PROJECT_DIR` removed; no write to this repository's
   `.project` or the PM's index.
5a. Not applicable: no checksum of a shared file.
6. Not applicable to the spec; the builder's revert check, if any, must change behaviour in place.
7. Met: the probe scripts were kept in the scratchpad and are not committed; the `node_modules` link and `dist/` are
   ignored by git.
8. Met: the suite removes its temporary root at the end (`rmSync(TMP)`).
9. Met: the new error path (the line, the exit code, the two planted cases) has tests 1 to 4; the timeout has the
   10 s limit on each child.
