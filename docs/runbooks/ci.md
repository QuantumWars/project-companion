# Runbook: the `ci` check

## What it runs

On every pull request (`opened`, `synchronize`, `reopened`), the `ci`
workflow (`.github/workflows/ci.yml`) runs one job, also named `ci`, on
`macos-latest` with Node.js 22. The job runs 4 steps, in order:

1. `npm ci`
2. `npm run typecheck`
3. `npm test`
4. `npm run build:tools`

Any step that exits non-zero fails the whole `ci` check. The job token has
read-only access to repository contents; it cannot push or change the repo.

The devolps merge gate (`/devolps:ship pr`) reads this check through
`gh pr checks`. Until the PM turns on the required-status-check setting on
`master` (card c-a5d4fd, GitHub repository settings, not part of this
runbook), a missing or failing `ci` check blocks the gate, but not a merge
from the GitHub web page.

## Run the same 4 steps locally

```sh
npm ci
npm run typecheck
npm test
npm run build:tools
```

Notes:
- `npm run typecheck` runs `npm run build:icons` first, then `tsc --noEmit`.
  The icon data file it builds (`lib/arch/icons/icon-data.json`) is
  generated and git-ignored; without it, `tsc --noEmit` fails with
  `TS2307: Cannot find module './icon-data.json'`.
- `npm test` sets its own git name and email inside the tests, so it needs
  no git configuration on the machine or runner.
- `npm test` runs every suite with `PROJECT_COMPANION_NOTIFY=off`, so tests
  never show a real notification. A suite that starts a child process must
  spread `process.env` into the child's `env`, or the child loses the switch.
- Use Node 22 locally to match the runner.

## Reading a failure

1. Open the pull request's checks tab and find the failed `ci` run.
2. Open the run's log. GitHub does not show the failing step last: it lists
   the remaining steps as skipped, then its own "Post Run …" and
   "Complete job" steps, after the step that failed. Find the step with
   the red X; the steps after it show as skipped.
3. Reproduce that single step locally, for example `npm run typecheck`, to
   see the same error without waiting on a runner.
4. Common causes:
   - `npm ci` fails: `package.json` and `package-lock.json` are out of
     sync. Run `npm install` locally and commit the updated lockfile.
   - `npm run typecheck` fails: a real type error, or `build:icons` itself
     failed (check its output further up the same step's log).
   - `npm test` fails: read the failing test's name and assertion in the
     log; `scripts/run-tests.mjs` prints each test as it runs. That script
     builds the CLI and MCP server first (`scripts/run-tests.mjs` line 32),
     so an esbuild error there also fails `npm test`, with no test name in
     the log.
   - `npm run build:tools` fails: an esbuild error in `lib/` or in one of
     the entry points `cli/index.ts` and `mcp/server.ts`, built by esbuild
     from `scripts/build-tools.mjs` (lines 32 and 38).

## Rollback

If the check is blocking work it should not:

1. If `ci` is a required status check on `master` (card c-a5d4fd), remove
   it first, in GitHub's branch protection or ruleset settings for
   `master`. Only the PM can change this setting. Skip this step if the
   required-check setting is not on yet.
   - Once that setting is on, disabling or deleting the workflow without
     first removing `ci` from required checks leaves every pull request
     waiting for a check that never comes. GitHub then blocks every
     merge, including the pull request that deletes the workflow.
2. Then do one of:
   - Delete `.github/workflows/ci.yml` from the repository.
   - Disable the workflow on GitHub (the Actions tab, select the `ci`
     workflow, open the "..." menu, then "Disable workflow"). This stops
     new runs without deleting the file.

Either way, pull requests then have no `ci` check again. If `ci` is still
a required status check on `master` when that happens (step 1 skipped or
not yet done), GitHub blocks every merge on the web page, not only through
the devolps merge gate. Once `ci` is off the required-check list (or it
was never on), pull requests merge again; the devolps merge gate still
needs an override until the workflow is restored.
