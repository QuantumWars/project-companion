# Story: Decision text never runs as code
Epic: decision-alerts   Feature: notify-safety   Points: 2
From: [Requirements, DA-02](../requirements.md#da-02-safe-delivery-notify-safety); [Design 3.3, "Notifier program and arguments" and "Dispatch"](../design.md#33-data-model-and-api-contracts); [Design 3.4, test notes for DA-02.4](../design.md#34-components-and-paths); [ADR-0001](../../../docs/adr/0001-macos-notifier-osascript-argv.md); [Threat model, TH-1](../threat-model.md#threat-model-decision-alerts)
Estimate: 2 points, because the code is a fixed list of 10 arguments (design 3.3), and the design states both tests in full: the stub test and the required osascript test with 4 input lists (design 3.4).
## Criteria
| ID | Requirement (EARS) | Plain English |
|---|---|---|
| DA-02.4 | If a title, command or project name contains quotes, backslashes or line breaks, then the notifier shall deliver that text unchanged and run no part of it as code. | A card question that an agent wrote cannot run commands on the PM's Mac. |

Verify: `npm test -- notify` (requirements, "Requirements": the suite `tests/notify.test.ts` proves every criterion).
Named test (design 3.4, required): `DA-02.4: osascript passes every argument after -- unchanged`.
Test note (requirements, DA-02): "DA-02.4 opens a card whose question contains `"`, `\`, a line break and AppleScript text. The stub must receive the text unchanged, and the text must reach the system notifier only as an argument, never inside script source."
## Tasks
- (the EM adds task ids after the architect proposes tasks)
## Done means
- Every criterion passes its check
- Tests pass
- Review findings resolved
- Docs updated, or no docs impact
- Merged by the PM through /devolps:ship
