# Story: A notifier problem never fails, slows or changes the command
Epic: decision-alerts   Feature: notify-safety   Points: 5
From: [Requirements, DA-02](../requirements.md#da-02-safe-delivery-notify-safety); [Design 3.2, Flow 2](../design.md#32-sequences-mermaid); [Design 3.3, "Outcome precedence", "Dispatch" and "Standard error lines"](../design.md#33-data-model-and-api-contracts); [Design 3.4, test seams and test notes](../design.md#34-components-and-paths); [Design 6, step 5](../design.md#6-rollout-and-rollback); [Threat model, TH-5, TH-7, TH-8, TH-16](../threat-model.md#threat-model-decision-alerts)
Estimate: 5 points, because this story has the most failure cases in the epic: one `try`/`catch`, detached dispatch and 9 reason texts (design 3.3), with tests for a missing notifier, a record that cannot be written, a held stub and the event log, and the 2 TH-5 tests (in process in da-t6, through the CLI in da-t8).
## Criteria
| ID | Requirement (EARS) | Plain English |
|---|---|---|
| DA-02.1 | If the system notifier cannot start, or the notification record cannot be written, then the CLI shall exit with the same exit code and write the same standard output as it does with the off switch set. | A broken notifier never breaks the EM's command or its `--json` output. |
| DA-02.2 | If the system notifier cannot start, then the CLI shall write one line to standard error that says no notification was sent and why. | The EM can see a broken notifier and report it. |
| DA-02.3 | When the CLI passes a notification to the system notifier, the CLI shall exit without waiting for the system notifier to finish. | A slow or stuck notifier never holds up the command. |
| DA-02.5 | The notifier shall append no gate, track or card event to the event log. | Sending a notification never records or changes a decision. |

Verify: `npm test -- notify` (requirements, "Requirements": the suite `tests/notify.test.ts` proves every criterion).
Test notes (requirements, DA-02): "DA-02.1 and DA-02.2 use a notifier path that does not exist, and a record path that cannot be written." "DA-02.3 uses a stub that waits until the test releases it. The command must exit while the stub still waits. No timing number is needed."
## Tasks
- 02d2e84e (da-t6) — Report notifier failures without echoing decision text — role: backend-engineer — component: notifier
- 6042a875 (da-t8) — Prove a failed or slow notifier leaves the CLI unchanged — role: qa-engineer — component: notifier
## Done means
- Every criterion passes its check
- Tests pass
- Review findings resolved
- Docs updated, or no docs impact
- Merged by the PM through /devolps:ship
