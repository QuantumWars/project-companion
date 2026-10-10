# Test rules

Read these before you write or change a test. In your hand-off, list each rule as met, not met, or not
applicable. The Engineering Manager adds a rule when a review finds a test problem that can happen again.

1. A test never reaches the real notifier. It calls `dispatch` or the notifier only with a path from
   `notifierPath(stubEnv(...))`, never with `NOTIFIER` or `notifierPath(process.env)`. (PR 10 security review,
   finding 1, TH-19.)
2. A suite that starts a child process spreads `process.env` into the child's `env`, so the child keeps the
   runner's `PROJECT_COMPANION_NOTIFY=off`. (PR 10 security review, finding 3, TH-19.)
3. A test never hangs. Put any read or call that can block in a child process with a timeout of a few seconds, so
   a failure is an assertion, not a stuck suite. CI stops the job after 15 minutes. (Bug 54b4e811 spec.)
4. To model a read that never ends, use a FIFO with no writer, not `/dev/zero`: a read of `/dev/zero` grows memory
   by gigabytes before a timeout ends it. (Bug 54b4e811 spec, measured by the qa-engineer.)
5. A test that runs the CLI or writes tracker files works in a new `mktemp -d` project. It never writes this
   repository's `.project` or `.project-log/`, and never the PM's `~/.claude/project-companion/index.json`.
   (Repo-upkeep spec RU-01.3; PR 10 security review, TH-20.)
6. A revert check restores the old behaviour in place and keeps every export. A whole-file revert fails at the
   esbuild bundle step and proves nothing. (PR 22 QA.)
7. A probe or scratch file made for a check stays out of every commit. (PRs 8 and 10.)
8. A test removes every temporary folder and file it makes, and resets any shared helper state. (Sprint 2026-w42
   retro: review sent back test-helper clean-up.)
9. Every timeout, size limit or error path in the code under change has a test that proves it. (Sprint 2026-w42
   retro: a missing timeout check and a missing test for a config error.)
