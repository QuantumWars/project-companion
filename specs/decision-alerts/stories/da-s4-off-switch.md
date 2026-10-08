# Story: Turn alerts off, and send nothing on other systems
Epic: decision-alerts   Feature: notify-switch   Points: 2
From: [Requirements, DA-03](../requirements.md#da-03-off-switch-and-systems-notify-switch); [Design 3.3, "Environment variables", "Outcome precedence" rows 1 and 2, and "README"](../design.md#33-data-model-and-api-contracts); [Design 3.4](../design.md#34-components-and-paths); [Threat model, accepted threat TH-20](../threat-model.md#accepted-threats)
Estimate: 2 points, because the change is rows 1 and 2 of the outcome precedence (design 3.3), a README paragraph of about 12 lines (design 3.4), and tests for `off`, `linux`, `win32` and the README text.
## Criteria
| ID | Requirement (EARS) | Plain English |
|---|---|---|
| DA-03.1 | While the environment variable `PROJECT_COMPANION_NOTIFY` has the value `off`, the CLI shall pass no notification. | Tests, CI or the PM can turn notifications off for one shell. |
| DA-03.3 | If the CLI runs on a system other than macOS, then the CLI shall pass no notification and exit with the exit code and standard output that it gives with the off switch set. | On Linux or Windows, nothing is sent and nothing fails. |
| DA-03.4 | The README section "Gates, sprints and the PM cockpit" shall name the commands that send a notification, the off switch and the supported systems. | The PM and the agents can find how alerts work and how to turn them off. |

Verify: `npm test -- notify` (requirements, "Requirements": the suite `tests/notify.test.ts` proves every criterion).
Test notes (requirements, DA-03): "DA-03.3 runs the notifier with the system set to `linux` and to `win32`." "DA-03.4 is a test in the suite that reads `README.md`."
## Tasks
- 108eb782 (da-t5) — Add notifyDecision with the off switch and platform check — role: backend-engineer — component: notifier
- Note: DA-03.3: the CLI half is proved in 6042a875 (da-t8, story da-s5).
- Note: DA-03.4: the README paragraph ships in bdcf995e (da-t7, story da-s6), in the same change as the CLI calls (constitution rule 12).
## Done means
- Every criterion passes its check
- Tests pass
- Review findings resolved
- Docs updated, or no docs impact
- Merged by the PM through /devolps:ship
