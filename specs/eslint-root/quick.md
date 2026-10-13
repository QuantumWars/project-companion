# Quick change: Set `"root": true` in `.eslintrc.json` so lint runs in agent worktrees

What: Add one line, `"root": true`, to `.eslintrc.json`, next to the existing `"extends": "next/core-web-vitals"`. ESLint then stops at the repository's own config and does not also read a config from a parent folder.

Why: `npm run lint` (`next lint`, ESLint 8.56.0 from `"eslint": "^8"`) fails in agent worktrees, so builders and QA cannot lint their own changes. QA reports `docs/qa/d5ebde85.md` and `docs/qa/0c8e6562.md` record lint as "not checked" for this reason. The same change is backlog task be08efcf (spec `specs/repo-upkeep/quick.md`, RU-03.1 to RU-03.3).

Limits: 1 file, 1 added line. No code, schema, dependency or component change.

Checked on 2026-10-13 (ESLint 8.56.0, Next 14.1.0):
- `.eslintrc.json` holds only `"extends": "next/core-web-vitals"`, here and on `origin/master` (`fa4b2e5`).
- Cause, reproduced: an agent worktree is at `.claude/worktrees/<name>/`, inside the main checkout. ESLint 8 reads every `.eslintrc*` in the parent folders, so it loads the main checkout's file too. In worktree `agent-a0142f750148b3855`, which has its own `node_modules`, `npm run lint -- --no-cache` exits 1 with: `Plugin "@next/next" was conflicted between ".eslintrc.json » eslint-config-next/core-web-vitals » plugin:@next/next/core-web-vitals" and "../../../.eslintrc.json » eslint-config-next/core-web-vitals » plugin:@next/next/core-web-vitals".`
- A worktree whose `node_modules` is a link to the main checkout's (`agent-a01dc4a655de6675b`) passes today: both configs load the same plugin file. Only worktrees with their own `node_modules` fail.
- Fix, reproduced in a scratch copy at the same depth (3 folders under a folder with the same `.eslintrc.json`): `next lint --no-cache` exits 1 with the same message; with `"root": true` in the inner file, it exits 0 (`No ESLint warnings or errors`). A guard refused a scratch path with a `.claude` folder in it, so the scratch path used `wt/agent/x`. ESLint 8 reads parent configs whatever the folder names, so the result is expected to be the same; the real worktree path with the fix: not checked.
- Main checkout: `npm run lint -- --no-cache` exits 0 today. No `.eslintrc*`, `eslint.config.*` or `package.json` is in any folder from `/Users/doniel/code/Personal/miro-clone` up to `/`, and `package.json` has no `eslintConfig`. So the main checkout uses no parent config that `"root": true` would cut off. A standalone scratch copy with the fix exits 0.

## Requirements
| ID | Requirement (EARS) | Plain English |
|---|---|---|
| EL-01.1 | The `.eslintrc.json` file shall hold exactly 2 keys, `"root": true` and `"extends": "next/core-web-vitals"`. | ESLint stops at this file. The rule set does not change. |
| EL-01.2 | When `npm run lint` runs in an agent worktree under `.claude/worktrees/` that has its own `node_modules` folder, the lint run shall exit 0. | Builders and QA can lint in their own copy. |
| EL-01.3 | When `npm run lint` runs in the main checkout, the lint run shall exit 0 and print `No ESLint warnings or errors`. | Lint in the main checkout works as it does today. |
| EL-01.4 | The task's commit shall change only `.eslintrc.json`, with 1 added line and 0 removed lines. | Nothing else moves. |

Verify:
- EL-01.1: `node -e 'const c=require("./.eslintrc.json");process.exit(c.root===true&&c.extends==="next/core-web-vitals"&&Object.keys(c).length===2?0:1)'` exits 0.
- EL-01.2: in an agent worktree with the task branch checked out, `test ! -L node_modules` exits 0 (a linked `node_modules` passes today, so it proves nothing), then `npm run lint -- --no-cache` exits 0 and its output has no `was conflicted between`.
- EL-01.3: in the main checkout with the task branch checked out, `npm run lint -- --no-cache` exits 0 and prints `No ESLint warnings or errors`. CI's lint step on the pull request passes.
- EL-01.4: `git diff --numstat origin/master...HEAD` prints only `1	0	.eslintrc.json`.
## Risk
- **The rule set changes by mistake.** If the builder also edits `extends`, lint can pass with fewer rules. EL-01.1 checks both keys.
- **A parent config was in use.** Checked: none exists above the main checkout. If a person clones the repository under a folder with its own ESLint config, that config no longer applies. This is the intent.
- **ESLint 9.** A move to flat config (`eslint.config.*`) ignores `.eslintrc.json`. That is a separate change; this line does no harm until then.
- **Rollback.** Remove the one line in a pull request through the PM's merge gate. Do not revert a whole squash commit that also holds tracker log lines.
## Tasks
- Set `"root": true` in `.eslintrc.json` so lint runs in agent worktrees — role: devops-sre — component: none — EL-01.1 to EL-01.4 — 1 added line. It is the same change as backlog task be08efcf (Q2). It starts only after Q1 is settled: a hook refuses the devops-sre's edit today.
- Docs (constitution rule 12): no docs impact. A grep of `docs/` and `README.md` for `eslint`, `npm run lint` and `next lint` finds no setup or how-to text. The hits are history: QA reports, the w42b and w42c sprint plans and retros, and the `repo-upkeep` phase goal in `docs/prd.md`.
## Open questions
- [ ] **Q1. Who makes the edit to `.eslintrc.json`? (blocks EL-01.1 to EL-01.4)** No role's `writes` in `.claude/harness.json` lists it, here or on `origin/master`. The PM chose (a) for be08efcf on card c-b9efd8, but that scope change has not been made.
  (a) The PM adds `.eslintrc.json` to the devops-sre's `writes` in a 1-line pull request, as PR #5 did for `.gitignore` (recommended): the devops-sre already owns `next.config.mjs` and `tsconfig.json`, and the next ESLint change needs no new decision. (b) The Engineering Manager makes the 1-line edit: no scope change, but the next ESLint change asks again, and the EM writes a file that is outside a role's scope.
- [ ] **Q2. What happens to be08efcf?** (a) Use be08efcf for this task and close nothing (recommended): it has the same title and change, so the tracker keeps one task and its history. (b) Record a new task and close be08efcf as a duplicate. The PM decides; the EM gives the PM both ids.
