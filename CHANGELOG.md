# Changelog

This file lists what changed in each release of project-companion, in plain language.
See `docs/releases/` for the full release notes.

## 0.3.0 — 2026-10-10

### Added
- Decision alerts: on macOS, `gate request` and `card open` each send one system
  notification with the decision's title, its command and the project name.
- An off switch for decision alerts: `PROJECT_COMPANION_NOTIFY=off` turns them off for a
  shell; the value must be exactly `off`.
- A notification record: each attempt (sent, off, unsupported or failed) adds one line to
  the git-ignored `.project-notify/record.jsonl`.
- CI on every pull request: `npm ci`, a type check, the test suite and `build:tools` run
  automatically. Adds the `typecheck` script.

### Security
- The notifier passes decision text only as command arguments, never through a shell, so
  it cannot be used to run other commands.
- The notifier is invoked by its absolute path, so it cannot be swapped by changing
  `PATH`.
- The notification record file is written in a way that is safe even if a symlink is
  placed where the record file is expected.
- A notifier problem is designed not to change the command's exit code or its output,
  and writes up to two lines to standard error; the test suite cannot reach the real
  notifier.

### Known issues
- SR-8: the artifact text lookup used by `gate request` and now also `card open` can be
  slow without limit, because it accepts a path that leaves the project root (for example
  `..`) and a merged log can name a very large file or a device. Tracked as bug d5ebde85,
  owner: Engineering Manager.

## 0.2.0 — 2026-10-07

Added the gate engine, track decisions and JSON reads for devolps (commit 790cc3a). Not
tagged.
