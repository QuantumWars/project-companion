# QA report: bdcf995e (da-t7) — Notify the PM from gate request and card open

Story: `specs/decision-alerts/stories/da-s6-notify-new-decision.md` (da-s6), epic decision-alerts, feature
decision-notify. Pull request #17, branch `feat/bdcf995e-notify-cli`. Head commit:
`eff502ceb502b05d3cc02616e5bb49d187eacb33`.

The PR's code change (`gh pr view 17 --json files`): `cli/index.ts` +3/-0 (one import, two `notifyDecision`
calls), `tests/notify.test.ts` +170/-1, `README.md` +17/-0 (the "Decision alerts" paragraph), `docs/prd.md`
+2/-2 (two ticks), `.project` +30/-23 and `.project-log/2d96e8e4849c.jsonl` +296/-0 (tracker files, not part of
this QA's scope). This matches the task brief's description.

Reviews (`gh pr view 17 --comments`): one review on `91f5282` — 0 high, 1 medium, 7 low; code review pass with
one medium in the CLI test helper; security review (P1, P2, P3, E3; TH-6 to TH-11, TH-16, TH-19) no blockers.
The medium (test clean-up miscounted stub runs when the record could not be read) and all seven lows (DA-02.5
and DA-03.4 test strength, HOME isolation, README wording) were fixed in `b4fea31` and `4ddf4f5`, merged at
`f9bf9e7`; head `eff502c` only adds tracker bookkeeping after that. The EM's follow-up comment on `eff502c`
reports `lint 0, typecheck 0, npm test 0 (22 suites, 443 ok), npm test -- notify 39/39` — credited to the EM,
not re-run here for lint and typecheck per the task rule.

## Checkout and setup

My first worktree copy was removed mid-task by the coordinator's environment refresh. Per the task's fallback
rule I made a fresh one: `git worktree add --detach <scratch path> eff502c`, then `git switch feat/bdcf995e-qa`
inside it (the branch already existed, unmodified, from before the removal). `npm ci` was run once in this copy
(502 packages). `git status --short` was empty in this worktree before and after every check below — all
mutant testing happened in a second, separate scratch copy outside both the worktree and the main checkout, so
the tracked copy was never touched.

## Showing the tests can fail

To show the eight named tests can actually fail, not just pass, I copied `lib/`, `cli/`, `tests/`, `types/` and
`README.md` into `/private/tmp/.../scratchpad/qa-bdcf995e/` (outside the repository, never committed;
`node_modules` symlinked from the worktree for build-time module resolution only — the suite's own files have no
npm-package imports, so this affects only the build tool, not the bundle). A small `run.mjs` there (also never
committed) bundles `cli/index.ts` to `dist/project-companion.mjs` and `tests/notify.test.ts` with esbuild, the
same way `scripts/run-tests.mjs` does, then runs the bundle with `PROJECT_COMPANION_NOTIFY=off`.

The unmutated control gave 38/39 (exit 1): only `DA-04.2` fails outside a git checkout (`git check-ignore`
needs a `.git`), which is expected and matches the precedent in `docs/qa/02d2e84e.md`. That confirms the scratch
copy reproduces the in-repo behaviour before trusting any mutant's result. I then applied three mutants, one at
a time, rebuilding and rerunning between each, and restored the unmutated source after each run (confirmed with
`diff` against the worktree's own copy):

1. **Remove the `card open` notify call** — deleted `notifyDecision(root, id);` from the `card open` handler in
   `cli/index.ts`. Result: 34/39, exit 1. `DA-01.2` fails (`stub calls: expected 1, got 0`), plus `DA-01.3`,
   `DA-01.5` and `DA-02.5` as side effects (the card-open leg of each disappears too).
2. **Move the `gate request` notify call before `requestGate`** — in the same file, swapped the order so
   `notifyDecision` runs before the gate is recorded (and before `requestGate`'s own validation can refuse).
   Result: 33/39, exit 1. `DA-01.4` fails (`readRecord(root)` gained a `failed` line for the refused
   `design alerts` request, which the criterion forbids), plus `DA-01.1`, `DA-01.3`, `DA-01.6` and `DA-02.5`
   (the gate's id is not yet in the cockpit when the notifier runs, so every gate-request case now resolves
   `failed`/`not in the cockpit` instead of `sent`).
3. **Drop "macOS only" from the README's Decision-alerts paragraph** — changed "are macOS only" to "work on any
   system" in the scratch `README.md` only. Result: 37/39, exit 1. Only `DA-03.4` fails beyond the expected
   `DA-04.2` (`not in the Decision alerts paragraph: expected [], got ["macOS only"]`) — isolated, as expected,
   since no code changed.

Together the three mutants make all eight named tests fail at least once. None of the three mutants touch
`dispatch`, `notifierPath`, `NOTIFIER` or which program starts: every call that reaches `notifyDecision` in the
suite still passes `stubEnv(...)`, whose notifier is always the suite's own stub inside its temp folder, so no
mutant run started `/usr/bin/osascript` with the display script.

Task: bdcf995e     Criteria: DA-01.1, DA-01.2, DA-01.3, DA-01.4, DA-01.5, DA-01.6, DA-03.4, DA-02.5 (at the CLI)     Result: pass

| Criterion | Test(s) | Size | Result | Evidence |
|---|---|---|---|---|
| DA-01.1 (gate request → one notification) | `DA-01.1: gate request passes one notification` | small | pass | `npm test -- notify` → `ok`. Can fail: mutant 2 (notify moved before `requestGate`) → 33/39, exit 1: `expected [0,""], got [0,"project-companion: notification not sent: not in the cockpit: gate:prd:alerts\n"]`. |
| DA-01.2 (card open → one notification) | `DA-01.2: card open passes one notification for a question card and for a track card` | small | pass | `npm test -- notify` → `ok`. Can fail: mutant 1 (card-open call removed) → 34/39, exit 1: `stub calls: expected 1, got 0`. |
| DA-01.3 (notification text equals the cockpit's) | `DA-01.3: each notification holds the cockpit's title, command and project name` | medium | pass | `npm test -- notify` → `ok`. Can fail: mutant 1 → `card open ... stub calls: expected 1, got 0`; mutant 2 → `gate request prd alerts ...: expected [0,""], got [0,"project-companion: notification not sent: not in the cockpit: gate:prd:alerts\n"]`. Both legs of this test (gate and card) are separately shown to fail. |
| DA-01.4 (refused input → none) | `DA-01.4: a refused gate request or card open passes no notification` | small | pass | `npm test -- notify` → `ok`. Can fail: mutant 2 → `readRecord(root)` gained a `failed` line for the refused `design alerts` request (missing artifact), where the criterion expects `[]`. |
| DA-01.5 (only these two commands notify) | `DA-01.5: approve, refuse, track, answer, status and cockpit pass no notification` | small | pass | `npm test -- notify` → `ok`. Can fail: mutant 1 → `expected ["off","off","off"], got ["off","off"]` (the card-open leg of the fixture's three decisions silently dropped its record line). |
| DA-01.6 (one notification per decision) | `DA-01.6: five requests in a row pass five notifications` | small | pass | `npm test -- notify` → `ok`. Can fail: mutant 2 → `expected [[...,"sent"]×5], got [[...,"failed"]×5]`. |
| DA-03.4 (README names the commands, the off switch, macOS only) | `DA-03.4: README names the commands, the off switch and macOS only` | small | pass | `npm test -- notify` → `ok`. Can fail: mutant 3 (README string dropped in the scratch copy only) → `not in the Decision alerts paragraph: expected [], got ["macOS only"]`, with no other test affected. |
| DA-02.5 at the CLI (notifier appends no event, on and off) | `DA-02.5: gate request and card open log the same events with the notifier on and off` | medium | pass | `npm test -- notify` → `ok`. Can fail: mutant 1 → `expected ["sent,sent,sent","off,off,off"], got ["sent","off"]`; mutant 2 → `expected ["sent,sent,sent","off,off,off"], got ["sent,sent,failed","off,off,off"]`. |

## Commands run

- `git worktree add --detach <scratch path> eff502c` then `git switch feat/bdcf995e-qa` → both exit 0 (fresh
  worktree, made after the original copy was removed mid-task).
- `npm ci` (in the worktree) → exit 0 (502 packages).
- `uname -a` → Darwin, arm64, Darwin 27.0.0. `test -x /usr/bin/osascript` → present.
- `npm test -- notify` (in the worktree, in-repo build) → exit 0, `39/39 passed`, every named test `ok`.
- `git status --short` (in the worktree) → empty, before and after every check in this report.
- `gh pr view 17 --json files` → the file list and +/- counts quoted above.
- `gh pr view 17 --comments` → one review (1 medium, 7 low, 0 high) and one fix-confirmation comment with the
  EM's `lint 0, typecheck 0, npm test 0 (22 suites, 443 ok), npm test -- notify 39/39`.
- 4 scratch builds outside the repository (esbuild, never committed, `node_modules` symlinked for build-time
  resolution only, each output bundle self-contained): control → 38/39, exit 1 (only `DA-04.2`, expected, no
  `.git` there); mutant 1 (card-open call removed) → 34/39, exit 1; mutant 2 (notify moved before
  `requestGate`) → 33/39, exit 1; mutant 3 (README string dropped) → 37/39, exit 1. Each mutated file was
  restored to the unmutated source immediately after its run, and the restored copy was `diff`-checked byte for
  byte against the worktree's own copy.

## Supporting checks (not themselves one of the eight criteria)

- No mutant, and no test in the suite, changed `process.env`, used a path outside `stubEnv(...)`'s temp folder,
  or passed the display-notification script to `/usr/bin/osascript`. The CLI itself (`dist/project-companion.mjs`)
  was never run outside the test suite, and no `notifyDecision`/`dispatch` call in any run used an env other than
  one built by `stubEnv(...)`.
- The call sites read in `cli/index.ts` (head `eff502c`) match design 3.3: `notifyDecision(root, \`gate:${kind}:${subject}\`)`
  at the end of `gate request`, after `requestGate` and after `say()` writes stdout; `notifyDecision(root, id)`
  at the end of `card open`, after `appendEvent` and after stdout — both comments in the source are tagged
  `DA-01.1` / `DA-01.2` respectively, matching the criteria table.
- The README's "Decision alerts" paragraph (lines 201–216) was read directly and contains `gate request`,
  `card open`, `PROJECT_COMPANION_NOTIFY=off`, "macOS only" and "exactly `off`" — the same five strings
  `DA-03.4`'s test checks for — under the "## Gates, sprints and the PM cockpit" heading.

## Not tested, and why

- `npm run lint` and `npm run typecheck`: not run in this copy, per the task rule; credited to the EM's report
  on `eff502c` (`lint 0, typecheck 0`).
- DA-02.1 to DA-02.4, DA-03.1 to DA-03.3, TH-3, TH-5, TH-8, TH-13, TH-15, TH-19, TH-21, DA-04.2: in the suite but
  outside this task's criteria table (da-t5/da-t6's criteria, already QA'd in `docs/qa/02d2e84e.md` and earlier
  reports); read here only as context for the mutants' side effects, not independently re-verified.
- The full `npm test` (all 22 suites, 443 tests outside `notify.test.ts`): not re-run in this copy; relied on
  the EM's reported `0 failures` on `eff502c`, since this task's scope is the `notify` suite only.

Result: pass
