# Bug: CLI test suites write the PM's real project index

## Observed

Five test suites start the built CLI (`dist/project-companion.mjs`) with the real environment. The CLI adds every
project it touches to the index under `HOME`, so each temporary test project lands in the PM's real
`~/.claude/project-companion/index.json`.

Code path (checked): `cli/index.ts:717` (`init`) and `cli/index.ts:754` (every other command, "Touching a project
is what puts it in the index") call `registerProject`. It is `lib/project/registry.ts:146`. It writes
`globalIndexPath()`, which is built from `homedir()` (`registry.ts:75-85`), so `HOME` decides which index is
written. `registry.ts:210` also hooks `registerProject` to `onProjectMoved`; no suite reaches that hook
in-process (see the table: `bundle` calls `migrateProject` and adds nothing).

How the suites start the CLI (checked by reading):

- `tests/cli.test.ts:36`: `execFile` with only `cwd`, so the child inherits the real env.
- `tests/gate.test.ts:243,248`: same, only `cwd`.
- `tests/merge.test.ts:88-90`: `execFileSync` with `cwd` and `stdio`, no `env`.
- `tests/sync.test.ts:80,105,212,229,251`: the CLI path is built in each test; same shape.
- `tests/devolps-phase3.test.ts:272`: the `pc` helper passes `env: { ...process.env, ...env }`, so the real `HOME`.

The other suites that start the CLI already do what test rule 5 asks: `bug-37f9fbce` (temporary HOME per project,
`CLAUDE_PROJECT_DIR` removed), `bug-ee2e49d6` and `notify` (own HOME in a temp folder, `CLAUDE_PROJECT_DIR` removed).

Measured (see Fix, "Measurement"): running each suite alone against the PM's real index, the five suites above
added 11 + 6 + 8 + 2 + 5 = 32 entries, named `pc-cli-*`, `pc-p3-*`, `pc-gate-*`, `a`/`b` (the merge suite's two
clones), and `pc-sync-*`. No other suite changed the index. The tracker's earlier figure (2,420 entries, 2,399
temporary) is not re-measured here; the index held 3,669 entries when my measurement began.

Second risk, not observed to cause damage: the same five suites pass any `CLAUDE_PROJECT_DIR` through to the CLI.
`findProject` (`lib/project/store.ts:129`) uses `from ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd()`, so a
set `CLAUDE_PROJECT_DIR` is looked at before the working folder. Claude Code sets it for hooks and agent
sessions. In the shell I measured from it was empty, so I could not show a wrong-project run. The claim is
true by the code only.

## Expected

`docs/test-rules.md` rule 5: a test that runs the CLI works in a new `mktemp -d` project and never writes the
PM's `~/.claude/project-companion/index.json`; a CLI child gets `env: { ...process.env, HOME: <temp folder> }` with
`CLAUDE_PROJECT_DIR` removed, as the `cli` helper in `tests/notify.test.ts` does.

Requirement ID: **UNKNOWN**. Stand-ins: test rule 5 (from repo-upkeep spec RU-01.3, PR 10 security review TH-20),
and finding 2 of the PR 26 code review. I did not find an EARS criterion for this in `specs/`; the PM or
architect should say whether RU-01.3 is the right ID to cite.

## Steps to reproduce

1. Count the entries (`projects` array length) of `~/.claude/project-companion/index.json` and save the sorted paths.
2. Run `npm test -- cli.test` (or `gate.test`, `devolps-phase3`, `merge.test`, `sync.test`).
3. Count again and compare the sorted path list (the checksum is not reliable: another process rewrites the
   index). The count is higher by the number of temporary
   projects the suite made (`pc-cli-*` and so on, now gone from disk but still in the index until a read prunes them).

For the regression test: `npm test -- bug-e17ca1c9`.

## Root cause

Nothing makes a suite safe by default. Each suite must remember to give its CLI children a temporary `HOME` and drop
`CLAUDE_PROJECT_DIR`. Three suites do; five do not. Test rule 5 is written down, but `scripts/run-tests.mjs` sets
only `PROJECT_COMPANION_NOTIFY=off` for the child, so a suite that forgets silently uses the PM's real home.
Registration is by design: the CLI must index what it touches. The bug is in the test environment, not in
`registerProject`.

## Fix

Built: **option (c)**, the runner gives every suite a temporary `HOME` and no `CLAUDE_PROJECT_DIR`.

What was built (commit 9a02466, `scripts/run-tests.mjs`, 11 lines added and 2 removed; checked by reading it):
`mkdtempSync` makes one `pc-tests-home-*` folder in `tmpdir()` before the loop. Each suite child gets
`env: { ...env without CLAUDE_PROJECT_DIR, HOME: <folder>, USERPROFILE: <folder>, PROJECT_COMPANION_NOTIFY: "off" }`
(`USERPROFILE` is for Windows, where `homedir()` reads it). The existing `finally` removes the folder. The five
offender suites are unchanged. `docs/test-rules.md` rule 5 has a note about it. The changelog was not changed,
because it holds only release notes. The build step keeps the real env.

In `scripts/run-tests.mjs`: make one `mkdtemp` folder (inside `tmpdir()`) before the loop; pass the child
`env: { ...envWithoutClaudeProjectDir, HOME: <that folder>, PROJECT_COMPANION_NOTIFY: "off" }`; remove the folder
in the existing `finally`. Add a one-line note to test rule 5 (the runner now does this; a suite that sets its own
`HOME` still works). The build step (`build-tools.mjs`) can keep the real env.

Cost and checks:

- Size: about 8 changed lines in `scripts/run-tests.mjs` and about 3 in `docs/test-rules.md` and the changelog. Basis:
  one `mkdtempSync` and one `rmSync` line, one destructure and one env line, plus imports. This is an estimate,
  not measured. The regression test (about 90 lines) is already written here, so the fix pull request is under 100 lines.
- Does any suite need the real HOME (git config, npm cache)? I checked by measurement: with the whole suite
  run under a temporary `HOME` and no `CLAUDE_PROJECT_DIR` (a throwaway script outside the repo that starts
  `npm test` with that env), all 30 existing suites passed (`rc 0`, none failed). `git`
  suites set their own identity per repo. So (c) is safe on this machine. Not checked: CI (a macOS runner, `macos-latest`); if CI
  has no `HOME` the same fix still sets one.
- One side effect: a suite that runs `git commit` without setting an identity would fail on a machine whose only identity is in
  `~/.gitconfig`. None does today.

Why not the others:

- (a) Run every other suite's helpers in a sandbox and compare the index: needs the test to know every helper; it
  would be a second copy of each suite's CLI start. Weak, and hard to keep current.
- (b) A static scan that fails when a test file starts the CLI without `HOME`: a text check. It fails on `execFile`
  written in a way the pattern misses, and it does not stop a new suite doing the wrong thing in a new way. It
  also fails on correct suites that set `HOME` through a helper. It could be added later as a second guard, not instead.

Confirmed offender suites (all five need no change when (c) lands; they get the safe env from the runner):
`tests/cli.test.ts`, `tests/devolps-phase3.test.ts`, `tests/gate.test.ts`, `tests/merge.test.ts`,
`tests/sync.test.ts`. Running a suite outside the runner (for example `node` on a bundle by hand) still uses the real HOME;
the regression test refuses to start the CLI in that case.

### Measurement

Each suite was run once alone with `npm test -- <name>.test` ("git" via `git.test`; `run.test` also matched
`agent-run.test`, which was measured on its own too). Checksum is the first 12 characters of `shasum`. Other
processes were writing the index at the same time: the checksum changed between my first look
(`7129c95f9694`, 2,420 entries by the tracker) and my first measured run (`2615192700de`, 3,669 entries), before I
had run anything. During the measurement, the entry counts were continuous from suite to suite, and the newest
entries match each offender's folder prefix (listed above), so the added entries are the suites' own. I did not
repeat the five offender suites, to keep the number of entries added low.

| Suite | Before | After | Entries added |
|---|---|---|---|
| agent-run-paths | 2615192700de (3669) | same | 0 |
| agent-run | 2615192700de (3669) | same | 0 |
| append-shard | 2615192700de (3669) | same | 0 |
| bug-15753492 | 2615192700de (3669) | same | 0 |
| bug-37f9fbce | 2615192700de (3669) | same | 0 |
| bug-54b4e811 | 2615192700de (3669) | same | 0 |
| bug-d5ebde85 | 2615192700de (3669) | same | 0 |
| bug-ee2e49d6 | 2615192700de (3669) | same | 0 |
| bundle | 2615192700de (3669) | same | 0 |
| catalog | 2615192700de (3669) | same | 0 |
| **cli** | 2615192700de (3669) | 8e184f52f448 (3680) | **11** |
| component | 5ba4bea32667 (3680) | same | 0 |
| delete | 5ba4bea32667 (3680) | same | 0 |
| deps | 5ba4bea32667 (3680) | same | 0 |
| **devolps-phase3** | 5ba4bea32667 (3680) | a548779932de (3686) | **6** |
| drilldown | a548779932de (3686) | same | 0 |
| events | a548779932de (3686) | same | 0 |
| flow | a548779932de (3686) | same | 0 |
| **gate** | a548779932de (3686) | b35beef68716 (3694) | **8** |
| git | b35beef68716 (3694) | same | 0 |
| **merge** | b35beef68716 (3694) | 193912e68d47 (3696) | **2** |
| notify | 193912e68d47 (3696) | same | 0 |
| prd-edit | 193912e68d47 (3696) | same | 0 |
| prd | 193912e68d47 (3696) | same | 0 |
| review | 193912e68d47 (3696) | same | 0 |
| roadmap | 193912e68d47 (3696) | same | 0 |
| run | 193912e68d47 (3696) | same | 0 |
| safe-file | 193912e68d47 (3696) | same | 0 |
| **sync** | 193912e68d47 (3696) | a0ebe44cf8c2 (3701) | **5** |
| verify | a0ebe44cf8c2 (3701) | same | 0 |

Total added by the measurement: **32 entries** (3,669 to 3,701). I deleted none. `bug-e17ca1c9` was not in this
table: it is the regression test and does not touch the real index.

## Regression test

`tests/bug-e17ca1c9.test.ts`, 4 tests. It guards the whole class (option c): it checks the runner's environment,
then proves the effect with a CLI child started the way the offending suites start it.

- `e17ca1c9: the runner gives this suite a temporary HOME, not the real one` (small)
- `e17ca1c9: the runner removes CLAUDE_PROJECT_DIR for this suite` (small)
- `e17ca1c9: a CLI child with the runner's env cannot reach the real index` (medium: makes a temp git repo, runs
  `init` and `status`, checks the index is under the temporary HOME). It refuses to start the CLI unless `HOME` is
  temporary, so the failing run cannot add an entry to the PM's index.
- `e17ca1c9: this suite did not add its project to the real index` (small: looks for test 3's probe folder in the real
  index, found through the passwd entry, not `$HOME`; a missing file counts as not listed. It replaces a checksum
  comparison, which failed whenever another session rewrote the index)

Before the fix (`npm test -- bug-e17ca1c9`; 2 of 4 fail; exit code 1):

```
bug-e17ca1c9.test.ts
  FAIL e17ca1c9: the runner gives this suite a temporary HOME, not the real one
       HOME is "/Users/doniel": it must be a temporary folder, not the real home "/Users/doniel". scripts/run-tests.mjs must set HOME to a temporary folder for every suite.
  ok   e17ca1c9: the runner removes CLAUDE_PROJECT_DIR for this suite
  FAIL e17ca1c9: a CLI child with the runner's env cannot reach the real index
       not run: HOME is not temporary, so starting the CLI could add an entry to the real index
  ok   e17ca1c9: this suite did not change the real index

2/4 passed
```

The second test passes before the fix in my shell, because `CLAUDE_PROJECT_DIR` was empty there. It fails in a
Claude Code session that sets it. The pass side is checked: with the suite started under a temporary `HOME` and no
`CLAUDE_PROJECT_DIR` (a throwaway script outside the repo, the effect of the fix), it gives 4/4 passed.

After the fix (head 814e817, `npm test -- bug-e17ca1c9`): 4/4 passed, exit code 0. Full result and evidence:
`docs/qa/e17ca1c9.md`.

Checking the fix end to end (PM): read `~/.claude/project-companion/index.json` and save the entry count (the
`projects` array length) and the sorted list of project paths. Run a full `npm test`. Read the index again. The
count and the path list must be the same. Do not compare checksums: another process rewrites the index, so the
checksum changes without the tests. Before the fix, the same procedure adds entries.

Not tested, and why: the second risk (a wrong project chosen through `CLAUDE_PROJECT_DIR`) is covered only as an
environment assertion, because I could not show a failing run without a set variable. Cleaning the 2,000+ stale
entries from the real index is out of scope: that is the PM's home folder.
