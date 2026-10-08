# QA report: 5bf8eb1b — Run CI on every pull request

Spec: `specs/ci/quick.md` (approved 2026-10-09). Pull request: #8
(https://github.com/QuantumWars/project-companion/pull/8). Head commit:
`df959e572e0db9b1a07e8ba74f91a6e67d66bc09`. GitHub run: 37847009825
(`ci`, event `pull_request`, conclusion `success`, head SHA matches).

Since the first head (`aeadebb`), the branch adds two review-fix commits
(`52274be`: `timeout-minutes: 15` on the job and `persist-credentials: false`
on checkout; `1513042`: runbook text only) plus tracker commits. Neither
review-fix commit touches `package.json`, `tsconfig.json` or `scripts/`.

Failing-probe pull request: #9, from branch `test/5bf8eb1b-ci-failing-probe`
(commit `688183085b3dbbed96494607fde4ee7d32695164`, i.e. `aeadebb` plus the
probe commit). GitHub run: 37846592783.

Task: 5bf8eb1b     Criteria: CI-01.1, CI-01.2, CI-01.3, CI-01.4, CI-01.5, CI-01.6, CI-01.7, CI-01.8, CI-01.9     Result: pass

| Criterion | Test(s) | Size | Result | Evidence |
|---|---|---|---|---|
| CI-01.1 | `git show df959e5:.github/workflows/ci.yml \| grep -n -A3 '^on:'` | small | pass | Lines 3-6: `on:` / `pull_request:` / `types: [opened, synchronize, reopened]`, no other event. |
| CI-01.1 | `gh pr checks 8 --json name,event` (run 37847009825, head `df959e5`) | small | pass | `[{"event":"pull_request","name":"ci","workflow":"ci"}]`. |
| CI-01.2 | `git show df959e5:.github/workflows/ci.yml \| grep -nE 'run: (npm ci\|npm run typecheck\|npm test\|npm run build:tools)$'` | small | pass | Lines 22-25, in order: `npm ci`, `npm run typecheck`, `npm test`, `npm run build:tools`. |
| CI-01.3 | `git diff aeadebb df959e5 -- package.json tsconfig.json scripts/` is empty; fresh-clone result from `aeadebb` cited | medium | pass | Diff is empty, so the review-fix commits do not change the `typecheck` script, `tsconfig.json`, or any build script. The earlier fresh-clone run on `aeadebb` (clone made in a scratchpad dir, removed after) still holds: cloned commit `aeadebbbad1a8ab99eceb38f92cb81e86d7480ad` (verified via `git log -1`), `npm ci` added 502 packages, `npm run typecheck` ran `build:icons` then `tsc --noEmit`, exit 0. The new head's own `ci` run (37847009825) also shows `npm run typecheck` completing before `npm test` with no failure. |
| CI-01.4 | Same diff as CI-01.3 (empty) → fresh-clone result from `aeadebb` cited | small | pass | In the `aeadebb` clone, adding `lib/ci-probe.ts` with `export const ciProbe: number = "x";` made `npm run typecheck` exit 2: `lib/ci-probe.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.` Unchanged by the review-fix commits (CI-01.3 diff is empty), so this still holds on `df959e5`. |
| CI-01.5 | `git show df959e5:.github/workflows/ci.yml \| grep -c continue-on-error` | small | pass | Prints `0`. |
| CI-01.5 | Draft PR #9 from `test/5bf8eb1b-ci-failing-probe` @ `6881830`, run 37846592783; `gh pr checks 9 --json name,bucket`; `gh run view 37846592783 --json conclusion,headSha,jobs`; `gh pr view 9 --json state,mergedAt` | medium | pass | `gh pr checks 9` → `[{"bucket":"fail","name":"ci"}]`. `gh run view 37846592783` → `conclusion: "failure"`, `headSha` matches `6881830...164`, job steps show `Run npm ci` success, `Run npm run typecheck` success, `Run npm test` **failure**, `Run npm run build:tools` **skipped**. `gh pr view 9` → `state: "CLOSED"`, `mergedAt: null`. The EM opened PR #9, it was closed unmerged, and its branch no longer exists on origin (`git ls-remote origin refs/heads/test/5bf8eb1b-ci-failing-probe` returns nothing). |
| CI-01.6 | `gh pr checks 8 --json name,workflow,bucket` (run 37847009825, head `df959e5`) | small | pass | `[{"bucket":"pass","name":"ci","workflow":"ci"}]` — exactly one check, named `ci`, bucket `pass`. |
| CI-01.7 | `git show df959e5:.github/workflows/ci.yml \| grep -n 'node-version'` | small | pass | Line 21: `node-version: 22`, before line 22's `run: npm ci`. |
| CI-01.8 | `git show df959e5:.github/workflows/ci.yml \| grep -n 'runs-on'` | small | pass | Line 13: `runs-on: macos-latest`. |
| CI-01.9 | `git show df959e5:.github/workflows/ci.yml \| grep -n -A2 '^permissions:'` | small | pass | Lines 7-8: `permissions:` / `contents: read`, no other permission listed. |

Not tested, and why: none. Every criterion above has a passing result from a
command I ran myself.

## Also recorded (not a criterion of this task)

DA-02.4's osascript test did not appear, run, or skip in PR #8's `npm test`
log on the first head (`aeadebb`, run 37845754484). `grep -i osascript`
found no match anywhere in that run's saved log, and no file in this
repository mentions `osascript`; `tests/` has no decision-alerts test, and
`specs/decision-alerts/` is a spec only, not yet built. The sprint plan's
risk about DA-02.4 running in `ci` does not yet apply, because that test
does not exist in the codebase this `ci` run checked. Not re-checked on the
new head, since the review-fix commits do not touch `tests/` or
decision-alerts code (see the diff summary above).

Result: pass
