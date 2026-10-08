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
runbook), a missing or failing `ci` check blocks the gate but not a push
through the GitHub web UI.

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
- Use Node 22 locally to match the runner.

## Reading a failure

1. Open the pull request's checks tab and find the failed `ci` run.
2. Open the run's log and find the first step with a non-zero exit. The 4
   steps run in order and stop at the first failure, so the failing step is
   the last one shown.
3. Reproduce that single step locally, for example `npm run typecheck`, to
   see the same error without waiting on a runner.
4. Common causes:
   - `npm ci` fails: `package.json` and `package-lock.json` are out of
     sync. Run `npm install` locally and commit the updated lockfile.
   - `npm run typecheck` fails: a real type error, or `build:icons` itself
     failed (check its output further up the same step's log).
   - `npm test` fails: read the failing test's name and assertion in the
     log; `scripts/run-tests.mjs` prints each test as it runs.
   - `npm run build:tools` fails: an esbuild error in `lib/` or the CLI
     entry points under `scripts/`.

## Rollback

If the check is blocking work it should not, do one of:
- Delete `.github/workflows/ci.yml` from the repository.
- Disable the workflow on GitHub (repository Settings > Actions > the `ci`
  workflow > Disable workflow). This stops new runs without deleting the
  file.

Either way, pull requests then have no checks again, and the merge gate
needs an override until the workflow is restored.
