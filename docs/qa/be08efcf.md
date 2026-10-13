# QA: be08efcf (set `"root": true` in `.eslintrc.json`)

Task: be08efcf     Criteria: EL-01.1, EL-01.2, EL-01.3, EL-01.4     Result: pass

Pull request 43, branch `chore/be08efcf-eslint-root`, head `7843ee6dbd11ab1cd1bef9e31ab80fd45862fe07`. Spec: `specs/eslint-root/quick.md`.
Checked out in agent worktree `.claude/worktrees/agent-a083afc4dcdf06d52` (branch `test/be08efcf-qa` from the PR head). 2026-10-13.

| Criterion | Test(s) | Size | Result | Evidence |
|---|---|---|---|---|
| EL-01.1 | The spec's `node -e` check on `.eslintrc.json` | small | pass | Exit 0. File content: `{ "root": true, "extends": "next/core-web-vitals" }` (2 keys). |
| EL-01.2 | `test ! -L node_modules`, then `npm run lint -- --no-cache` in the agent worktree | medium | pass (control not run, see below) | `npm ci` ran first. `test ! -L node_modules` exit 0 (real folder). Lint exit 0, output `No ESLint warnings or errors`, no `was conflicted between`. |
| EL-01.3 | `npm run lint -- --no-cache` in the main checkout, read-only (`npm --prefix`) | medium | pass | Output `No ESLint warnings or errors` (exit code not captured in this run; `next lint` prints this line only on success). The main checkout's `.eslintrc.json` holds the same 2 keys. |
| EL-01.4 | `git diff --numstat fc42b60^ fc42b60` | small | pass | Prints only `1	0	.eslintrc.json`. |

Other checks:
- `npm test`: exit 0, all groups pass (11/11, 21/21, 5/5, 10/10, 17/17 among them), no failure lines.
- `npm run typecheck`: exit 0.
- `gh pr checks 43`: `ci  pending`. CI result: not checked (still running when I asked).

## What the PR carries against master (`git diff --stat origin/master...HEAD`, master = `fa4b2e5`)

6 files, 412 insertions, 9 deletions:
- `.eslintrc.json` (+1): the code change.
- `.claude/harness.json` (+1): adds `".eslintrc.json"` to a protected-path list (next to `package-lock.json`, `next.config.mjs`, `tsconfig.json`). This is not in the spec's file limit ("1 file, 1 added line"). Check that the PM made this edit (the spec's Q1 says only the PM edits `harness.json`).
- `docs/test-rules.md` (+1): test rule 11.
- `specs/eslint-root/quick.md` (+40): the spec.
- `.project` (+48/-9) and `.project-log/2d96e8e4849c.jsonl` (+330): tracker files.

EL-01.4 as written in the Verify line (`git diff --numstat origin/master...HEAD`) does not print only `1	0	.eslintrc.json` for this branch: it prints the 6 files above. The criterion text itself ("the task's commit shall change only `.eslintrc.json`") holds for the code commit `fc42b60`. The Verify line and the criterion disagree; the spec should name the commit, not the branch range. Low.

## Not tested, and why

- EL-01.2 control (master `.eslintrc.json` fails in this worktree): not checked. To run it I had to put the master content into `.eslintrc.json` for one run. The hook refused my write to that file (EN-06.1, outside the qa-engineer scope), and I did not work around it. So I did not reproduce the failure in my worktree, and I cannot show that the pass is caused by `"root": true` and not by something else in this worktree. The spec's own scratch reproduction (same message, exit 1 without the line, exit 0 with it) is the only evidence of the failure. The Engineering Manager or devops-sre can run the control: copy `git show origin/master:.eslintrc.json` over the file, run `npm run lint -- --no-cache`, restore the file.
- CI lint step on the PR: pending when checked.
- Linked-`node_modules` worktree: not checked (passes today, per the spec).

Result: pass
