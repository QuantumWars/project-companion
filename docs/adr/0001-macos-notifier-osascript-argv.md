# ADR-0001: Send decision alerts through /usr/bin/osascript, with the text as arguments only

Status: Proposed (it becomes Accepted when the PM approves the design gate for `decision-alerts`)
Date: 2026-10-08 (revised the same day for the security review, SR-5 and SR-6)
Epic: decision-alerts
Design: `specs/decision-alerts/design.md`. Threat model: `specs/decision-alerts/threat-model.md`.

## Context

The tracker must show a macOS notification for each new decision (DA-01). The title and the command come from text
that agents write, and that text can carry instructions from outside content. The notifier must deliver that text
unchanged and run no part of it as code (DA-02.4). It must never fail, slow or change the command (DA-02.1,
DA-02.3).

Checked on this Mac on 2026-10-08:
- macOS 27.0.1. `/usr/bin/osascript` exists. `terminal-notifier` and `alerter` are not installed (`which`).
- osascript gives arguments after `--` to `on run argv` unchanged. Quotes, backslashes, line breaks, AppleScript
  text, `-e`, `-l`, `JavaScript`, `-i` and a literal `--` all arrived unchanged, first, in the middle, last and
  repeated (4 cases; the EM ran a fifth probe with 8 arguments, with the same result).
- Without `--`, an argument that starts with `-e` is read as an option, and the next argument becomes script source.
- System Integrity Protection is enabled, and `/` is mounted sealed and read-only.

This is hard to reverse for two reasons. The argument contract is what the tests and the threat model rely on. The
choice also sets which app macOS lists for these notifications, and so which settings the PM must find.

## Decision

1. The notifier program is the absolute path `/usr/bin/osascript`. `PATH` is never searched.
2. The script is a constant with 3 lines:
   `on run argv` / `display notification (item 2 of argv) with title (item 1 of argv) subtitle (item 3 of argv)` /
   `end run`. Each line is passed with `-e`.
3. The decision title, the command and the project name follow `--`, in that order, as separate arguments. They are
   never put into script source.
4. The CLI starts it with `spawn(…, { detached: true, stdio: "ignore", shell: false })`, adds an `error` listener,
   and calls `unref()`. It does not wait.
5. A pure function `notifierPath(env)` picks the program: `PROJECT_COMPANION_NOTIFIER` when it is set (tests only,
   an absolute path), or `/usr/bin/osascript`. A stub gets the same 10 arguments.
6. A required test, on darwin only, runs the real `/usr/bin/osascript` with a script that only returns the argument
   count and every argument. Its inputs put `-e`, `-l`, `JavaScript`, `-i` and a literal `--` at several positions.
   It shows nothing on screen.

## Alternatives

- `terminal-notifier` (Homebrew). Not installed here. The PM would have to install and update a third-party binary
  that receives agent-written text. Its extra features (click actions, grouping) are non-goals.
- The `node-notifier` npm package. It vendors a notifier binary into `node_modules`, which adds supply-chain risk
  and gives nothing that this slice needs.
- AppleScript built by string interpolation, with escaping. One missed escape runs `do shell script` as the PM. DA-02.4
  forbids relying on escaping.
- A bare `osascript` found on `PATH`. `npx` and `npm run` put `node_modules/.bin` first on `PATH`, so a package could
  supply its own `osascript`.

## Consequences

- No new dependency. It works on any macOS that has `/usr/bin/osascript`. Other systems record `unsupported`.
- macOS attributes the notification to an app that it chooses for osascript. Which app macOS 27.0.1 names, and
  whether it asks for permission on first use, is UNKNOWN. The PM checks this at rollout.
- The notification has no click action. The PM decides only by typing the command in Claude Code, as the
  requirements say.
- If a later macOS changes how osascript reads `--`, DA-02.4 breaks. The required darwin-only test (decision 6)
  catches such a change on the PM's Mac.
- The test override can start any program. The threat model accepts this as TH-2, for the PM to decide at the
  design gate.
- To change the notifier later, write a new ADR that supersedes this one. Do not edit this ADR after it is accepted.
