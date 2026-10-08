# Testability check: Decision alerts requirements

Commit checked: 2597ed6 (branch docs/decision-alerts-requirements)
Reviewer: qa-engineer agent, stage prd. Saved by the Engineering Manager.

> **EM note (2026-10-08).** The qa-engineer's hand-off said "10 of 20 criteria". The requirements have 17 criteria
> (DA-01.1 to DA-04.2), and the table below has 17 rows. The count is corrected to 17. The EM re-checked these
> claims: `scripts/run-tests.mjs` passes no `env` to the suites; `node scripts/run-tests.mjs notify` exits 1 with
> "No test file matches "notify""; `card open --json` already prints `{"id": …}` (`cli/index.ts`, card open).

Verdict: no criterion is untestable. 10 of 17 criteria are testable only with an assumption: each needs a design
seam or an exact token that the design stage must pin. The other 7 are testable as written. `npm test -- notify`
forwards `notify` to `scripts/run-tests.mjs`, which selects any `tests/*.test.ts` file whose name contains
`notify`. Today that is zero files (expected before the build), so the command exits 1. It will select
`tests/notify.test.ts` once that file exists.

| ID | Testable | Reason | Proposed rewrite |
|---|---|---|---|
| DA-01.1 | with assumption | Needs a stub that stands in for the real macOS notifier; `lib/project/notify.ts` does not exist yet (expected at PRD stage) and no seam for test substitution is named. | Add one line: "The design shall let a test replace the system notifier with a stub that records each call, without changing `gate request` or `card open`'s observable behaviour." (Already implied by the Context section; make it a criterion so it is tracked, not just prose.) |
| DA-01.2 | with assumption | Same stub-notifier dependency as DA-01.1. | Same as DA-01.1. |
| DA-01.3 | with assumption | Comparison is possible (stub text vs `cockpit --json`'s `needsYou[].title`/`.command` and `.project`), but for a card the id is a random `c-xxxxxx` generated at `card open` time, so the test must read the id from `card open`'s own stdout/`--json` to look up the matching `needsYou` entry before asserting equality. Workable, but the requirement does not say the CLI must expose the new id so a test can correlate it. | Add: "`card open` shall print the new card's id (as it does today in `--json`), so a test can find the matching `needsYou` entry." |
| DA-01.4 | yes | `die()` (stderr + exit 1) and `GateError` both run before `appendEvent`, confirmed by reading `cli/index.ts` and `lib/project/gate.ts`; "records nothing" is the same `readEvents` count before/after. No design seam needed beyond the stub notifier already required by DA-01.1. | — |
| DA-01.5 | yes | Every command the test notes list (`approve`, `refuse`, `track`, `card answer`, `gate status`, `cockpit`) is a distinct, already-existing code path that does not call `appendEvent` with a `gate.requested`/`card.opened` kind. Stub call count is directly observable. | — |
| DA-01.6 | yes | "One notification per decision, with no limit/delay/quiet hours of its own" is testable as "5 requests → exactly 5 stub calls, each matching one decision, with no dedup/throttle" — no timing number required, matching the test notes' pattern for DA-02.3. | — |
| DA-02.1 | with assumption | Test notes name the technique ("a notifier path that does not exist, and a record path that cannot be written") but nothing in the requirements says the notifier binary path or the record file path is overridable by a test. Without an override, a test cannot force "cannot start" or "cannot be written" deterministically on a shared CI machine. | Add: "The design shall let a test override the notifier program's path and the notification record's path, so a test can force each failure deterministically." |
| DA-02.2 | with assumption | Exit code/stdout comparison is clean (DA-02.1's seam makes this testable too), but "says no notification was sent and why" has no exact wording, so the test can only assert a substring the author chooses. | Add a required substring or token, e.g.: "...shall write one line to standard error containing the word `notify` (or `notification`) and the underlying error message." |
| DA-02.3 | with assumption | Test notes name a synchronization technique (stub blocks until released) with no timing number — good — but this only works if the design dispatches the notifier as a true detached subprocess that the CLI does not `await`. That is a design choice, not stated as a requirement. | Add: "The design shall dispatch the notifier without the CLI command awaiting its completion (e.g. a detached/unref'd child process), so a test can prove the command exits before a blocked stub resolves." |
| DA-02.4 | with assumption | "reaches the system notifier only as an argument, never inside script source" needs the test to inspect the literal argv array (not a shell string) that would be passed to the real notifier. That needs a seam where the stub captures `argv`, not a concatenated command line. | Add: "The design shall invoke the system notifier with an argv array (no shell interpolation), and the test stub shall capture that array unchanged." |
| DA-02.5 | yes | `readEvents(root)` before/after is a clean, already-existing primitive; no new seam needed. | — |
| DA-03.1 | yes | Setting `PROJECT_COMPANION_NOTIFY=off` in the child process's `env` (as `tests/cli.test.ts` already does for `cwd`) and asserting zero stub calls is straightforward. | — |
| DA-03.2 | yes, but currently false | Testable as "the suite reads `process.env.PROJECT_COMPANION_NOTIFY === 'off'`" — but `scripts/run-tests.mjs`, read at this commit, calls `execFileSync(process.execPath, [bundle], { stdio: "inherit", cwd: ROOT })` with no `env` override at all, so today nothing sets the switch. This is a build task already flagged by the PRD's "Paths: ... scripts/run-tests.mjs", not a testability defect — flagging so it isn't missed. | None needed; confirm `scripts/run-tests.mjs` is in scope for the design/build (it already is, per `docs/prd.md`). |
| DA-03.3 | with assumption | `process.platform` is read-only process state; the requirement does not say how a test fakes "a system other than macOS." Node allows `Object.defineProperty(process, "platform", ...)` in-process, but only if the design reads `process.platform` through an injectable function rather than hard-coding it, or the test runs the built CLI as a subprocess with some override flag/env var. | Add: "The design shall read the current platform through a seam a test can override (e.g. an env var or injected function), so a test can simulate `linux` and `win32` without a real machine of that kind." |
| DA-03.4 | with assumption | "shall name the commands... the off switch... and the supported systems" has no exact tokens, so a test can only assert chosen substrings (e.g. the literal strings `gate request`, `card open`, `PROJECT_COMPANION_NOTIFY`, `macOS`). Workable, but any later edit of the README's wording that keeps the same meaning could still fail a strict test. | Add the exact tokens the test must find, e.g.: "...shall contain the strings `gate request`, `card open`, `PROJECT_COMPANION_NOTIFY=off` and `macOS only`." |
| DA-04.1 | with assumption | Plain English names the facts to record (id, time, title, command, outcome) but not the JSON key names, so the test must invent `id`/`ts`/`title`/`command`/`outcome` or similar. Different test authors could pick different keys, silently drifting from the eventual design. Also, producing a true `sent` outcome depends on the same stub-notifier seam as DA-01.1 (a stub that reports success). | Add the field names, e.g.: "...one JSON line with the keys `id`, `at`, `title`, `command`, `outcome`." |
| DA-04.2 | yes | `git check-ignore -v <path>` is a clean, already-available check (confirmed: `.project-cache/` is ignored, `.project-log/` deliberately is not, per `.gitignore`); the only dependency is that the record path is a fixed, importable constant once built — a build detail, not a testability gap. | — |

## What the design must provide, for the tests above

- A way to swap the real macOS notifier for a stub, without changing `gate request`'s or `card open`'s own stdout/exit code (DA-01.1, DA-01.2, DA-01.6, DA-02.4).
- A way to force the notifier to fail to start, and a way to force the notification record write to fail, both independently of each other and deterministically (not by relying on OS state) (DA-02.1, DA-02.2).
- A dispatch model where the CLI command does not wait for the notifier subprocess to finish, so a test can prove non-blocking behaviour with a stub that blocks until released, and no sleep/timing number (DA-02.3).
- Invocation of the notifier with an argv array, not a shell string, so hostile text (quotes, backslashes, line breaks, AppleScript) is captured unchanged and never concatenated into script source (DA-02.4).
- A seam to read "which platform is this" that a test can override to simulate `linux` and `win32` on this (or any) machine (DA-03.3).
- `scripts/run-tests.mjs` passing `PROJECT_COMPANION_NOTIFY=off` in the child process's `env` for every suite it runs (DA-03.2) — currently it passes no `env` override at all (confirmed by reading the file at this commit).
- A fixed, importable path (or well-known constant) for the notification record file, so `git check-ignore` and content checks don't need to guess a path (DA-04.1, DA-04.2).
- Exact JSON field names for the notification-record line, and an exact required substring for the DA-02.2 stderr line and the DA-03.4 README check, so two test authors converge on the same assertion.

No numbers were invented. DA-02.3's "no timing number is needed" is taken from the requirements doc itself (test notes), not assumed.

## Files read

- `specs/decision-alerts/requirements.md`
- `docs/prd.md` (section "Phase: Decision alerts")
- `docs/ideas/0001-decision-alerts.md`
- `cli/index.ts` (gate command block, card command block, `die()`, `--json` wiring, cockpit command)
- `lib/project/cockpit.ts` (full file: `CockpitModel`, `DecisionItem`, `GATE_TEXT`, `buildCockpit`, `readCockpit`)
- `lib/project/gate.ts` (`requestGate`, `approveGate`, `GateError`, `foldGates`, `readGates`)
- `lib/project/events.ts` (`appendEvent`, `readEvents`, `LOG_DIR`)
- `tests/gate.test.ts` (head, to see existing test idioms)
- `tests/harness.ts` (full file: `test`, `eq`, `ok`, `throws`, `runAll`)
- `tests/cli.test.ts` (head, to see how the built CLI is run as a subprocess in tests)
- `scripts/run-tests.mjs` (full file)
- `package.json` (full file, `test` script)
- `README.md` (section "Gates, sprints and the PM cockpit")
- `.gitignore` (entries for `.project-cache/`, `.project-log/`)
- `tests/` directory listing (confirmed no `notify*.test.ts` exists yet)

## Checks run

- `npm test -- notify` → exit 1, "No test file matches "notify"" (expected: `tests/notify.test.ts` does not exist yet at this commit; confirms the command's substring-selection mechanism works and will pick up the suite once it is added).
- `git check-ignore -v .project-cache/x` → matched (ignored).
- `git check-ignore -v .project-log/x` → not matched (not ignored), confirming the "outside `.project-cache/` and `.project-log/`" distinction in DA-04.2 is real in this repo.
