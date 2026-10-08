# Story: Keep a local record of each notification
Epic: decision-alerts   Feature: notify-record   Points: 3
From: [Requirements, DA-04](../requirements.md#da-04-notification-record-notify-record); [Design 3.2, Flow 2](../design.md#32-sequences-mermaid); [Design 3.3, "Record line" and "Record write"](../design.md#33-data-model-and-api-contracts); [Design 3.4](../design.md#34-components-and-paths); [Threat model, TH-13, TH-15, TH-21](../threat-model.md#threat-model-decision-alerts)
Estimate: 3 points, because the change is a new module of about 70 lines with a 4-step write that refuses symlinks (design 3.3, 3.4), and tests for the 4 outcomes and threats TH-13, TH-15 and TH-21.
## Criteria
| ID | Requirement (EARS) | Plain English |
|---|---|---|
| DA-04.1 | When `gate request` or `card open` records a decision, the CLI shall add one line of JSON to the notification record with the decision id, the time, the title, the command and the outcome `sent`, `off`, `unsupported` or `failed`. | We can count which decisions were notified, and why the others were not. `sent` means the CLI passed the notification to macOS. It does not prove that the PM saw it. |
| DA-04.2 | The notification record shall be a file in the project that git ignores, outside `.project-cache/` and `.project-log/`. | The record stays on this Mac, is not committed, and is not lost when the cache is cleaned. |

Verify: `npm test -- notify` (requirements, "Requirements": the suite `tests/notify.test.ts` proves every criterion).
Test notes (requirements, DA-04): "DA-04.1 checks one line for each decision, once for each outcome." "DA-04.2 runs `git check-ignore` on the record path."
## Tasks
- 398705ee (da-t3) — Add the notification record with a symlink-safe append — role: backend-engineer — component: notifier
- 1b3763e7 (da-t9) — Prove one record line per decision for each outcome — role: qa-engineer — component: notifier
## Done means
- Every criterion passes its check
- Tests pass
- Review findings resolved
- Docs updated, or no docs impact
- Merged by the PM through /devolps:ship
