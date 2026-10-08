# Design: decision-alerts
Status: draft      Owner: architect      Date: 2026-10-08

Bottom line: after `gate request` or `card open` records a decision, the CLI reads that decision's title and
command from the cockpit model. Then it starts `/usr/bin/osascript` detached, with a fixed script and the text as
arguments after `--`. It writes one JSON line to `.project-notify/record.jsonl`, which never follows a symlink, and
returns. It does not wait for the notifier. A notifier problem never changes the command's exit code or standard
output. This is a mini design. Most of its length is the exact contract that the tests need (section 3.3).

Revision 2 (2026-10-08): this revision applies the security review `specs/decision-alerts/reviews/security.md`
(SR-1 to SR-13). The hand-off lists what changed for each finding.

## 1. Context and scope

Inputs: `specs/decision-alerts/requirements.md` (approved at the PRD gate on 2026-10-08, 17 criteria),
`specs/decision-alerts/reviews/testability.md`, `specs/decision-alerts/reviews/security.md`, `docs/prd.md` section
"Phase: Decision alerts", and `docs/ideas/0001-decision-alerts.md`.

Files read for this design: `cli/index.ts` (imports, `die()`, flag helpers, `main()`, the `gate` and `card` blocks,
the `cockpit` command), `lib/project/cockpit.ts` (whole file), `lib/project/gate.ts` (whole file),
`lib/project/events.ts` (whole file), `lib/project/decisions.ts` (`foldCards`), `lib/project/roadmap.ts`
(`readRoadmap`, writers), `lib/project/store.ts` (`readRuns`), `scripts/run-tests.mjs`, `tests/harness.ts`,
`tests/cli.test.ts` (head), `tests/gate.test.ts` (head and CLI section), `tests/devolps-phase3.test.ts` (CLI
helper), `.gitignore`, `package.json`, `README.md` section "Gates, sprints and the PM cockpit", `.claude/settings.json`,
`.claude/harness.json`.

Facts from the code that shape the design:
- Decisions are made in two places only: the `gate request` block and the `card open` block of `cli/index.ts`.
  `main()` is synchronous, and neither block calls `process.exit` on success.
- `buildCockpit` makes each decision's `title` and `command`. Gate ids are `gate:<kind>:<subject>`. Card ids are
  `c-` plus 6 hex characters. `readCockpit(root)` and the functions it calls only read files.
- `readCockpit` calls `readGates`, which hashes again every artifact of every approved gate (`hashArtifact`,
  `join(root, ref)`). `requestGate` already calls `readGates` after it records (`gate.ts:257`).
- The existing CLI suites run the CLI with the inherited environment (`tests/gate.test.ts`, `tests/cli.test.ts`) or
  with `{ ...process.env, ...env }` (`tests/devolps-phase3.test.ts`). So an off switch that the test runner sets
  reaches them.
- `scripts/run-tests.mjs` passes no `env` to each suite today.
- `lib/project/events.ts` already uses an environment variable seam: `PROJECT_COMPANION_ACTOR_EMAIL`.

Facts checked on this Mac (2026-10-08):
- macOS 27.0.1, Node v22.23.1. `/usr/bin/osascript` exists. `terminal-notifier` and `alerter`: not found (`which`).
- Without `--`, an osascript argument `-e` was read as an option, and the next argument became script source
  (osascript syntax error -2752). So `--` is required for DA-02.4.
- With `--`, a script that only returns the argument count and every argument (section 3.4) got every argument
  unchanged in 4 cases. The inputs put `-e`, `-l`, `JavaScript`, `-i` and a literal `--` first, in the middle, last,
  and repeated. They also held `"`, `\`, a line break and `do shell script "echo pwned"`. The EM ran a similar probe
  with 8 arguments, with the same result (security review, EM note).
- The pinned notification script (section 3.3) compiles with `osacompile`. It was not run, so no notification was
  shown.
- Node `spawn` of a missing or non-executable program: `child.pid` is `undefined` at once, and `error` is emitted
  later. `spawn` throws `ERR_INVALID_ARG_VALUE` at once when an argument has a NUL character.
- A child started with `detached: true, stdio: "ignore"` and `unref()` does not hold the caller's pipes. In a probe,
  `execFile` returned after 36 ms while a 3-second child still ran.
- Node file behaviour: `readFileSync` of a folder throws `EISDIR`. `openSync` with `O_NOFOLLOW` on a symlinked file
  throws `ELOOP`, and the target stays unchanged. `writeFileSync` with flag `wx` on a symlink (also a dangling one)
  throws `EEXIST`. `lstat` of a symlinked folder says `isDirectory() === false`. A file opened with mode `0o600` gets
  mode 600.
- A folder that holds a `.gitignore` with `*` is ignored in a new repository, and `git status` stays clean.
  `.project-notify/record.jsonl` is not ignored in this repository today.
- `getconf ARG_MAX` is 1048576 bytes. `csrutil status` says "enabled", and `/` is mounted sealed and read-only.

In scope: `lib/project/notify.ts` (new), `lib/project/notify-record.ts` (new), two call sites in `cli/index.ts`, the
`env` in `scripts/run-tests.mjs`, one line in `.gitignore`, one paragraph in `README.md`, and `tests/notify.test.ts`
(new). Not in scope: the MCP server (it has no tool that makes a decision), the cockpit page, the devolps plugin, and
the fix for unbounded artifact reads (SR-8, a separate bugfix; section 6).

## 2. Goals and non-goals

Goals (from the requirements):
1. One macOS notification for each gate request, question card and track card (DA-01.1, DA-01.2, DA-01.6).
2. The cockpit's own title, command and project name (DA-01.3).
3. Only `gate request` and `card open` notify, and only after they record a decision (DA-01.4, DA-01.5).
4. The notifier never fails, slows or changes the command, and never runs the text as code (DA-02.1 to DA-02.5).
5. An off switch, a runner that sets it, and nothing sent on other systems (DA-03.1 to DA-03.4).
6. A local, git-ignored record of each outcome (DA-04.1, DA-04.2).

Non-goals: all non-goals of the requirements. Also: no click action or sound on the notification, no
de-duplication, and no rotation of the record file.

## 3. Design

### 3.1 C4 context / container / component (Mermaid)

Context. The new part is the arrow to macOS.

```mermaid
flowchart LR
    PM([PM - person])
    EM([EM and role agents - Claude Code sessions])
    PC[project-companion - CLI and tracker files]
    MAC[macOS Notification Center - external system]
    EM -->|"gate request / card open (Bash)"| PC
    PC -->|"NEW: title, command, project, as arguments to osascript"| MAC
    MAC -->|"NEW: banner"| PM
    PM -->|"types /devolps:... in Claude Code"| EM
```

Container. New elements are marked NEW.

```mermaid
flowchart TB
    subgraph mac["PM's Mac, one user account"]
      EM([EM: Claude Code Bash tool])
      RUN["scripts/run-tests.mjs - sets PROJECT_COMPANION_NOTIFY=off"]
      subgraph pc["project-companion"]
        CLI["CLI process - Node, dist/project-companion.mjs"]
        LOG[(".project-log/*.jsonl - event log, committed")]
        PROJ[(".project and docs/prd.md - project name, roadmap")]
        ART[("artifact files named by approved gates")]
        REC[(".project-notify/record.jsonl - NEW, git-ignored")]
      end
      OSA["/usr/bin/osascript - NEW child process, detached"]
      NC["Notification Center - macOS"]
    end
    EM -->|argv, env| CLI
    RUN -->|env| CLI
    CLI -->|append event| LOG
    LOG -->|read| CLI
    PROJ -->|read| CLI
    ART -->|"read and hash (existing readGates)"| CLI
    CLI -->|"append one JSON line, no symlinks"| REC
    CLI -->|"spawn: argument list, no shell"| OSA
    OSA -->|display notification| NC
    CLI -->|"stdout unchanged, stderr one line on failure"| EM
```

Component.

```mermaid
flowchart LR
    subgraph cli["cli/index.ts"]
      GR["gate request block"]
      CO["card open block"]
    end
    subgraph notify["lib/project/notify.ts - NEW"]
      ND["notifyDecision(root, id, env)"]
      DT["decisionText(root, id)"]
      OUT["outcome precedence"]
      NP["notifierPath(env)"]
      ARGS["notifierArgs(text)"]
      DIS["dispatch(program, args)"]
    end
    subgraph rec["lib/project/notify-record.ts - NEW"]
      RP["recordPath(root)"]
      AR["appendRecord(root, line)"]
    end
    CK["lib/project/cockpit.ts - readCockpit"]
    GR --> ND
    CO --> ND
    ND --> DT --> CK
    ND --> OUT
    ND --> NP
    ND --> ARGS --> DIS
    ND --> AR --> RP
```

### 3.2 Sequences (Mermaid)

Flow 1: a gate request, with the notifier available.

```mermaid
sequenceDiagram
    autonumber
    actor EM as EM (Claude Code Bash)
    participant CLI as project-companion CLI
    participant LOG as .project-log/
    participant N as /usr/bin/osascript
    participant REC as .project-notify/record.jsonl
    participant NC as Notification Center
    actor PM
    EM->>CLI: gate request prd decision-alerts --prd-section decision-alerts
    CLI->>LOG: append gate.requested (requestGate)
    CLI-->>EM: stdout as today
    CLI->>LOG: readCockpit: events, .project, PRD, approved artifacts
    Note over CLI: find needsYou id "gate:prd:decision-alerts"
    CLI->>N: spawn detached, stdio ignore, argv = script lines, "--", title, command, project
    CLI->>REC: check folder, write .gitignore if absent, append line, outcome "sent"
    CLI-->>EM: exit 0 (does not wait for osascript)
    N->>NC: display notification
    NC-->>PM: banner (Focus rules apply)
    PM->>EM: types /devolps:approve prd decision-alerts
```

Flow 2: a card open, with each other outcome.

```mermaid
sequenceDiagram
    autonumber
    actor EM as EM (Claude Code Bash)
    participant CLI as project-companion CLI
    participant LOG as .project-log/
    participant N as notifier program
    participant REC as notification record
    EM->>CLI: card open --subject S --ask "..." [--json]
    CLI->>LOG: append card.opened (id c-xxxxxx)
    CLI-->>EM: stdout as today
    CLI->>LOG: readCockpit: title, command, project
    alt PROJECT_COMPANION_NOTIFY is "off"
        CLI->>REC: append line, outcome "off"
    else platform is not "darwin"
        CLI->>REC: append line, outcome "unsupported"
    else lookup failed, or notifier missing, not executable, or spawn throws
        Note over CLI,N: accessSync(X_OK) fails, so no process starts
        CLI->>REC: append line, outcome "failed", with reason
        CLI-->>EM: stderr "project-companion: notification not sent: (reason)"
    else notifier starts
        CLI->>N: spawn detached (no wait)
        CLI->>REC: append line, outcome "sent"
    end
    opt folder is not a real directory, or record is a symlink, or write fails
        CLI-->>EM: stderr "project-companion: notification record not written: (reason)"
    end
    CLI-->>EM: exit code as today in every branch
```

### 3.3 Data model and API contracts

**Entry point** (`lib/project/notify.ts`):

```ts
export type NotifyOutcome = "sent" | "off" | "unsupported" | "failed"; // defined in notify-record.ts
export const notifyDecision = (root: string, decisionId: string, env: NodeJS.ProcessEnv = process.env): NotifyOutcome
```

- It never throws, and it never writes to standard output. All of its work is inside one `try`/`catch`.
- `decisionId` is the cockpit's `needsYou[].id`: `gate:<kind>:<subject>` for a gate, or the card id for a card.
- Text: `decisionText(root, id)` calls `readCockpit(root)` and takes `needsYou.find((d) => d.id === id)`. It returns
  `{ title, command, project: model.project }`. When the id is not there, it throws (reason below). Using the
  cockpit model itself makes DA-01.3 true by construction.

**Call sites** (`cli/index.ts`). There are only two (DA-01.5):
- `gate request`: after `say(gate, …)`, call ``notifyDecision(root, `gate:${kind}:${subject}`)``.
- `card open`: after `process.stdout.write(…)`, call `notifyDecision(root, id)`.

Both calls come after the decision is recorded and after standard output is written. A refused input calls `die()`
before them (DA-01.4).

**Environment variables.** Each name is an exported constant. There is no record-path variable (SR-1).

| Variable (constant, module) | Values | Effect | Set by |
|---|---|---|---|
| `PROJECT_COMPANION_NOTIFY` (`NOTIFY_ENV`, notify.ts) | Exactly `off`, in lower case. Unset or any other value means on. Tests use `on`. | `off`: outcome `off`, no process starts. | PM, CI, `scripts/run-tests.mjs` |
| `PROJECT_COMPANION_NOTIFIER` (`NOTIFIER_ENV`, notify.ts) | An absolute path | The program to start in place of `/usr/bin/osascript`, with the same arguments. A path that is not absolute gives outcome `failed`. | Tests only |
| `PROJECT_COMPANION_PLATFORM` (`PLATFORM_ENV`, notify.ts) | Any string | The value to use in place of `process.platform`. Only `darwin` is supported. | Tests only |

**Notifier path.** `export const notifierPath = (env: NodeJS.ProcessEnv): string` returns
`env.PROJECT_COMPANION_NOTIFIER` when it is set and not empty, or `NOTIFIER` when it is not. It is pure, so the
TH-3 test calls it with no override and starts nothing (SR-6).

**Outcome precedence.** The first match wins. The text lookup runs first, so that `off` and `unsupported` lines
also carry the title and the command (DA-04.1).

| # | Condition | Outcome | Standard error |
|---|---|---|---|
| 1 | `env.PROJECT_COMPANION_NOTIFY === "off"` | `off` | none |
| 2 | `(env.PROJECT_COMPANION_PLATFORM \|\| process.platform) !== "darwin"` | `unsupported` | none |
| 3 | The text lookup failed | `failed` | the failure line |
| 4 | `notifierPath(env)` is not absolute, or `accessSync(path, constants.X_OK)` throws | `failed` | the failure line |
| 5 | `spawn` throws, or `child.pid === undefined` | `failed` | the failure line |
| 6 | Otherwise | `sent` | none |

**Notifier program and arguments.** This decision is recorded in
`docs/adr/0001-macos-notifier-osascript-argv.md` (ADR-0001, proposed). `NOTIFIER = "/usr/bin/osascript"`. The path
is absolute, so `PATH` is never searched (threat TH-3). `NOTIFY_SCRIPT` is these three lines, exactly:

```
on run argv
display notification (item 2 of argv) with title (item 1 of argv) subtitle (item 3 of argv)
end run
```

`notifierArgs({ title, command, project })` returns exactly these 10 items:

```ts
["-e", "on run argv",
 "-e", "display notification (item 2 of argv) with title (item 1 of argv) subtitle (item 3 of argv)",
 "-e", "end run",
 "--", title, command, project]
```

Layout: the notification title is the decision title (the bottom line first, as in the requirements' journey). The
subtitle is the project name. The body is the command, because the body wraps and an answer command can be long.
The command also shows the kind of decision: `/devolps:approve …` for a gate or a track, `/devolps:answer …` for a
question. No user text is ever put in the script. The `--` is required: without it, an argument that starts with
`-e` becomes script source (section 1).

**Dispatch** (`dispatch(program, args)` in notify.ts), in this order:

```ts
accessSync(program, constants.X_OK);            // throws: outcome "failed" (gives the reason at once)
const child = spawn(program, args, { detached: true, stdio: "ignore", shell: false, windowsHide: true });
child.once("error", () => {});                  // without a listener, a late 'error' would crash the CLI
if (child.pid === undefined) → "failed"
child.unref();                                  // the CLI exits without waiting (DA-02.3)
```

The child inherits the CLI's environment (threat model F3). `stdio: "ignore"` matters: a child that held the EM's
pipes would make Claude Code's Bash tool, and `execFile` in tests, wait for it.

**Record line** (`lib/project/notify-record.ts`). One line of JSON for each call of `notifyDecision`, written before
the CLI exits:

```json
{"id":"gate:prd:decision-alerts","at":"2026-10-08T09:30:00.000Z","title":"Approve the requirements for \"decision-alerts\"","command":"/devolps:approve prd decision-alerts","outcome":"sent"}
```

- The keys are in this order: `id`, `at`, `title`, `command`, `outcome`. The key `reason` follows only when
  `outcome` is `failed`. The example time is an example only.
- `at` is `new Date().toISOString()`. `title` and `command` are strings, or `null` when the text lookup failed.
- `JSON.stringify` escapes line breaks, so text cannot make a second line (TH-15).
- `NOTIFY_DIR = ".project-notify"` and `NOTIFY_RECORD = ".project-notify/record.jsonl"`, relative to the project
  root. `recordPath(root)` returns `join(root, NOTIFY_RECORD)`. Nothing can change this path.
- `readRecord(root)` returns the lines and skips any line that is not valid JSON. It is for tests and for the metric.
- The root `.gitignore` of this repository gets `/.project-notify/`, so that `git check-ignore` passes before the
  folder exists (DA-04.2).

**Record write** (`appendRecord(root, line)`), in this order. It throws on the first failure, writes nothing after
it, and the caller prints the "record not written" line (SR-3, SR-12):

1. `lstat` the folder `<root>/.project-notify`.
   - `ENOENT`: `mkdirSync(folder, { mode: 0o700 })`, not recursive. If that throws `EEXIST` (another process made it
     at the same time), `lstat` again once.
   - It exists, but `isDirectory()` is false (a symlink, a regular file or anything else): fail with reason
     `ENOTDIR <folder>`.
2. Write `<folder>/.gitignore` with the content `*\n` and flag `wx`. `EEXIST` is not a failure: the file, or a
   symlink with that name, is already there, and `wx` never follows it. Any other error: fail, and do not append.
   So the ignore file always comes before the first append.
3. `fd = openSync(record, O_WRONLY | O_APPEND | O_CREAT | (O_NOFOLLOW ?? 0), 0o600)`. A symlink at `record.jsonl`
   gives `ELOOP`, and nothing is written. `O_NOFOLLOW` does not exist in Node on Windows; there only step 1 guards.
4. `writeSync(fd, JSON.stringify(line) + "\n")`, then `closeSync(fd)` in a `finally`.

A same-user process that swaps the folder between step 1 and step 3 could already write the target file itself, so
the design does not guard that window (threat TH-21).

**Standard error lines** (exact prefixes, one line each, ending in `\n`):
- `project-companion: notification not sent: <reason>`, only for outcome `failed` (DA-02.2).
- `project-companion: notification record not written: <reason>`, when `appendRecord` throws (any outcome).

`<reason>` never uses `error.message`. It never contains the title, the command or the project name. It can contain
the decision id (for a gate, this holds the subject that the EM gave in the same command) and a path. After it is
built, each character from U+0000 to U+001F and from U+007F to U+009F becomes one space. The values are:

| Cause | `<reason>` |
|---|---|
| The text lookup threw | `lookup failed: <error.code or error.name>`, for example `lookup failed: EISDIR` |
| The decision is not in the cockpit | `not in the cockpit: <decision id>` |
| The notifier path is not absolute | `not an absolute path: <value>` |
| `accessSync` threw | `<error.code> <notifier path>`, for example `ENOENT /tmp/pc-x/missing` |
| `spawn` threw | `<error.code or error.name>`, for example `ERR_INVALID_ARG_VALUE` |
| No pid and no error | `did not start <notifier path>` |
| The folder is not a real directory | `ENOTDIR <folder path>` |
| A record step threw (`.gitignore`, open, write) | `<error.code or error.name> <path the code passed>`, for example `ELOOP /tmp/pc-x/.project-notify/record.jsonl` |
| Any other caught error | `<error.code or error.name>` |

The path in a reason is the path the code passed, never `error.path`.

**Test runner** (`scripts/run-tests.mjs`, the suite call at line 58):

```js
execFileSync(process.execPath, [bundle], { stdio: "inherit", cwd: ROOT, env: { ...process.env, PROJECT_COMPANION_NOTIFY: "off" } });
```

**README** (section "Gates, sprints and the PM cockpit"): add a paragraph that starts with `**Decision alerts.**`.
The DA-03.4 test reads the text from that line to the next line that starts with `**` or `## `. That text must hold
these 5 strings exactly: `gate request`, `card open`, `PROJECT_COMPANION_NOTIFY=off`, `macOS only` and
``exactly `off` ``. It should also name `.project-notify/record.jsonl`, but the test does not check that. The README
does not name the test overrides.

### 3.4 Components and paths

| Path | Change | Lines (estimate) |
|---|---|---|
| `lib/project/notify-record.ts` | New: constants, `recordPath`, `appendRecord` (safe write), `readRecord`, types | about 70 |
| `lib/project/notify.ts` | New: constants, `notifyDecision`, `decisionText`, `notifierPath`, `notifierArgs`, `dispatch`, reason building | about 120 |
| `cli/index.ts` | 1 import and 2 calls | about 4 |
| `scripts/run-tests.mjs` | `env` on the suite call | about 1 |
| `.gitignore` | `/.project-notify/` and a comment | about 3 |
| `README.md` | The "Decision alerts" paragraph | about 12 |
| `tests/notify.test.ts` | New suite for all 17 criteria and the threat tests | about 350, split across the tasks |

Proposed build tasks. These are proposals; the EM records them. Each task proves its criteria with
`npm test -- notify`.

| Task | Owner | Component | Criteria | Depends on |
|---|---|---|---|---|
| T1 | devops-sre | Test runner, `scripts/run-tests.mjs` | DA-03.2 (its named test is added in T2) | none |
| T2 | backend-engineer | Notification record, `lib/project/notify-record.ts`; starts `tests/notify.test.ts` with the `stubEnv` helper, the stub and the DA-03.2 test; tests for TH-13, TH-15, TH-21 | DA-04.2 | T1, open question 1 |
| T3 | backend-engineer | Notifier, `lib/project/notify.ts`, with in-process tests on a temporary project, the darwin-only osascript check, and tests for TH-3 and TH-5 | DA-02.2, DA-02.3, DA-02.4, DA-03.1, DA-03.3, DA-04.1 | T2 |
| T4 | backend-engineer | CLI, `cli/index.ts`, with CLI subprocess tests and the README test | DA-01.1, DA-01.2, DA-01.3, DA-01.4, DA-01.5, DA-01.6, DA-02.1, DA-02.5 | T1, T3 |
| T5 | tech-writer | README section "Gates, sprints and the PM cockpit" | DA-03.4 | Same pull request as T4 (constitution rule 12) |

Test seams. This table answers the testability review's list, "What the design must provide".

| Need | Seam | Criteria |
|---|---|---|
| A stub in place of the notifier | The `stubEnv(notifier)` helper (below) | DA-01.1, DA-01.2, DA-01.3, DA-01.6, DA-02.4 |
| A notifier that cannot start | `stubEnv("<tmp>/missing")` (gives `ENOENT`) | DA-02.1, DA-02.2 |
| A record that cannot be written | A regular file named `.project-notify` in the temporary project root (gives `ENOTDIR`, also when run as root) | DA-02.1 |
| No wait for the notifier | Detached dispatch. The stub waits while a hold file exists. | DA-02.3 |
| Arguments only | The stub saves its arguments, each one ending in a NUL character. There must be exactly 10, and items 0 to 6 must equal the fixed prefix. The darwin-only osascript check (below) is also required. | DA-02.4 |
| The platform | `PROJECT_COMPANION_PLATFORM=linux` and `=win32` | DA-03.3 |
| The off switch in the runner | The `env` in `scripts/run-tests.mjs`. The suite checks `process.env.PROJECT_COMPANION_NOTIFY === "off"`. | DA-03.2 |
| The record path | `NOTIFY_RECORD`, exported | DA-04.1, DA-04.2 |
| Exact keys, stderr text and README strings | Section 3.3 | DA-04.1, DA-02.2, DA-03.4 |
| The card id | `card open --json` prints `{"id":"c-…"}` (this exists today) | DA-01.3 |

Test notes for the QA engineer:
- **One helper turns notifications on (SR-6, TH-19).** `stubEnv(notifier: string)` returns
  `{ ...process.env, PROJECT_COMPANION_NOTIFY: "on", PROJECT_COMPANION_PLATFORM: "darwin", PROJECT_COMPANION_NOTIFIER: notifier, STUB_OUT, STUB_HOLD }`.
  It throws when `notifier` is empty or not absolute. The suite sets `PROJECT_COMPANION_NOTIFY=on` in no other way,
  and it never changes `process.env`. In-process calls pass the same object as `env`. So no test can reach the real
  notifier, on the PM's Mac or on Linux.
- **The stub** is a `#!/bin/sh` file that the suite writes to a temporary folder (mode 755). It runs
  `printf '%s\0' "$@"` into `$STUB_OUT/<pid>.tmp`, then renames that file to `<pid>.argv`. If `$STUB_HOLD` is set, it
  waits while that file exists. Then it writes `<pid>.done`. The stub gets `STUB_OUT` and `STUB_HOLD` because the
  child inherits the CLI's environment.
- **A record line is the witness.** The record line is written before the CLI exits, and only `notifyDecision`
  writes it. So "no new record line" after a command proves that no notification was dispatched, with no wait
  (DA-01.4, DA-01.5, DA-03.1). The stub writes after the CLI exits, so to read the stub's output the suite waits for
  the file, with a guard timeout that the QA engineer chooses. That timeout is a failure guard, not a requirement.
- **DA-02.1** compares standard output with an `off` run. Text output is fixed. Before comparing, remove
  `requestedAt` from `gate request --json` output, and replace `c-[0-9a-f]{6}` in `card open` output. For the record
  failure, write a regular file named `.project-notify` in the project root first. Expect standard error
  `project-companion: notification record not written: ENOTDIR <root>/.project-notify`.
- **DA-02.4, stub part.** The card question starts with `-e` and has `"`, `\`, a line break and
  `" & (do shell script "touch PWNED") & "`. Expect exactly 10 arguments: items 0 to 6 equal the fixed prefix, item 7
  equals the question, and no `-e` value contains it.
- **DA-02.4, real osascript part (required, SR-5).** Test name: `DA-02.4: osascript passes every argument after -- unchanged`.
  It is skipped only when the platform is not `darwin` or `/usr/bin/osascript` is absent. It runs
  `/usr/bin/osascript` with this script, which only returns text and shows nothing:

  ```
  on run argv
  set AppleScript's text item delimiters to (character id 31)
  return ((count of argv) as text) & (character id 31) & (argv as text)
  end run
  ```

  Each script line is passed with `-e`, then `--`, then the inputs. The test splits the output (minus its final line
  break) on U+001F, and expects the count and every argument to equal the inputs. It runs 4 input lists, each with
  `-e`, `-l`, `JavaScript`, `-i` and a literal `--`: flags first; flags in the middle; flags last; and
  `["--", "-e", "return 1", "--", "-l", "JavaScript", "-i", "--"]`. The other inputs are `x"y\z` + line break +
  `next line`, `do shell script "echo pwned"` and `" & (do shell script "echo pwned") & "`. This script passed all 4
  lists on this Mac (section 1).
- **TH-3.** `notifierPath({})` equals `"/usr/bin/osascript"`, and `notifierPath({ PROJECT_COMPANION_NOTIFIER: "/x" })`
  equals `"/x"`. Nothing is spawned.
- **TH-5, NUL.** Write a project name that has a NUL character (`\u0000` in `.project`). Expect
  `project-companion: notification not sent: ERR_INVALID_ARG_VALUE`, and expect that the name is not in standard
  error.
- **TH-5, lookup (SR-4).** Request and approve a gate on `docs/a.md`. Replace that file with a folder. Run `card open`
  with `stubEnv`. Expect exactly one standard error line,
  `project-companion: notification not sent: lookup failed: EISDIR`, and exit code and standard output as with
  `off`. This test depends on how `hashArtifact` reads files today. The SR-8 bugfix will change it, and must update
  this test.
- **TH-21 (SR-3).** Make `.project-notify/` a real folder, and make `record.jsonl` a symlink to a file outside the
  project. Run `card open`. Expect the target unchanged, exit code and standard output as with `off`, and standard
  error `project-companion: notification record not written: ELOOP <root>/.project-notify/record.jsonl`. Repeat with
  `.project-notify` itself as a symlink to a folder outside the project: expect the outside folder unchanged and the
  reason `ENOTDIR <root>/.project-notify`.
- **TH-13 order (SR-12).** After the first append, `.project-notify/.gitignore` holds `*\n`. When `.gitignore` is
  a dangling symlink, the append still happens and the symlink target is not created.

## 4. Alternatives considered

| Alternative | Why not chosen |
|---|---|
| `terminal-notifier` (Homebrew) | Not installed on this Mac (`which`: not found). The PM would have to install and update it. It is a third-party binary that would receive agent-written text. Its extra features (click actions, grouping) are non-goals. |
| The `node-notifier` npm package | It adds a dependency that vendors a notifier binary into `node_modules`. That is a supply-chain risk for text that agents write. It gives nothing that this slice needs. |
| AppleScript built by string interpolation, with escaping | DA-02.4 forbids relying on escaping. One missed case (a quote, a backslash, `-e`) runs `do shell script` as the PM. |
| Notify from inside `appendEvent` | It would catch every future source of decisions. But it ties a side effect to every event write, including ingest, approvals and the in-process library tests. DA-01.5 would need a filter in the log layer. |
| A long-running watcher on `.project-log/` | It needs a process that always runs. Timed or background reminders are non-goals. |
| A pure `needsYouFrom(...)` taken out of `buildCockpit`, in place of `readCockpit` | It is cheaper per call, and it would skip the artifact re-hash (SR-8). But it refactors the cockpit, and the SR-8 bugfix fixes the reads for `gate request` too. `readCockpit` gives the same text as `cockpit --json` with no refactor. Revisit if the EM reports a slow command. |
| A bare `osascript` found on `PATH`, with tests putting a stub first on `PATH` | `npx` and `npm run` put `node_modules/.bin` first on `PATH`, so a package could supply an `osascript` (TH-3). An explicit absolute path is safer. |
| A platform seam injected in-process only | The CLI is tested as a subprocess (DA-03.3 compares exit code and output), so the seam must reach the subprocess. |
| A record-path variable, honoured only inside `<root>/.project-notify/` (SR-1) | A regular file named `.project-notify` gives the same test with no variable. Less surface. |
| The kind of decision as a 4th argument, in the subtitle (SR-10) | The command in the body already shows the kind: `/devolps:approve` for a gate or a track, `/devolps:answer` for a question. A card cannot approve a gate. A 4th argument changes the script and the tests and adds no new fact. |
| An off switch that trims and ignores case (SR-11) | DA-03.1 names the value `off`. The variable is set by scripts and settings, not typed often. The README says "exactly `off`", and the DA-03.4 test checks that wording. |
| The record in `.project-log/` or `.project-cache/` | The PM chose a local, git-ignored file (Q5). The README says that deleting `.project-cache/` may only change latency. |

## 5. Cross-cutting concerns

- **Security.** See `specs/decision-alerts/threat-model.md`. The main controls: a fixed script, text passed only as
  arguments after `--`, `shell: false`, an absolute notifier path, a record write that never follows a symlink, a
  reason text that never uses `error.message`, and a notify path that never throws. One test override can start any
  program (TH-2). The threat model accepts this, with its reason, for the PM to decide at the design gate. The
  record-path override was removed (SR-1).
- **Privacy.** The notification shows decision text on screen. It can appear on the lock screen and during screen
  sharing, and macOS keeps its own copy (TH-6). The record holds the same text, with mode 600 in a folder with mode
  700. It stays on this Mac and is ignored by git twice (the root `.gitignore` and the folder's own `.gitignore`).
- **Observability.** The record is the evidence for the first success metric. `sent` means that osascript started;
  it does not prove that the PM saw the banner. A failure gives one standard error line, which the EM reports. An
  agent can silence its own alert with the off switch or the platform variable (TH-20). So the first-sprint metric
  review lists every `off` and `unsupported` line from the PM's Mac as a miss, with its decision id.
- **Cost.** No money and no new dependency. For each decision command: one more `readCockpit` (time UNKNOWN, not
  measured), one record append, and one short-lived osascript process (time UNKNOWN; not run, because running it
  shows a notification). The off switch does not skip the cockpit read, because the record needs the text.
- **Accessibility.** macOS shows the notification. VoiceOver and the system display settings apply to it. The text
  is plain words. The command is plain text that the PM can read out and type. No meaning is carried by colour.

## 6. Rollout and rollback

1. Merge order: T1 (the runner's off switch) must merge before T4 (the CLI calls). Without T1, `npm test` on the PM's
   Mac sends real notifications from `tests/gate.test.ts` and `tests/devolps-phase3.test.ts`.
2. After T4 merges and `dist/` is rebuilt, the next real `gate request` or `card open` on the PM's Mac shows a
   notification. There is no flag and no staged rollout: this is one user on one Mac.
3. First-run check (manual, because a test cannot see a notification): the PM confirms that the first real banner
   appears. If it does not appear, the PM looks in System Settings, Notifications, for the app that macOS lists for
   osascript. Which app macOS 27.0.1 names, and whether it asks for permission first, is UNKNOWN.
4. Rollback without code: set `PROJECT_COMPANION_NOTIFY=off` where the EM's commands get their environment. For
   example, the PM adds it to the `env` block of `.claude/settings.json` (only the PM edits `.claude/`). This stops
   the banners, but not the text lookup. Rollback with code: revert T4. That removes the 2 calls, and the new library
   files stay unused.
5. Known problem, not fixed in this epic (SR-8): the text lookup re-hashes every approved artifact, and an artifact
   path from a merged log can name a very large file or a device such as `/dev/zero` (`join(root, ref)` accepts
   `..`). Then the command is slow without limit, or never ends. `gate request` already has this problem
   (`gate.ts:257`). With T4, `card open` gets it too. The off switch does not avoid it, so the rollback is to revert
   T4. The fix is a separate bugfix: accept only artifact paths and a PRD source that are regular files inside the
   project root.
6. The record file can be deleted at any time. That only loses metric history.

## 7. Open questions

1. For the EM, who takes it to the PM: no role in `.claude/harness.json` lists `.gitignore` in its write scope, and
   the plugin defaults are UNKNOWN to me. Who adds `/.project-notify/`? Without it, the DA-04.2 test fails in this
   repository until the folder exists.
2. For the PM, at rollout: the app name that macOS 27.0.1 shows for osascript notifications, and whether it asks for
   permission first, is UNKNOWN. A manual check is in section 6, step 3.
3. For the QA engineer: the time that `readCockpit` adds to `gate request` and `card open` is UNKNOWN. Measure it if
   the EM reports slowness. The fallback is the `needsYouFrom` refactor (section 4), or the SR-8 bugfix.

Requirements covered: DA-01.1, DA-01.2, DA-01.3, DA-01.4, DA-01.5, DA-01.6, DA-02.1, DA-02.2, DA-02.3, DA-02.4, DA-02.5, DA-03.1, DA-03.2, DA-03.3, DA-03.4, DA-04.1, DA-04.2

| ID | Where the design meets it |
|---|---|
| DA-01.1 | `gate request` call site; outcome `sent` (3.3) |
| DA-01.2 | `card open` call site, for question and track cards (3.3) |
| DA-01.3 | `decisionText` reads `readCockpit` `needsYou` and `project` (3.3) |
| DA-01.4 | Calls come after `requestGate` or `appendEvent`; `die()` exits before them (3.3) |
| DA-01.5 | Only the two call sites; the MCP server makes no decisions (1, 3.3) |
| DA-01.6 | One call for each command, no de-duplication, limit or delay (2, 3.3) |
| DA-02.1 | `notifyDecision` never throws or writes stdout; record errors are caught (3.3) |
| DA-02.2 | `project-companion: notification not sent: <reason>`, with the reason table (3.3) |
| DA-02.3 | Detached spawn, `stdio: "ignore"`, `unref()` (3.3) |
| DA-02.4 | Fixed `NOTIFY_SCRIPT`, 10 arguments, text after `--`, `shell: false`, and the required osascript check (3.3, 3.4, TH-1) |
| DA-02.5 | notify.ts and notify-record.ts do not import `appendEvent` (3.4, TH-16) |
| DA-03.1 | Precedence row 1, exactly `off` (3.3) |
| DA-03.2 | `env` in `scripts/run-tests.mjs` (3.3) |
| DA-03.3 | Precedence row 2, `PROJECT_COMPANION_PLATFORM` (3.3) |
| DA-03.4 | `**Decision alerts.**` paragraph with 5 exact strings (3.3) |
| DA-04.1 | Record line with exact keys and 4 outcomes (3.3) |
| DA-04.2 | `.project-notify/`, self-ignoring, plus the root `.gitignore` entry (3.3) |
