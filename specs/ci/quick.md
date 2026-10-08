# Quick change: Run CI on every pull request
What: Add one GitHub Actions workflow, `.github/workflows/ci.yml`, that runs `npm ci`, `npm run typecheck`, `npm test` and `npm run build:tools`, in that order, on every pull request. Add a `typecheck` script to `package.json` that also passes on a clean checkout.
Why: The merge gate (`/devolps:ship pr <n>`) reads `gh pr checks <n>` and refuses a pull request with no checks, so today every merge needs an override. With one `ci` check, the PM sees pass or fail at the gate before a build merges.
Limits: 3 files, about 50 changed lines, no component, no schema or API change. GitHub Actions is part of GitHub, where the repository already is (see Risk).
## Requirements
| ID | Requirement (EARS) | Plain English |
|---|---|---|
| CI-01.1 | The `ci` workflow shall start a run only on the `pull_request` events `opened`, `synchronize` and `reopened`. | Each pull request is checked when it opens and after each push to it. Nothing else starts a run: no push to `master`, no schedule. |
| CI-01.2 | When the `ci` workflow runs, the job shall run `npm ci`, `npm run typecheck`, `npm test` and `npm run build:tools` as 4 separate steps, in that order. | The PM's 4 checks run one after another, each on its own line in the log. |
| CI-01.3 | When `npm run typecheck` runs in a fresh clone after `npm ci`, the script shall exit 0. | Typecheck passes on a clean machine, not only on one that already has the generated icon file. The script must create that file first (see Risk). |
| CI-01.4 | If the code has a type error, the `typecheck` script shall exit with a non-zero code. | A type error fails the check. |
| CI-01.5 | If any step of the `ci` job exits non-zero, the workflow shall mark the `ci` check as failed. | One failed step is enough to fail the whole check. |
| CI-01.6 | When a `ci` run ends, the workflow shall report one check named `ci` on the pull request, with the result `pass` or `fail`. | The merge gate's `gh pr checks` finds the result. |
| CI-01.7 | The `ci` job shall install Node.js major version 22 before `npm ci`. | Every run uses Node 22, the version that the local checks used (Q3). |
| CI-01.8 | The `ci` job shall run on the `macos-latest` runner. | The check runs on macOS, the same system as the PM's Mac (Q2). |
| CI-01.9 | The `ci` workflow shall give its job token read access to repository contents only. | Code in a pull request cannot use the run to change the repository. |

Verify:
- CI-01.1: `grep -n -A3 '^on:' .github/workflows/ci.yml` shows `pull_request` and no other event. On the task's pull request, `gh pr checks <n> --json name,event` lists `ci` with event `pull_request`.
- CI-01.2: `grep -nE 'run: (npm ci|npm run typecheck|npm test|npm run build:tools)$' .github/workflows/ci.yml` prints exactly these 4 lines, in this order.
- CI-01.3: `d=$(mktemp -d) && git clone -q "$PWD" "$d" && cd "$d" && npm ci && npm run typecheck` exits 0.
- CI-01.4: in that clone, `printf 'export const ciProbe: number = "x";\n' > lib/ci-probe.ts && npm run typecheck` exits non-zero.
- CI-01.5: `grep -c continue-on-error .github/workflows/ci.yml` prints 0. On a draft pull request branched from the task branch, with one extra commit that adds `tests/ci-probe.test.ts` containing `process.exit(1);`, `gh pr checks <n> --json name,bucket` shows `ci` with bucket `fail`. Close that pull request unmerged.
- CI-01.6: on the task's pull request, `gh pr checks <n> --json name,workflow,bucket` lists exactly one check named `ci`, with bucket `pass`.
- CI-01.7: `grep -n 'node-version' .github/workflows/ci.yml` shows `22`, on a step before `run: npm ci`.
- CI-01.8: `grep -n 'runs-on' .github/workflows/ci.yml` shows `macos-latest`.
- CI-01.9: `grep -n -A2 '^permissions:' .github/workflows/ci.yml` shows `contents: read` as the only permission.
## Risk
- **A clean checkout fails typecheck today.** On a `git archive` export of `0e7600d`, `npx tsc --noEmit` exited 2: `TS2307: Cannot find module './icon-data.json'` (`lib/arch/icons/resolve.tsx:60`). `npm run build:icons` makes that file, and `.gitignore` excludes it. After `build:icons`, typecheck exited 0. CI-01.3 covers this.
- **Other checks on that export (this Mac, Node v22.23.1):** `npm run build:tools` exit 0. `PROJECT_COMPANION_NOTIFY=off npm test` exit 0 in 21 seconds, also without the icon file. On a GitHub runner: not checked. Run time there: UNKNOWN. The tests set their own git name and email (`tests/*.test.ts`), so the runner needs no git setup.
- **The macOS-only security test runs in CI.** `DA-02.4: osascript passes every argument after -- unchanged` (SR-5) skips when the platform is not `darwin` (`specs/decision-alerts/design.md`, section 3.4). `ci` runs on `macos-latest` (Q2), so `ci` runs DA-02.4. Whether `/usr/bin/osascript` runs on a GitHub macOS runner: not checked. If it is absent, the test skips, and `ci` can pass without it.
- **Node is not pinned in the repository.** There is no `.nvmrc`, `.node-version` or `.tool-versions`, and no `engines` in `package.json` or the lockfile. `@types/node` is `^20`, and both build scripts target `node20`. Node 20 support ended on 2026-04-30 (nodejs/Release `schedule.json`). The workflow pins Node 22 (Q3, CI-01.7).
- **GitHub Actions is new here.** It is GitHub's own runner, and the repository is already on GitHub (`origin`). It needs no new account and no secrets. The repository is public (`gh repo view`). Standard GitHub-hosted runners, Linux and macOS, are "free and unlimited on public repositories" (GitHub Docs, "GitHub-hosted runners").
- **How we would notice.** If the workflow does not run, the task's own pull request has no checks, and the gate refuses it with "No CI checks ran on this pull request." A pull request opened before this merges gets the check only after its next push. This must merge before da-t1 (cc05f85e).
- **Rollback.** Delete `.github/workflows/ci.yml`, or disable the workflow on GitHub. Merges then need overrides again.
## Tasks
- 5bf8eb1b — Run CI on every pull request: npm ci, typecheck, npm test, build:tools — role: devops-sre — component: none (no tracker component owns `.github/workflows/` or `package.json`)
- Docs (constitution rule 12): the same pull request adds a short runbook, `docs/runbooks/ci.md`: what the `ci` check runs, how to run it locally, and how to roll back.
## Open questions
- [x] **Q1. Make `ci` a required status check on `master`?** This is a GitHub setting, outside the repository's files. Only the PM can change it. It is not part of task 5bf8eb1b.
  (a) Yes, after the first passing run (recommended): GitHub then blocks a merge with a failed or missing `ci` check from the GitHub web page too, not only through `/devolps:ship`. (b) No: only the devolps merge gate reads `ci`.
  Answer (PM, card c-a5d4fd): yes, after the first passing run. The PM sets it in GitHub settings.
- [x] **Q2. Which runner? (CI-01.8)**
  (a) `macos-latest` (recommended): the same system as the PM's Mac, and the only one the notifier supports. It runs DA-02.4. (b) `ubuntu-latest`: DA-02.4 skips, so a pass does not include the SR-5 proof. (c) Both: 2 checks for each pull request, and Linux support was not requested.
  Answer (PM, card c-18a31a): macos-latest.
- [x] **Q3. Which Node.js major version? (CI-01.7)**
  (a) 22 (recommended): every local check above ran on v22.23.1, and support continues to 2027-04-30. (b) 20: matches `@types/node` and `node20`, but its support has ended. (c) 24: support continues to 2028-04-30, but no check in this repository has run on it.
  Answer (PM, card c-1f6920): 22.
