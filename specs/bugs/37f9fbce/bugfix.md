# Bug: CLI `git log` and `git unlinked` never attribute commits to agent runs

## Observed

`runGit` (`cli/index.ts:515`), which backs both `project-companion git log` and `project-companion git
unlinked`, calls:

```ts
const linked = await linkRepository(repo!, readTasks(root).tasks, roadmap.features, limit);
```

`linkRepository` (`lib/project/git-link.ts:298`) takes a fifth, optional argument, `runs: readonly
AttributableRun[] = []`. The CLI never passes it, so every call from the CLI runs with `runs = []`.
`attribute` (`git-link.ts:167`, called from `linkRepository`) tries signal 2 (the run signal, `runFor`,
`git-link.ts:141`) against that empty list, which can never match anything. So the CLI does not fail to find
a matching run -- it never tries. The only caller that passes `runs` is the app's Git view, `readGitView`
(`lib/project/git-view.ts:87`):

```ts
attribution = await linkRepository(repo, tasks, features, options.limit, runs);
```

where `runs` is `readRuns(root)` (`git-view.ts:79`). `cli/index.ts` already imports `readRuns` (line 41, used
at lines 1122 and 1907 for `run list` and elsewhere) -- it is in scope at the `git log`/`git unlinked` call
site and simply isn't passed.

Found by the qa-engineer while writing the regression test for bug 15753492 (agreed track: Bugfix, PM
2026-10-10); the EM checked the line numbers above against this checkout. 15753492's own spec
(`specs/bugs/15753492/bugfix.md`, written on `fix/15753492-spec`) names this exact gap in its "Root cause"
section as "related, but not the cause" and defers it here.

## Expected

PRD feature `run-attribution` (`docs/prd.md:212-224`, id `run-attribution`):

> The fifth and second-strongest signal: a commit of files a run was watched writing, inside the window it
> was open. This is what makes attribution work without the trailer.

Criterion (`docs/prd.md:222`): "A commit matching a run's files and window attributes to that run's task."
`Verify: npm test -- agent-run`.

The feature names no surface -- it is a property of attribution itself, not of the app alone. `git log` and
`git unlinked` are the CLI's only two windows onto attribution (there is no `--json` or other reader of
`AttributionResult` in the CLI), so a commit that matches a run's files and window must attribute to that
run's task there too, the same as it does in the app's Git view. Today the PRD checklist marks this criterion
`[x]` (done) on the strength of the app's codepath alone; the CLI's codepath has never exercised it, which
this checklist entry does not say.

## Steps to reproduce

1. In a project inside a git repository, start a run against a task and have it report a file it wrote
   (`project-companion run start <taskId> --session s1`, then feed `project-companion ingest` a `PostToolUse`
   hook payload naming that file -- or let a real harness session do both).
2. Commit that same file, after the run started.
3. Run `project-companion git log` (or `git unlinked`).

Observed result: the commit's `signal` column shows `-` (no signal matched) in `git log`, and the commit
appears in `git unlinked`'s list -- even for a run/commit pair that `lib/project/git-view.ts`'s call (the
app's Git view) attributes correctly, because the CLI's call never receives `runs` at all. This reproduction
does not depend on bug 15753492: see "Regression test" below for a fixture whose run already holds paths
relative to the project root (the form 15753492's fix produces), which isolates this bug from that one.

## Root cause

`runGit` (`cli/index.ts:501-538`) was written, and has stayed, with only four arguments at its one call to
`linkRepository` (line 515). `readRuns` is already imported and already used elsewhere in the same file
(lines 41, 1122, 1907), so this is not a missing capability -- the call site simply never reads `readRuns(root)`
and passes it through. `lib/project/git-view.ts`'s `readGitView` (the app's only caller) was written correctly,
passing `runs` at line 87; nothing enforces that the CLI's call do the same, and it does not.

## Fix

In `runGit` (`cli/index.ts:515`), add `readRuns(root)` as the fifth argument:

```ts
const linked = await linkRepository(repo!, readTasks(root).tasks, roadmap.features, limit, readRuns(root));
```

`readRuns` is already imported; no new import, no signature change to `linkRepository`, no change to
`attribute`'s run-matching logic (`git-link.ts:141-165`), which already defends against an empty or
non-matching run list by returning `undefined`. The CLI's two reads of attribution (`git log`'s `linked`,
`git unlinked`'s `linked.unattributed`, both derived from the one call) get this for free from the same
change, since both currently share the single call at line 515.

**Relation to bug 15753492**: independent, and buildable/mergeable in either order.

- This fix changes only which arguments the CLI passes to `linkRepository`; it does not touch how a run's
  `touched` paths are stored (that is 15753492's `reportRun`, `lib/project/store.ts:1482`) or how they are
  matched (`runFor`, `git-link.ts:141`, unchanged by this fix). Passing a run list that `runFor` was always
  going to reject (today's real, absolute-path runs, per 15753492's root cause) is harmless: the behaviour for
  every run logged today stays exactly what it is now (no signal-2 match), because `runFor`'s own
  `commit.paths.some((path) => run.touched.includes(path))` check already returns `false` for an absolute
  `run.touched` entry, with or without this fix.
- Evidence this fix alone is safe and sufficient to merge first: the regression test's control
  (`37f9fbce (control): linkRepository WITH runs attributes the commit, same as the app's Git view`) proves
  the match succeeds once `runs` is passed, using a fixture whose run already holds a *relative* path (the
  form 15753492's fix will produce) -- without touching `reportRun` or any of 15753492's code. The two
  CLI-driven tests in the same file prove today's CLI (with this fix not yet applied) shows neither that
  signal nor that match. Once this fix lands, those two tests will pass for that same fixture, independent of
  whether 15753492 has shipped.
- What 15753492 adds on top: today, even after this fix ships, a *real* harness run (whose `touched` paths
  are absolute, per 15753492) still will not match a commit through the CLI, for the same reason it does not
  match through the app today -- 15753492's bug, not this one. Shipping this fix first makes the CLI consistent
  with the app's (also currently broken, for real runs) behaviour; shipping 15753492 first or second then makes
  both consistent and correct. Either order reaches the same end state; this fix depends on nothing from
  15753492's diff and introduces no conflict with it (different files: `cli/index.ts` here, `lib/project/
  store.ts` and optionally `lib/project/git-link.ts` there, per 15753492's "Open for the PM" section).

**Line estimate**: about 1 changed line in `cli/index.ts` (the one call site; `readRuns` is already imported,
so no import line changes). Basis: `grep -n "readRuns" cli/index.ts` on this checkout shows the import at
line 41 and two other call sites already using it (1122, 1907); the only change this fix makes is the fifth
argument at line 515.

## Regression test

`tests/bug-37f9fbce.test.ts`, 3 tests:

- `37f9fbce (control): linkRepository WITH runs attributes the commit, same as the app's Git view` -- proves
  the fixture is sound: a run whose `touched` list already holds a path relative to the project root (built by
  feeding the real `ingest` CLI command a hook payload whose `tool_input.file_path` is already relative,
  sidestepping bug 15753492 entirely) matches a commit that changes the same file, through the exact call
  `lib/project/git-view.ts:87` makes.
- `` 37f9fbce: `project-companion git log` never shows the run signal -- the CLI passes no runs `` -- drives the
  real, built CLI (`dist/project-companion.mjs`) in a temporary git repository and shows the commit's signal
  column is `-`, not `run`.
- `` 37f9fbce: `project-companion git unlinked` must not list a commit a run already covers `` -- same fixture,
  drives `project-companion git unlinked` and shows the commit is listed, though a run covers it.

Every step but reading the fixture's own `AttributionResult` (the control test's direct `linkRepository` call,
mirroring `git-view.ts`) goes through the real CLI process, as `tests/cli.test.ts` and `tests/devolps-
phase3.test.ts` do: `init`, `task add`, `run start`, `ingest` (piped on stdin), then `git log`/`git unlinked`.
It never touches the real `.project`/`.project-log` of this repository -- each test opens its own temporary
directory and git repository and removes it in a `finally`.

```
$ npm test -- bug-37f9fbce

> project-companion@0.3.0 test
> node scripts/run-tests.mjs bug-37f9fbce

built dist/project-companion.mjs and dist/project-companion-mcp.mjs

bug-37f9fbce.test.ts
  ok   37f9fbce (control): linkRepository WITH runs attributes the commit, same as the app's Git view
  FAIL 37f9fbce: `project-companion git log` never shows the run signal -- the CLI passes no runs
       cli/index.ts's runGit calls linkRepository with no runs, so signal 2 never fires: expected "run", got "-"
  FAIL 37f9fbce: `project-companion git unlinked` must not list a commit a run already covers
       the commit should be attributed by the run and so absent from `git unlinked`, but it was listed:
e47cbdc  Rotate the token

1 unlinked. Add `project-companion: <taskId>` to a commit message, or work on a branch named after the task.


1/3 passed
```
Exit code: 1.
