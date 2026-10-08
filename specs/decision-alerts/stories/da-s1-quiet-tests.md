# Story: Test runs never show notifications
Epic: decision-alerts   Feature: notify-switch   Points: 1
From: [Requirements, DA-03](../requirements.md#da-03-off-switch-and-systems-notify-switch); [Design 3.3, "Test runner"](../design.md#33-data-model-and-api-contracts); [Design 3.4, test seam "The off switch in the runner"](../design.md#34-components-and-paths); [Design 6, step 1](../design.md#6-rollout-and-rollback); [Threat model, TH-19](../threat-model.md#threat-model-decision-alerts)
Estimate: 1 point, because the change is one `env` option on the suite call in `scripts/run-tests.mjs` (about 1 line, design 3.4) and one test that reads the variable.
## Criteria
| ID | Requirement (EARS) | Plain English |
|---|---|---|
| DA-03.2 | When `npm test` runs a suite, the test runner shall set `PROJECT_COMPANION_NOTIFY` to `off` for that suite. | Running the tests never shows notifications to the PM. |

Verify: `npm test -- notify` (requirements, "Requirements": the suite `tests/notify.test.ts` proves every criterion).
Test note (requirements, DA-03): "DA-03.2 is a test in the suite that reads the variable that the runner set."
## Tasks
- cc05f85e (da-t1) — Set the notify off switch in the test runner — role: devops-sre — component: agent-tooling
- 0c8e6562 (da-t2) — Start the notify suite with stubEnv and the runner test — role: backend-engineer — component: notifier
## Done means
- Every criterion passes its check
- Tests pass
- Review findings resolved
- Docs updated, or no docs impact
- Merged by the PM through /devolps:ship
