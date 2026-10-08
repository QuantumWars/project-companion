# Analyze: decision-alerts backlog

Reviewer: code-reviewer agent (read-only). Saved by the EM.
Run 1 at `01e9b47`: 1 gap (8.1, the TH-5 CLI test was planned before the CLI call existed). The EM fixed it at `9437b07`.
Run 2 at `9437b07`: the hand-off below. After run 2, the EM also applied the reviewer's optional proposal 1 (da-t7 now states why it is over 100 lines).

---

I found no gaps at `9437b07`. All 10 checks pass, and gap 8.1 from the first run is closed.

Files reviewed (branch `docs/decision-alerts-design` @ `9437b07`; the only uncommitted change is `run.*` events, seq 470 to 483, in `.project-log/`):
- specs/decision-alerts/requirements.md
- specs/decision-alerts/design.md (design gate approved, `changed: []`)
- specs/decision-alerts/threat-model.md
- specs/decision-alerts/stories/da-s1-quiet-tests.md through da-s6-notify-new-decision.md
- .github/pull_request_template.md
- The tracker: 6 stories, 9 tasks, 4 features, the component catalog, gate status

What changed since `01e9b47`:
- Only the Estimate lines of the s1, s2 and s5 shards.
- The descriptions of 8 tasks. da-t1 did not change.
- No structural tracker field changed: role, component, feature, parent, points or dependencies.

I still reran every check against the current state.

## 1. Each criterion is in exactly one shard, word for word: pass

- Each of the 17 criteria is in exactly one shard. The split is the same as before: s1 DA-03.2; s2 DA-04.1, DA-04.2; s3 DA-02.4; s4 DA-03.1, DA-03.3, DA-03.4; s5 DA-02.1, DA-02.2, DA-02.3, DA-02.5; s6 DA-01.1 to DA-01.6.
- I compared every `| DA-` row with `grep -Fx` in both directions. There is no difference.

## 2. Each criterion is proved by a task that names a test or a Verify command: pass

| Criterion | Task(s) | Test or Verify |
|---|---|---|
| DA-01.1 to DA-01.6 | da-t7 | "one 'DA-01.n: ...' test per criterion"; `npm test -- notify` |
| DA-02.1 | da-t8 | 'DA-02.1: same exit code and stdout as off' |
| DA-02.2 | da-t6 | 'DA-02.2: a missing notifier gives one stderr line' |
| DA-02.3 | da-t8 | 'DA-02.3: the CLI exits while the notifier waits' |
| DA-02.4 | da-t4, da-t8 | the required osascript test; 'notifierArgs gives 10 items'; 'a hostile card question reaches the stub unchanged' |
| DA-02.5 | da-t6 | 'DA-02.5: the notifier appends no event' |
| DA-03.1 | da-t5 | 'DA-03.1: off passes no notification' |
| DA-03.2 | da-t1, da-t2 | da-t1's own Verify commands; 'DA-03.2: the runner sets PROJECT_COMPANION_NOTIFY=off' |
| DA-03.3 | da-t5, da-t8 | the in-process test and the CLI test for `linux` and `win32` |
| DA-03.4 | da-t7 | 'DA-03.4: README names the commands, the off switch and macOS only' |
| DA-04.1 | da-t9 | 'DA-04.1: one record line per decision, once for each outcome' |
| DA-04.2 | da-t3 | 'DA-04.2: git ignores the record path' |

Every task maps to at least one criterion.

## 3. Role, component, feature, parent and points of each task: pass

| Task | Tracker id | Role | Component | Feature | Parent | Points |
|---|---|---|---|---|---|---|
| da-t1 | cc05f85e | devops-sre | agent-tooling | notify-switch | d4d5b870 | 1 |
| da-t2 | 0c8e6562 | backend-engineer | notifier | notify-switch | d4d5b870 | 1 |
| da-t3 | 398705ee | backend-engineer | notifier | notify-record | 514a9555 | 3 |
| da-t4 | 8e6e5a71 | backend-engineer | notifier | notify-safety | 53017f6b | 2 |
| da-t5 | 108eb782 | backend-engineer | notifier | notify-switch | 12a79a07 | 2 |
| da-t6 | 02d2e84e | backend-engineer | notifier | notify-safety | c774e56c | 3 |
| da-t7 | bdcf995e | backend-engineer | agent-tooling | decision-notify | b71d6ec3 | 3 |
| da-t8 | 6042a875 | qa-engineer | notifier | notify-safety | c774e56c | 3 |
| da-t9 | 1b3763e7 | qa-engineer | notifier | notify-record | 514a9555 | 1 |

- Both components are in the catalog.
- All 4 features are in the phase.
- All 6 parent stories exist.
- All points are on the scale.

## 4. Stories and their tasks: pass

- Each story has at least 1 task.
- Each shard's task ids, titles, roles and components match the tracker's children: s1 = t1, t2; s2 = t3, t9; s3 = t4; s4 = t5; s5 = t6, t8; s6 = t7.
- The tracker matches each shard in story criteria, points and features.

## 5. Features: pass

- Each story's feature is the feature of its criteria.
- Each task's feature is its parent story's feature.
- da-t7 proves DA-03.4 and da-t8 finishes DA-03.3. The s4 shard says why for both (lines 16 and 17).

## 6. `From:` links: pass

- The shards use 31 links to 12 different targets. The links did not change.
- The target headings are unchanged: the gate shows `changed: []` for design.md and threat-model.md, and requirements.md is unchanged since `01e9b47`.
- The ADR file exists.

## 7. Dependencies and merge order: pass

- The order is t1 → t2 → (t3, t4) → t5 → t6 → t7 → (t8, t9). There is no cycle.
- da-t1 has no dependencies, and every other task depends on it directly or through other tasks.
- da-t7 says "da-t1 merged". This agrees with design section 6, step 1.
- The hidden ordering problem from the first run is gone. The TH-5 CLI test is now in da-t8, which depends on da-t7, and da-t7 adds the CLI call.

## 8. Paths and work against design section 3.4: pass (gap 8.1 closed)

**Every design path has a task:**
- notify-record.ts: da-t3
- notify.ts: da-t4, da-t5, da-t6
- cli/index.ts and README.md: da-t7
- run-tests.mjs and .gitignore: da-t1
- tests/notify.test.ts: starts in da-t2

No task adds a design file or behaviour that the design does not have.

**Threat tests:**
- TH-1: da-t4, da-t8
- TH-3: da-t4. It now names both cases from design.md:445-446.
- TH-5: da-t6 (in process: the stderr line and the outcome `failed`) and da-t8 ('TH-5: a folder in place of an approved artifact gives one stderr line and output as with off'). Together they cover all of design.md:450-454.
- TH-7: da-t8
- TH-8: da-t8
- TH-13: da-t3
- TH-15: da-t3, da-t9
- TH-16: da-t6
- TH-19: da-t2
- TH-21: da-t3, da-t8

The s5 shard (line 4) now says where each half of the TH-5 tests runs.

## 9. Change size: pass

| Task | Estimated lines |
|---|---|
| da-t1 | ~4 |
| da-t2 | ~50 |
| da-t3 | ~140 |
| da-t4 | ~90 |
| da-t5 | ~95 |
| da-t6 | ~100 |
| da-t7 | ~101 |
| da-t8 | ~100 |
| da-t9 | ~40 |

- Two tasks are over 100:
  - da-t3 states its reason: "splitting would merge an untested guard".
  - da-t7, at ~101: the README paragraph that rule 12 puts in this change. Without its 12 README lines, the task is ~89. (After this run, the EM added the sentence "Over 100 because rule 12 puts the README paragraph in this change.")
- None is over 1000.
- Each estimate now names its source: design 3.4 or the architect hand-off. Each one says "not checked", except da-t1, which cites design 3.4.
- The total is ~720 lines. Design 3.4 gives ~560. Most of the difference is in tests.

## 10. "Done means": pass

All 6 shards list the 5 items of the template's "Definition of Done" (pull_request_template.md:21-25), word for word.

## Analyze lists

- Criteria with no task and no planned test: none.
- Tasks that map to no criterion: none.
- Design components with no owner or no paths: none.
  - Section 3.4's paths belong to `notifier` or `agent-tooling`.
  - README.md and .gitignore are set by role in .claude/harness.json.

## Notes (not counted as gaps)

**Known choices:**
- Story points total 18. Task points total 19.
- da-t7 carries the README paragraph for DA-03.4. The tech-writer writes it at `/devolps:pr`.
- The SR-8 slow-lookup bugfix is outside this epic.

**Left unchanged on purpose by the EM:**
- The status headers: design.md:2 says "Status: draft", and ADR-0001 line 3 says "Proposed". This decision is for the PM and the architect, because an edit changes the design's approved hash.
- Observations 7, 8 and 10 from the first run: tasks that write outside their component, the shorter plain-English lines in the features, and cockpit.ts with no owner in the catalog.

**Duplicate event:** event `2d96e8e4849c:425` is committed twice in `.project-log/2d96e8e4849c.jsonl`. The EM does not hand-edit the log. The hash chain and the effect on the tracker are not checked.

**Not checked:**
- Card c-1cb9f6. `card list` was refused by rule EN-07.4 in the first run.
- The qa-engineer write scope. It comes from the plugin defaults.
- `npm test`. There is no code yet.

## Hand-off
```
Task or epic: decision-alerts (Stage: backlog, analyze, rerun at 9437b07)
Result: done
Changed: none
Criteria claimed: none
Checks run: git diff 01e9b47 HEAD -- specs/ .project -> 3 shard Estimate lines and 8 task descriptions changed; no structural field changed
grep -Fxvf of shard "| DA-" rows against requirements.md, both directions -> pass (17 rows, each once)
project-companion task list --json -> read (6 stories, 9 tasks)
project-companion feature list --phase decision-alerts --json -> read (4 features)
project-companion component list -> read (notifier, agent-tooling exist)
project-companion gate status --json -> prd and design approved, changed: []
grep of shard link targets, Done means items and task lists -> pass
git status --short; git diff of .project-log -> only run.* events (seq 470-483) uncommitted
grep -c of event 2d96e8e4849c:425 at 9437b07 -> 2 (duplicate committed)
project-companion card list -> not checked (refused, EN-07.4, first run)
npm test -> not checked (no code at this stage)
Open questions: none
Proposals for the tracker:
1. Optional, for check 9: in da-t7 (bdcf995e), add "Over 100 because rule 12 puts the README paragraph in this change." (Done by the EM after this run.)
2. For the PM and the architect: update the status headers of design.md and ADR-0001 (an edit changes the approved design hash).
```

Gaps: 0
