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

Normalize `progress.touched` to paths relative to `root` inside `reportRun`, before the `mayWrite` boundary
check and before logging -- `reportRun` already receives `root` as its first argument, so this is a single
call site. A path that resolves inside `root` is stored using the same relative, forward-slash form `git`
already uses for `commit.paths`, so the two line up byte for byte. A path that resolves *outside* `root`
(for example a file the harness touched in the user's home folder, which can happen if a hook reports a
path outside the project by mistake, or the project root moved) is left exactly as given -- the harness's
original absolute string -- and never rewritten with a relative-path escape such as `../../Users/name/...`.
That path can never be a commit's path either way (a commit cannot touch a file outside its own
repository), so there is nothing meaningful to relativize it to, and converting it would turn a merely
unmatchable string into one that could be misread as a path inside the project by whatever reads it next.
This also fixes `mayWrite`'s boundary check for real harness runs: today, a component with a configured
`writeGlobs` boundary matches an absolute path against a relative glob and always refuses it, so every real
write from a harness is incorrectly reported as outside the boundary whenever a boundary is set at all; after
the fix `mayWrite` sees the same relative path `git` would show for the same file.

## Open for the PM

The full paths already written to `.project-log/*.jsonl` cannot be edited: the log is append-only and
hash-chained, so a `run.progress` event recorded before this fix ships keeps its absolute `touched` paths
forever, however the fix above is written. Two ways to handle that:

1. **Also normalize on read** -- in `linkRepository` (`lib/project/git-link.ts:298`, which already receives
   `root`), map each `AttributableRun.touched` entry the same way the fix above does, before matching it
   against `commit.paths`. Cost: a second, small copy of the same normalization logic (under 10 lines),
   living beside the write-side one. Benefit: every run already in flight or already logged -- including
   whatever sits in this repository's own `.project-log` right now, which is what the EM saw on 2026-10-09
   -- gets attributed correctly the moment this ships, with no migration step and no log rewrite.
2. **Leave the old events as they are** -- fix only the write side, so every `run.progress` event logged
   from this point on is correct, and accept that a run started before the fix merges never links to its
   commits. Simpler: one fix site, no duplicated logic. Cost: a silent, permanent gap in delivery evidence
   for every run in flight today, with no way to repair it after the fact, since the log cannot be rewritten
   and there is no way to tell, from an old event alone, which part of an absolute path is the project root.

Recommendation: option 1. The read-side normalization is small, sits next to code that already has `root`
in scope, and the alternative is a permanent loss of exactly the evidence this feature exists to produce,
for every run already underway when the fix lands -- including this repository's own tracker.

## Regression test

`tests/bug-15753492.test.ts`, 1 test:

- `15753492: a run that touches a file a commit also changes is linked to that commit's task`

The test starts a run against a task in a temporary project and git repository, feeds `reportRun` the
same `touched` list `parseHook`'s `tool.use` branch would hand `cli/index.ts`'s `ingest` command -- the
harness's absolute path for a file it wrote -- then commits that same file and calls `linkRepository` with
the runs `readRuns` folds back out of the log, the same two calls `git-view.ts` makes for the app. It never
touches the real `.project` or `.project-log` of this repository.

```
$ npm test -- bug-15753492

> project-companion@0.3.0 test
> node scripts/run-tests.mjs bug-15753492

built dist/project-companion.mjs and dist/project-companion-mcp.mjs

bug-15753492.test.ts
  FAIL 15753492: a run that touches a file a commit also changes is linked to that commit's task
       a run that wrote this exact file, inside its open window, must be the match: expected "run", got undefined

0/1 passed
```
Exit code: 1.
