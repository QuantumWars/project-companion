Task: 37f9fbce     Criteria: run-attribution (docs/prd.md:222)     Result: pass

Head: `56fef4c920465a01a1742c40b9787f1f6d33db26`. Track: Bugfix. Spec: `specs/bugs/37f9fbce/bugfix.md`.
CI: not checked (no pull request yet).

| Criterion / spec part | Test(s) | Size | Result | Evidence |
|---|---|---|---|---|
| Expected: a commit matching a run's files and window attributes to that run's task (the same as the app's Git view) | `tests/bug-37f9fbce.test.ts` "(control): linkRepository WITH runs attributes the commit" | medium | pass | `npm test -- bug-37f9fbce` -> 3/3 passed |
| Expected: `git log` shows the `run` signal | same file, "`git log` never shows the run signal" | large (built CLI, temp git repo) | pass | same command; fails without the fix (below) |
| Expected: `git unlinked` does not list a commit a run covers | same file, "`git unlinked` must not list a commit a run already covers" | large | pass | same command; fails without the fix (below) |
| Fix: `runGit` passes `readRuns(root)` as the fifth argument (`cli/index.ts:515`) | the two CLI tests above; end-to-end check below | large | pass | revert check and end-to-end run below |
| Fix: MCP `git_log` passes `readRuns(root)` (`mcp/server.ts:897`) | none | - | not tested | code read only; task 2cb8cdff |
| No regression elsewhere | `npm test -- cli`, `-- git`, `-- run`, `npm test`, `npm run typecheck` | small to large | pass | see below |

## Commands run (in a copy at 56fef4c)

- `npm ci --ignore-scripts` -> done.
- `npm test -- bug-37f9fbce` -> 3/3 passed.
- `npm test -- cli` -> 12/12 passed. `npm test -- git` -> 42/42 passed. `npm test -- run` -> 21/21 passed.
- `npm test` (every suite) -> exit 0, 29 suites, each "N/N passed", no FAIL line, about 46 seconds.
- `npm run typecheck` -> exit 0.

## Before the fix

A throwaway copy outside the repo, with `cli/index.ts` taken from 495a8b9 and every other file from 56fef4c.
The diff 495a8b9..56fef4c in `cli/index.ts` is the one line at 515, so the copy differs only by the fix.
`npm test -- bug-37f9fbce` -> 1/3 passed: the control passes; the `git log` test fails ("expected run, got -");
the `git unlinked` test fails (the commit was listed). Not run at the merge base itself.

## Revert check (test rule 6)

In place in the worktree: only the `readRuns(root)` argument removed at `cli/index.ts:515`, every export kept.
`npm test -- bug-37f9fbce` -> 1/3 passed (both CLI tests FAIL, control ok). Restored with `git checkout cli/index.ts`;
then `npm test -- bug-37f9fbce` -> 3/3 passed. (Until the rebuild, `dist/` held the reverted bundle. A first
end-to-end attempt used it and showed the bug; I rebuilt before the real check.)

## End-to-end check

A script outside the repo, in a `mktemp -d` git project, with a temporary `HOME`, `CLAUDE_PROJECT_DIR` unset, and the
built `dist/project-companion.mjs`. Steps: `init`; `task add "Rotate keys" --status in_progress`;
`run start <task> --session s1`; `ingest` of one PostToolUse payload (`tool_input.file_path` = `lib/token.ts`,
relative; absolute paths are bug 15753492); sleep 2 s; commit `lib/token.ts`; then:

- `project-companion git log` -> `3384759  run       Rotate keys                        Rotate the token`
- `project-companion git unlinked` -> `Every recent commit is linked.`

With the reverted bundle (first attempt) the same steps gave signal `-` and the commit in `git unlinked`.
Both temporary folders were removed.

## MCP `git_log`

`mcp/server.ts:892-899` calls `linkRepository(repo, readTasks(root).tasks, readRoadmap(root).features, limit ?? 50, readRuns(root))`.
So the tool now passes the runs. No test runs it. I did not run the MCP server.

## Test rules (docs/test-rules.md)

1. Real notifier: met (no notifier env in the new test or in my run).
2. Child env spreads `process.env` unless `stubEnv`: met (the new test's `execFile` children inherit the runner env).
3. A test never hangs: met for the suite (about 46 s). The new test's children have no explicit timeout; it has no blocking read.
4. FIFO for endless reads: not applicable.
5. Temp project, temp HOME, `CLAUDE_PROJECT_DIR` removed: not met in the new test. It uses a temp project, but it does not set `HOME` or remove `CLAUDE_PROJECT_DIR` for its CLI children. A CLI child can then add the temp project to the PM's `~/.claude/project-companion/index.json`, and can find the real project when `CLAUDE_PROJECT_DIR` is set. My end-to-end run met this rule. I did not check the real index after the test run.
6. Revert check in place, exports kept: met.
7. Scratch files out of commits: met (script in the scratchpad).
8. Test removes its temp folders: met by reading (`finally` cleanup); not checked at run time.
9. Every timeout, limit or error path has a test: not applicable (the change adds none).

Not tested, and why:
- MCP `git_log` passing runs: no test (task 2cb8cdff).
- CI: no pull request yet.
- A real harness run with an absolute `touched` path: still not matched; that is bug 15753492, out of scope.
- The merge base itself (only the fix line was undone in a copy).

Result: pass
