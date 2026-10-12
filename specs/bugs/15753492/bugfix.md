# Bug: a run's touched path is stored as a full path, so it never links to its commits

## Observed

Every `run.progress` event in `.project-log/*.jsonl` stores `touched` as a full path, for example
`/Users/.../project-companion/specs/decision-alerts/design.md` (observed by the EM, 2026-10-09). The same
run goes on to write, and a commit goes on to change, the same file -- but the board never shows them linked.

## Expected

`run-attribution` (`docs/prd.md`, id `run-attribution`): "A commit matching a run's files and window attributes
to that run's task." `Verify: npm test -- agent-run`.

Concretely: a run's `touched` paths are stored relative to the project root, the same way a commit's paths
already are, so `git-link.ts`'s file-overlap check can compare them directly.

## Steps to reproduce

1. In a project inside a git repository, start a run against a task: `project-companion run start --task <id>`
   (or let a harness session start one).
2. Have the agent write a file inside the project, for example `lib/auth/token.ts`. The harness's own
   `PostToolUse` hook reports that write with `tool_input.file_path` set to the file's absolute path --
   `<repo>/lib/auth/token.ts` -- because that is what Claude Code (and every harness implemented so far)
   always sends.
3. Pipe that hook payload through `project-companion ingest` (this is automatic under Claude Code's hooks;
   `cli/index.ts`'s `ingest` command calls `reportRun` with the payload's `touched` list unchanged).
4. Commit that same file with git: `git add lib/auth/token.ts && git commit -m "Rotate the token"`.
5. Run `project-companion git log`, or open the project's Git view in the app.

Observed result: the commit from step 4 is never shown linked to the run's task. `run show <id>` correctly
lists the file as touched, but as the harness's full path, not one relative to the project.

## Root cause

`writtenPaths` (`lib/project/ingest.ts:62-78`) pulls `tool_input.file_path` (or `.path`/`.notebook_path`)
out of the harness's hook payload exactly as the harness sent it, with no normalization. `parseHook`'s
`tool.use` branch (`ingest.ts:128-138`) carries that string through unchanged as `event.touched`.

The `ingest` command's `tool.use` branch (`cli/index.ts:1181-1187`) passes `event.touched` straight into
`reportRun` as `progress.touched`:

```ts
const result = reportRun(root, run.id, {
  inputTokens: event.inputTokens,
  outputTokens: event.outputTokens,
  toolCalls: 1,
  touched: event.touched,
});
```

`reportRun` (`lib/project/store.ts:1482-1512`) does nothing to make `progress.touched` relative. It splits
the list into `refused`/`allowed` with `mayWrite` (`lib/project/run.ts:179-180`, which matches against
`run.writeGlobs` -- always relative globs, such as `lib/auth/**`) and logs `allowed` verbatim as the
`run.progress` event's `data.touched` (`store.ts:1509`). So the absolute path is exactly what lands in
`.project-log/*.jsonl`, and exactly what `runsFrom` (`lib/project/run.ts:247-248`) later folds back into
`run.touched` on every `readRun`/`readRuns`.

`git-link.ts`'s `runFor` (line 152) then checks:

```ts
return commit.paths.some((path) => run.touched.includes(path));
```

`commit.paths` always comes from `git log --numstat` (`lib/project/git.ts:248`, `paths: files.map((f) =>
f.path)`), which is always relative to the repository root. An absolute string is never `===` a relative
one, so this check can never match for a run that went through a real harness. Signal 2 of attribution (the
run signal) never fires, and `linkRepository` (`lib/project/git-link.ts:298`) always returns `signal:
undefined` for these commits.

Related, but not the cause of this bug: `cli/index.ts:515` (`project-companion git log`/`git unlinked`)
calls `linkRepository` without passing `runs` at all, so that command never attempts run attribution,
working project or not. Worth a separate follow-up; noted in the hand-off, not fixed here.

## Fix

The PM decided (card c-a1704f): normalize on write **and** on read. Both sides use one shared helper, so the two
cannot drift. The code review (F1 high, F2 medium) and the PM (card c-008562) widened the first version; the
PM (card c-effe5d) added the deleted-worktree rule.

- **Shared helper.** `relativeToRoot(root, path)` in `lib/project/rel-path.ts`. It is called by `reportRun`
  (`lib/project/store.ts`, on write) and by `linkRepository` (`lib/project/git-link.ts`, on read).
- **Nearest-checkout rule.** An absolute path becomes a relative, forward-slash path, relative to the nearest
  folder above it that holds a `.git` entry (`checkoutTop`). That is the base `git` uses for `commit.paths`. So:
  - A write in an agent worktree (`<root>/.claude/worktrees/<name>/lib/a.ts`) becomes `lib/a.ts` (finding F1).
  - A project in a sub-folder of its repository stores paths relative to the git root, not to the project folder
    (finding F2).
  - With no `.git` above the path, the base is `root`.
- **Same-repository rule.** The nearest checkout counts only when it belongs to THIS repository. The helper
  compares git common directories without a subprocess (`commonDir`: a `.git` folder, or a `.git` file that
  points to a folder with a `commondir` file; a submodule has none, so its own folder is its common directory).
  A path in a sibling repository, a nested repository inside the project, or a submodule stays exactly as given
  (absolute): its relative path would be a path in another repository, and could match a commit here by chance
  (re-review R1).
- **Deleted-worktree rule.** When a worktree folder `<root>/.claude/worktrees/<name>/` no longer exists, no `.git`
  is above the path, so the nearest-checkout rule cannot see it. `deletedWorktree` makes
  `<root>/.claude/worktrees/<name>/<rest>` become `<rest>`, because git shows the file as `<rest>` on the
  worktree's branch. It applies only to this project's own `.claude/worktrees` folder, only when `<name>` is one
  path part and `<rest>` is not empty, and never when a live checkout holds the path (a live checkout wins).
- **Symlinked roots.** The helper compares real paths: `realish` resolves the deepest part that exists with
  `realpathSync` and appends the rest as given. So a root reached through a symlink (for example macOS `/var` ->
  `/private/var`) and a file that does not exist yet both resolve correctly.
- **What stays absolute or as given.** A relative path; a path in another repository (sibling, nested or
  submodule); a deleted-worktree path of a different project; a path that would need a `..` escape; the base
  folder itself; the `.claude/worktrees` folder itself; a worktree folder itself; an empty rest. A `..` that stays
  inside the base is resolved. The helper never rewrites a path with a `..` escape: an outside path can never be a
  commit's path, and a `../..` string could be misread as a path inside the project.
- **Write side.** `reportRun` maps `progress.touched` through `relativeToRoot` before the `mayWrite` boundary
  check and before logging. New `run.progress` events hold relative paths, and `mayWrite` sees the same relative
  path as the run's relative `writeGlobs`, so a real harness write inside the boundary is no longer refused.
- **Read side.** `linkRepository` maps each run's `touched` through `relativeToRoot(root, ...)` before the
  file-overlap check. A run logged before the fix, whose events keep absolute paths forever (the log is
  append-only and hash-chained), is attributed the moment the fix ships. No migration and no log rewrite.

Not fixed here: `project-companion git log` and `git unlinked` call `linkRepository` without `runs` (bug
37f9fbce), so the CLI never shows run attribution. The Git view in the app does.

## Regression test

`tests/bug-15753492.test.ts`, 1 test:

- `15753492: a run that touches a file a commit also changes is linked to that commit's task`

It starts a run against a task in a temporary project and git repository, feeds `reportRun` the same `touched`
list `parseHook`'s `tool.use` branch hands the `ingest` command -- the harness's absolute path -- then commits
that file and calls `linkRepository` with the runs `readRuns` folds back out of the log (the same two calls
`git-view.ts` makes). It never touches this repository's `.project` or `.project-log`.

The "control" assertion changed with the fix. Before, it expected the run to hold the absolute path as the
harness sent it. Now it expects `["lib/auth/token.ts"]`: the stored path is relative.

`tests/agent-run-paths.test.ts`, 16 tests (the file name starts with `agent-run`, so the PRD line
`Verify: npm test -- agent-run` selects it):

1. `15753492: an absolute path inside the root is stored relative with forward slashes`
2. `15753492: a path outside the root, or with .. out of it, is stored exactly as given`
3. `15753492: a relative path already in the log is unchanged`
4. `15753492: mayWrite sees the relative path, so an absolute write inside the boundary is allowed`
5. `15753492: a symlinked root still resolves an absolute path inside it`
6. `15753492: an old run holding an absolute path still attributes to its commit`
7. `15753492: a .. that stays inside the root is resolved, and the root itself is unchanged`
8. `15753492: a write inside a linked worktree links the run to the commit made there`
9. `15753492: a project in a sub-folder of its repository stores paths relative to the git root`
10. `15753492: a path in a sibling repository stays absolute and never links to a commit here`
11. `15753492: a path in a nested repository inside the project stays absolute`
12. `15753492: a path in a submodule of the project stays absolute`
13. `15753492: with no git repository, a symlinked root still gives a relative path`
14. `15753492: a path in a deleted worktree of this project becomes relative and links to its commit`
15. `15753492: a deleted-worktree path of a different project stays absolute`
16. `15753492: the worktrees folder, a worktree folder itself and an empty rest stay unchanged`

Result on the fixed code (head `e04973bbf2a03b2e045fa50744c12e39c22200fa`):

```
$ npm test -- bug-15753492
1/1 passed

$ npm test -- agent-run-paths
16/16 passed

$ npm test -- agent-run
agent-run-paths.test.ts  16/16 passed
agent-run.test.ts        25/25 passed
```

Before the fix (commit `79df5ef`), the same regression test fails: `0/1 passed`, with `a run that wrote this
exact file, inside its open window, must be the match: expected "run", got undefined`. QA report:
`docs/qa/15753492.md`.
