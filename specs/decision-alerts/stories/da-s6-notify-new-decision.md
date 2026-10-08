# Story: Notify the PM of each new decision
Epic: decision-alerts   Feature: decision-notify   Points: 5
From: [Requirements, DA-01](../requirements.md#da-01-notify-on-a-new-decision-decision-notify); [Design 3.1](../design.md#31-c4-context--container--component-mermaid); [Design 3.2, Flow 1](../design.md#32-sequences-mermaid); [Design 3.3, "Entry point" and "Call sites"](../design.md#33-data-model-and-api-contracts); [Design 3.4](../design.md#34-components-and-paths); [Design 6, steps 1 to 4](../design.md#6-rollout-and-rollback)
Estimate: 5 points, because this is the main path (`notifyDecision`, `decisionText` and the 2 CLI calls, design 3.3), with CLI tests for 5 gate kinds, 2 card kinds, refused input, 6 other commands and decisions in a row.
## Criteria
| ID | Requirement (EARS) | Plain English |
|---|---|---|
| DA-01.1 | When `project-companion gate request` records a gate request, the CLI shall pass one notification for that gate to the system notifier. | Each new gate request makes one notification on the PM's Mac. |
| DA-01.2 | When `project-companion card open` records a question card or a track card, the CLI shall pass one notification for that card to the system notifier. | Each new question card or track card makes one notification. |
| DA-01.3 | The notification shall contain the decision's title, its command and the project name, with the same text that `project-companion cockpit --json` shows in its `needsYou` and `project` fields. | The notification says what the cockpit says, word for word, so the PM can type the command it shows. |
| DA-01.4 | If `gate request` or `card open` refuses its input and records nothing, then the CLI shall pass no notification. | A request that failed does not alert the PM. |
| DA-01.5 | The CLI shall pass notifications only from the `gate request` and `card open` commands. | Approvals, refusals, answers, status reads and the cockpit send nothing. Stale approvals, late updates and old decisions send nothing in this slice. |
| DA-01.6 | When decisions are recorded one after another, the CLI shall pass one notification for each decision, with no limit, delay or quiet hours of its own. | Five requests make five notifications. macOS Focus decides what the PM sees. |

Verify: `npm test -- notify` (requirements, "Requirements": the suite `tests/notify.test.ts` proves every criterion).
Test notes (requirements, DA-01): "DA-01.3 runs `gate request` for each gate kind (prd, design, sprint, merge, release) and `card open` for a question card and a track card. Then it compares the stub's text with `cockpit --json`." "DA-01.5 runs `gate approve`, `gate refuse`, `gate track`, `card answer`, `gate status` and `cockpit` with the stub, and expects zero calls."
## Tasks
- bdcf995e (da-t7) — Notify the PM from gate request and card open — role: backend-engineer — component: agent-tooling
## Done means
- Every criterion passes its check
- Tests pass
- Review findings resolved
- Docs updated, or no docs impact
- Merged by the PM through /devolps:ship
