# Security review: decision-alerts threat model

Commit reviewed: 7441616 (branch docs/decision-alerts-design)
Reviewer: security-reviewer agent, stage design. Saved by the Engineering Manager.

> **EM note (2026-10-08).** Hook RO-07.1 refused the reviewer's `osascript` probe and `git check-ignore`. The EM
> re-checked two claims:
> - `flag()` in `cli/index.ts` refuses a value that starts with `--`, but accepts one that starts with `-e`.
>   Confirmed by reading the function.
> - The SR-5 probe, run by the EM with a script that only returns the argument count and each argument (no display):
>   `/usr/bin/osascript -e <script> -- '-e' 'return 1' '-l' 'JavaScript' '-i' '--' 'x"y\z<line break>next line'
>   'do shell script "echo pwned"'` returned `8|-e|return 1|-l|JavaScript|-i|--|x"y\z<line break>next line|do shell
>   script "echo pwned"`. All 8 arguments arrived unchanged, and none ran as code.
>
> `git check-ignore` on the record path is still not checked.

## Bottom line

No blockers. The main risk is TH-1: agent-written text reaching AppleScript or a shell. The design closes it with a
fixed script, the text passed only as arguments after `--`, and `shell: false`. The `--` is required: `flag()` in
`cli/index.ts` refuses values that start with `--`, but accepts a card question that starts with `-e`.

6 should-fix findings and 7 notes. The two most important:
- TH-4: delete the record-path test override. It has one use, and a regular file in the test project replaces it.
- New threat: the record file has a fixed name, and the write follows symlinks. A cloned repository can point it
  outside the project.

TH-2 can be accepted as written.

## What the reviewer checked

- Diagram and table: every element and data flow is in the table, and every STRIDE cell has a threat id or a reason.
  Some elements and boundaries are missing (SR-7).
- TH-1: the pinned script and argument list (design 3.3) and the CLI's flag parsing. Both call sites come after the
  decision is recorded (`cli/index.ts:1240-1242`, `1453-1458`).
- TH-5: what can throw inside `readCockpit`. `.project` and PRD read errors are caught (`bundle.ts:180`,
  `roadmap.ts:87-95`). `hashArtifact` can throw, and it can read any path (`gate.ts:134-144`).
- TH-19: all existing CLI suites inherit or spread `process.env` (`cli`, `gate`, `devolps-phase3`, `merge`, `sync`).
  None builds its environment from scratch.
- TH-2: the Claude Code permissions page and the project's two settings files. Neither has an allow rule for
  `project-companion`.

Not checked: the Node `ERR_INVALID_ARG_VALUE` message text; whether other accounts can see process arguments
(TH-17); whether SIP still holds on this Mac; the `ARG_MAX` value. For these the reviewer relied on the design.

## Findings

**SR-1 (should-fix, TH-4): delete `PROJECT_COMPANION_NOTIFY_RECORD`.**
- Problem: the variable lets the CLI append agent text to any file the user can write. Records sent there get no
  `.gitignore`, which also weakens TH-13. Its only use is the DA-02.1 test for a record that cannot be written.
- Fix: remove the variable. In the DA-02.1 test, put a regular file named `.project-notify` in the temporary project
  root, so creating the folder fails. If the architect keeps the variable, honour it only when the path resolves
  inside `<root>/.project-notify/`. Either way, take TH-4 off the accepted list.

**SR-2 (note, TH-2): accept as written, and replace the UNKNOWN with the documented rule.**
- Source: Claude Code permissions page (code.claude.com/docs/en/permissions, fetched 2026-10-08). An allow rule does
  not match past a leading environment-variable assignment, unless the variable is on Claude Code's known-safe list.
  A deny or ask rule matches past any leading assignment.
- So `PROJECT_COMPANION_NOTIFIER=… project-companion …` is not auto-approved by an allow rule, and the existing deny
  rules still apply. Whether this name is on the known-safe list is UNKNOWN. How the auto-mode classifier treats it
  is UNKNOWN.
- Do not add a "test flag" gate: whoever can set one variable can set two.

**SR-3 (should-fix, new threat on D3 tampering and privilege): the record path can be a symlink.**
- Problem: `.project-notify/record.jsonl` has a fixed name, and `appendFileSync` follows symlinks. A cloned repository
  can commit the record file, or the folder, as a symlink. Each decision then appends a JSON line with agent text to
  the target. Worst case: a shell start-up file, where `$(…)` in a title runs at the next shell start. `.gitignore`
  does not prevent it. Likelihood low; impact high (code runs as the PM).
- Fix: `lstat` the `.project-notify` folder and require a real directory. Open the record with
  `O_WRONLY|O_APPEND|O_CREAT|O_NOFOLLOW`, mode `0o600`. If either check fails, write nothing and print the existing
  "record not written" line. Test: a symlinked `record.jsonl` that points outside the project; after `card open`,
  the target is unchanged, exit code and standard output are unchanged, and standard error has the line.

**SR-4 (should-fix, TH-5): the error reasons have gaps.**
- Problem: no reason row for an error thrown inside the text lookup, and no catch-all row. An implementer would
  probably fall back to `error.message`, which can include paths and the bad value. Other control characters (ESC)
  pass through. A gate id contains the agent-written subject, so "never contains decision text" is too strong.
- Fix: add `lookup failed: <error.code or error.name>`, and use `<error.code or error.name>` for any other caught
  error. State that the reason never uses `error.message`. Replace U+0000–U+001F and U+007F–U+009F with a space.
  Test: approve a gate on `docs/a.md`, replace that file with a folder, run `card open`, and expect exactly
  `notification not sent: lookup failed: EISDIR`.

**SR-5 (should-fix, TH-1): make the real-osascript check required.**
- Problem: the stub proves only which arguments the CLI passes. Only the real osascript proves that it treats the text
  after `--` as data.
- Fix: name the darwin-only check in DA-02.4's `Verify:`. Skip it only when the system is not darwin or
  `/usr/bin/osascript` is absent. The check returns the argument count and every argument. Its inputs put `-e`,
  `-l`, `JavaScript`, `-i` and a literal `--` at several positions. The stub test also checks that there are exactly
  10 arguments.

**SR-6 (should-fix, TH-3 and TH-19): the TH-3 test would show a real banner.**
- Problem: "`spawn` gets that path when no override is set" would start the real osascript on the PM's Mac, or fail
  on Linux.
- Fix: export a pure `notifierPath(env)` and test it with no override set; nothing is spawned. The notify suite uses
  one helper: each time it sets `PROJECT_COMPANION_NOTIFY=on` and `PLATFORM=darwin`, it also sets
  `PROJECT_COMPANION_NOTIFIER`.

**SR-7 (should-fix, model completeness).**
- Missing data store: the artifact files that `readCockpit` hashes again through `readGates` and `hashArtifact`
  (`gate.ts:134-144`, `235-236`). The path is `join(root, ref)`, so a path with `..` can leave the project.
- Missing trust boundary: content from other clones or a cloned repository (D1, D2, artifact files, committed
  symlinks). The diagram puts D1 and D2 inside B2, which hides that their content is not trusted.
- F3 is incomplete: the child also receives the CLI's whole environment. Add this to F3's disclosure cell.
- Wrong cells: D3's privilege cell ("n/a: never run") is wrong under TH-4 and SR-3. E3's spoofing cell holds TH-19,
  which is disclosure or nuisance, not spoofing. The P1 → D1 arrow has no flow id; label it as the existing append,
  outside the notify path.

**SR-8 (note, availability; existing bug): the text lookup can be slow without limit.**
- The lookup runs inside the command, so TH-7 does not cover its time. A merged log can name an approved artifact such
  as `../../…/dev/zero` or a very large file. `gate request` already has this (`gate.ts:257`); `card open` gets it
  with this epic. The off switch does not skip the lookup (DA-04.1 needs the text), so the rollback is to revert T4.
- Fix: a separate bugfix task — accept only artifact paths and a PRD source that are regular files inside the project
  root. In this epic, record the issue under TH-7 and TH-8 and in design section 6.

**SR-9 (note, new threat): an agent can silence its own alerts** with `PROJECT_COMPANION_NOTIFY=off` or
`PLATFORM=linux` in front of its command. Fix: accept. The cockpit still lists the decision. The first-sprint metric
review flags any `off` or `unsupported` line from the PM's Mac.

**SR-10 (note, TH-10 and TH-11): the banner does not show the kind of decision.** A question card's free text can read
like a gate title; the command differs, so it cannot approve a gate. Optional fix: pass the kind as a fourth argument
and build the subtitle inside the fixed script: `(item 3 of argv) & " - " & (item 4 of argv)`.

**SR-11 (note): the off switch matches only `off` exactly.** `OFF`, `" off"`, `0` and `false` leave notifications on.
Fix: trim and match without case, or say "exactly `off`" in the README.

**SR-12 (note, TH-13): the record's ignore file must come first.** `appendRecord` writes `.project-notify/.gitignore`
before the first append, and does not append if that write fails with anything other than EEXIST. Impact if it fails:
repository noise, not disclosure (the committed log already holds the text). Design open question 1 (who adds the
root `.gitignore` line) still needs an owner.

**SR-13 (note, P3 disclosure): macOS keeps its own copy** of delivered notifications. Where and for how long is
UNKNOWN (not checked). Add this to TH-6.

## Accepted threats: can the PM accept them?

| Threat | Accept? | In plain words |
|---|---|---|
| TH-2 | Yes | The test setting can start any program. Whoever can set it could already run programs another way. Claude Code still asks before it runs a command with an unknown setting in front of it. |
| TH-4 | No | It can be removed at no cost (SR-1). |
| TH-6 | Yes | People who can see your screen can read the decision. Turn off previews, or use Focus while you share your screen. |
| TH-9 | Yes | This follows your Q3 answer. A flood of decisions would also flood the log, which is the bigger problem. |
| TH-10, TH-11 | Yes | A fake alert gets attention but cannot approve anything. |
| TH-12, TH-14 | Yes | The record is a local count, not the audit trail. You can delete it at any time. |
| TH-17 | Yes | This Mac has one user. Whether other accounts can see the text is not checked. |
| TH-18 | Yes | The requirements already say this. |

## Checks run

- `git log --oneline -1 && git status --short` -> pass (HEAD 7441616)
- `grep` of `tests/*.ts` for env and cwd in CLI calls -> pass (all CLI suites inherit or spread `process.env`)
- `grep` of `.claude/settings.local.json` for allow rules -> pass (no `project-companion` allow rule; user-level
  settings not checked)
- WebFetch https://code.claude.com/docs/en/permissions -> pass (rule quoted in SR-2)
- `/usr/bin/osascript` probe -> refused by hook RO-07.1 for the reviewer; run by the EM (see the note above) -> pass
- `git check-ignore -v .project-notify/record.jsonl` -> not checked (refused by hook RO-07.1)

## Proposals for the tracker (from the reviewer)

- Findings SR-1 to SR-13 go to the architect.
- New bugfix task, separate from this epic: `hashArtifact` and the PRD source read any path through `join(root, ref)`.
  Accept only regular files inside the project root (SR-8).
- Name an owner for the root `.gitignore` line `/.project-notify/` (design open question 1, SR-12).
- Hook finding: RO-07.1 classes `git check-ignore` as a repository change, but the command only reads. DA-04.2's
  check uses it.
