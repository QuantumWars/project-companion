# QA report: d5ebde85 (SR-8) — the artifact text lookup can be slow without limit

Bug: `specs/bugs/d5ebde85/bugfix.md`. Pull request #22, branch `fix/d5ebde85-artifact-lookup`. Head commit
tested: `fd893e5717385b9f0b0b80e7e8ace7ded4b1a9a9`. `git diff --numstat f883e22 fd893e5` shows only
`.project-log/2d96e8e4849c.jsonl` changed (+69/-0) — the code under test is unchanged since `f883e22`; `fd893e5`
only records the PR 22 security re-check in the tracker.

Requirement id: **UNKNOWN**. As the bugfix spec says, SR-8 is a security-review finding (security review,
`specs/decision-alerts/reviews/security.md:108-113,160-161`), approved at the decision-alerts design gate, not
an EARS/PRD criterion. There is no `DA-xx` id for a size/kind/location rule on gate artifacts or the PRD source.

Reviews (`gh pr view 22 --comments`): round 1 on `f3b5229` — 1 blocker (H1: `prd init` could overwrite a file
outside the root) plus several low, all resolved in `5d6a698`/`6d9067e`/`76ecf76`. Round 2 code re-review — 0
high, 0 medium, 3 low (N1 doc-comment placement, N2 missing in-root-symlink-to-outside-folder test, N3 the
bugfix spec's "before the fix" line naming the wrong tests). N1 and N2 were merged into this branch at `f883e22`
(`362e3c0` adds the symlinked-`docs`-folder test). N3 is fixed by this QA pass (see below). The security
re-check on `6d9067e` (recorded in the tracker log, commit `fd893e5`) found 2 further low findings in the
threat-model wording, **S-N2** and **S-N3** — not mine to fix, and reassigned to the architect per the task
brief. Both are now fixed: the architect's `73a046c` (merged into the PR branch by the EM at `6c4dca3`, after
the `fd893e5` head this QA pass tested) changes only `specs/decision-alerts/threat-model.md`:
- S-N2 (`specs/decision-alerts/threat-model.md:110`): residual 2 now says "a window between the check and the
  read or write", and names what `createPrd`/`editPrd` can each do inside it.
- S-N3 (`specs/decision-alerts/threat-model.md:73,101`): the D1 and D2 denial-of-service cells each now say
  "see TH-7, residual 3".

## 1. The bugfix-spec wording fix (N3)

`specs/bugs/d5ebde85/bugfix.md:114` said "Before the fix (only the first two existed, the second narrower)",
which named the wrong second test. Checked directly: `git show dd27233:tests/bug-d5ebde85.test.ts` has exactly
two tests — `d5ebde85: an artifact path outside the project root is not read` (the first in the final list of
six) and `d5ebde85: an artifact path inside the project root is still read (control)` (the fourth). The control
at `dd27233` has no `symlinkSync`/`link.md` lines, so it did not yet cover an in-root symlink. Reworded the
line to name the first and fourth tests and say the control lacked the symlink case; nothing else in the spec
changed (`git diff -- specs/bugs/d5ebde85/bugfix.md` below).

## 2. Criteria mapped to tests

Task: d5ebde85     Criteria: SR-8 (UNKNOWN id), TH-5, DA-02.5 (approved-artifact cases)     Result: pass

| Criterion | Test(s) | Size | Result | Evidence |
|---|---|---|---|---|
| SR-8 — a ref that escapes the project root is never read | `d5ebde85: an artifact path outside the project root is not read` | small | pass | `npm test -- bug-d5ebde85` → `ok`, exit 0. |
| SR-8 — a folder, an out-of-root symlink, and an escaped PRD source all give `null` | `d5ebde85: a folder, a symlink out of the root and an escaped PRD source give null` | medium | pass | `npm test -- bug-d5ebde85` → `ok`, exit 0. |
| SR-8 — the PRD source gets the same in-root, regular-file rule | `d5ebde85: a PRD source outside the project root or not a regular file is not read` | medium | pass | `npm test -- bug-d5ebde85` → `ok`, exit 0. |
| SR-8 — an in-root artifact, and an in-root symlink to one, are still read (control) | `d5ebde85: an artifact path inside the project root is still read (control)` | small | pass | `npm test -- bug-d5ebde85` → `ok`, exit 0. |
| SR-8 — a non-regular file (socket) inside the root gives `null`, not a hang | `d5ebde85: a Unix socket inside the project root gives null` | small | pass | `npm test -- bug-d5ebde85` → `ok`, exit 0. |
| SR-8 — `prd init` never writes outside the root, over a file, or through a symlink | `d5ebde85: prd init never writes outside the root or over a file or a symlink` | large | pass | `npm test -- bug-d5ebde85` → `ok`, exit 0. |
| TH-5 (updated by d5ebde85) — a folder artifact is a missing artifact, not an `EISDIR` throw; an unreadable one still gives `lookup failed: <code>` | `TH-5: a folder in place of an approved artifact is missing; an unreadable one gives lookup failed: EACCES` (in-process) | medium | pass | `npm test -- notify` → `ok`, exit 0. |
| TH-5 (updated by d5ebde85), at the CLI — same behaviour through the real process | `TH-5: a folder in place of an approved artifact is sent; an unreadable one gives one stderr line and output as with off` (CLI) | large | pass | `npm test -- notify` → `ok`, exit 0. |
| DA-02.5 approved-artifact cases — a folder/unreadable approved artifact changes the gate's staleness (`sent`/`failed`) but appends no gate, track or card event | `DA-02.5: the notifier appends no event` (the "artifact is a folder" and "artifact is unreadable" sub-cases) | large | pass | `npm test -- notify` → `ok`, exit 0. |

Not tested, and why: none — every criterion named in the task brief has a named test, and every named test ran.

## 3. Full check run (head `fd893e5`, branch `test/d5ebde85-pr22-qa`)

| Command | Exit code | Counts |
|---|---|---|
| `npm test -- bug-d5ebde85` | 0 | 6/6 passed |
| `npm test -- notify` | 0 | 47/47 passed |
| `npm test` | 0 | 457/457 passed across 23 suites (`agent-run`, `bug-d5ebde85`, `bundle`, `catalog`, `cli`, `component`, `delete`, `deps`, `devolps-phase3`, `drilldown`, `events`, `flow`, `gate`, `git`, `merge`, `notify`, `prd-edit`, `prd`, `review`, `roadmap`, `run`, `sync`, `verify`) |
| `npm run typecheck` | 0 | `tsc --noEmit` clean |
| `npm run lint` | not checked (worktree ESLint config) | `next lint` fails with "Plugin \"@next/next\" was conflicted between \".eslintrc.json\" ... and \"../../../.eslintrc.json\"" — this is the documented worktree-vs-main-checkout ESLint config collision, not a lint finding in this change. The EM runs lint in the main checkout. |

## 4. Revert check: the regression suite does not pass without the fix

Reverting only `gate.ts` and `roadmap.ts` fails at the CLI build step itself (`scripts/run-tests.mjs:32` always
bundles `cli/index.ts` first, and its static import of `createPrd` has nothing to resolve to in the pre-fix
`roadmap.ts`), so all three files the fix touches were reverted together, to let the build complete and show
the tests' own behaviour:
```
git show 69ebe8b:lib/project/gate.ts > lib/project/gate.ts
git show 69ebe8b:lib/project/roadmap.ts > lib/project/roadmap.ts
git show 69ebe8b:cli/index.ts > cli/index.ts
```
With all three reverted, `scripts/build-tools.mjs` now succeeded ("built dist/project-companion.mjs and
dist/project-companion-mcp.mjs"). Ran `npm test -- bug-d5ebde85`. Result: **exit code 1**, and still not as six
individual pass/fail results — esbuild's per-file bundle step refused `tests/bug-d5ebde85.test.ts` itself, one
level down, because the test file's own `import { createPrd, readRoadmap } from "@/lib/project/roadmap"`
(line 29) has nothing to resolve to in the pre-fix `roadmap.ts`:
```
✘ [ERROR] No matching export in "lib/project/roadmap.ts" for import "createPrd"
    tests/bug-d5ebde85.test.ts:29:9:
      29 │ import { createPrd, readRoadmap } from "@/lib/project/roadmap";
Error: Build failed with 1 error: ...
```
This is a static, build-time refusal, not the runtime `TypeError` expected: esbuild checks a named ESM import
against the target module's declared exports before any code runs, so a missing export never reaches a
`createPrd(...)` call at runtime — the whole file fails to bundle, before the harness can print `ok`/`FAIL` for
any of the six. Recording each of the six by name, as asked: none of them ran, individually, for this reason —

- `d5ebde85: an artifact path outside the project root is not read` — did not run (build failed first)
- `d5ebde85: a folder, a symlink out of the root and an escaped PRD source give null` — did not run (build failed first)
- `d5ebde85: a PRD source outside the project root or not a regular file is not read` — did not run (build failed first)
- `d5ebde85: an artifact path inside the project root is still read (control)` — did not run (build failed first)
- `d5ebde85: a Unix socket inside the project root gives null` — did not run (build failed first)
- `d5ebde85: prd init never writes outside the root or over a file or a symlink` — did not run (build failed first)

Exit code: 1. The suite does not pass without the fix, but the cause is a build-time refusal of a missing
export, not six runtime assertion failures.

Restored all three files with `git checkout -- lib/project/gate.ts lib/project/roadmap.ts cli/index.ts`;
`git status --short` showed only `specs/bugs/d5ebde85/bugfix.md` (the N3 wording fix) and the new, untracked
`docs/qa/d5ebde85.md` — confirming the revert was clean. Re-ran `npm test -- bug-d5ebde85` after the restore:
`6/6 passed`, exit 0, confirming the restore. The reverted state was never committed.

## Commands run

- `git switch -c test/d5ebde85-pr22-qa fd893e5` → exit 0 (new branch at the commit named in the task).
- `npm ci` → exit 0 (502 packages).
- `npm test -- bug-d5ebde85` → exit 0, `6/6 passed`.
- `npm test -- notify` → exit 0, `47/47 passed`.
- `npm test` → exit 0, `457/457 passed`, 23 suites.
- `npm run typecheck` → exit 0.
- `npm run lint` → exit 1, `next lint` ESLint-config conflict between the worktree's `.eslintrc.json` and the
  main checkout's — not checked (worktree ESLint config), per the task rule.
- `git show dd27233:tests/bug-d5ebde85.test.ts` → confirms exactly the first and fourth tests existed, and the
  control had no symlink case, backing the N3 wording fix.
- `git diff --numstat f883e22 fd893e5` → only `.project-log/2d96e8e4849c.jsonl` changed; code unchanged since
  `f883e22`.
- `gh pr view 22 --json files,title,headRefOid` and `gh pr view 22 --comments` → PR file list, round-1 and
  round-2 review comments, quoted above.
- `git show 69ebe8b:lib/project/gate.ts > lib/project/gate.ts`, the same for `roadmap.ts` and `cli/index.ts`,
  then `npm test -- bug-d5ebde85` → exit 1 (the test file's own bundle refused, quoted above), then
  `git checkout -- lib/project/gate.ts lib/project/roadmap.ts cli/index.ts`, then `git status --short` → clean
  except the N3 edit and the new `docs/qa/d5ebde85.md`, then `npm test -- bug-d5ebde85` → exit 0, `6/6 passed`
  (restore confirmed).

## Not tested, and why

- `npm run lint`: not checked (worktree ESLint config) — fails in every agent worktree under
  `.claude/worktrees/` because `next lint` finds both the worktree's and the main checkout's `.eslintrc.json`.
  The EM runs lint in the main checkout, per the task rule.
- The slow/never-ending half of SR-8 (a `..` ref pointed at a very large file or `/dev/zero`): the bugfix spec
  itself says this is deliberately not exercised by the regression suite, to keep the tests fast and safe; not
  re-tested here either, for the same reason.
- S-N2 and S-N3 (threat-model wording, `specs/decision-alerts/threat-model.md:73,101,110`): low findings from
  the PR 22 security re-check, not in this QA's scope. Named here for the record; now fixed by the architect's
  `73a046c`, merged into the PR branch at `6c4dca3`, after the `fd893e5` head this QA pass tested.

Result: pass
