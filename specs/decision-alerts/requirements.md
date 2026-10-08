# Requirements: Decision alerts

## Context

Bottom line: each time the tracker records a new decision for the PM, the PM's Mac shows a desktop notification. It has the same title and command that the cockpit shows. The PM still decides by typing the command in Claude Code.

- Track: Full, confirmed by the PM on 2026-10-08. There is no PR/FAQ.
- Source: the idea brief `docs/ideas/0001-decision-alerts.md`, option 1 (the recommended first slice).
- PRD section: `docs/prd.md`, "Phase: Decision alerts".

The problem today (idea brief):
- The PM learns that a decision waits only from the cockpit page (`/project/cockpit`) or from the line that a Claude Code session shows at start.
- The cockpit page refreshes only while its tab is visible. The session line lists requested gates, but not question cards or track cards.
- While the PM does not look, the work behind the decision stops. The cost in hours is UNKNOWN, because no gate was requested in this repository yet.

Facts from the code that shape these requirements:
- Decisions are created in two places only: `project-companion gate request` and `project-companion card open` (`cli/index.ts`). The MCP server has no tool that creates a gate or a card.
- The cockpit makes each decision's `title` and `command` in `lib/project/cockpit.ts`: `GATE_TEXT` for gates, and the card's question plus an answer or track command for cards. `project-companion cockpit --json` prints them in `needsYou`. The notification must use the same text, so the two never disagree.
- A new request on an existing gate reopens it (`foldGates` in `lib/project/gate.ts`). So each `gate request` is a new decision.
- The existing suites run `gate request` and `card open` through the CLI (`tests/gate.test.ts`). Without an off switch, `npm test` on the PM's Mac would show test notifications.
- The repository has no CI workflow yet. `.github/` holds only a pull-request template. The off switch must work for any CI that is added later.
- The README says: "Deleting `.project-cache/` may only ever change latency, never an answer." A record that a success metric counts must not be kept there.

Testability: a person sees a notification, but a test cannot. So the criteria state what a test can see: what the CLI passes to the system notifier, what it records, its exit code and its output. The design must give tests a way to replace the macOS notifier with a stub that records what it receives.

Words used here:
- **Decision**: a gate request, an open question card or an open track card.
- **System notifier**: the macOS program that shows the notification. The design chooses it.
- **Off switch**: the environment variable `PROJECT_COMPANION_NOTIFY` with the value `off`.
- **Notification record**: the list of notifications that the CLI handled (DA-04).

## Goals and non-goals

Goals:
1. The PM's Mac shows a notification each time the tracker records a new decision.
2. The notification shows the decision's title, the command that answers it and the project name, as the cockpit shows them.
3. A problem in the notifier never fails, slows or changes the `gate request` or `card open` command.
4. Tests and CI can turn notifications off.
5. The tracker keeps a record of each notification, so that we can measure the outcome.

Non-goals (from the idea brief):
- No Slack, email or phone push. Each one needs an outside service and an account, and none is set up.
- No decisions from a notification. The PM still types the command in Claude Code. The cockpit is read-only (devolps decision Q4).
- No notifications on a second computer.
- No repeated reminders on a timer.
- No change to the session-start line. That is option 3 of the brief, a separate change in the devolps repository.

Not in this slice, by the PM's answers of 2026-10-08:
- Browser notifications from the cockpit page (Q1).
- Notifications for stale approvals, a late weekly update, or a decision that waits more than 2 working days (Q2).
- A rate limit or quiet hours of our own (Q3).
- Linux and Windows (Q4).

## Users and journeys

**The PM**, on the Mac where the agents run.
1. The PM works in another app. The Engineering Manager requests the PRD gate for an epic.
2. macOS shows a notification with the title `Approve the requirements for "decision-alerts"`, the command `/devolps:approve prd decision-alerts` and the project name.
3. The PM opens Claude Code and types the command. The notification does not decide anything.
4. If macOS Focus is on, macOS holds or hides the notification by its own rules. The cockpit still lists the decision.

**The Engineering Manager (EM)**, which runs `gate request` and `card open`.
1. The EM runs the command as today. Its output and exit code do not change.
2. If the notification cannot be sent, the EM sees one line on standard error, and the command still succeeds. The EM reports the line to the PM.

**A builder or QA agent**, which runs `npm test`.
1. The test runner sets the off switch. No test notification reaches the PM.
2. The `notify` suite turns the switch back on only for a stub notifier, to prove what a real notifier would receive.

**A CI job** (none exists yet).
1. The job sets the off switch, or runs on a system that is not macOS. The job sends nothing and does not fail because of notifications.

## Requirements

Each feature below is a feature in `docs/prd.md`, phase "Decision alerts". The new suite `tests/notify.test.ts` proves every criterion: `npm test -- notify`. The PM answered open questions Q1 to Q5 on 2026-10-08, and the criteria follow those answers.

### DA-01 Notify on a new decision (`decision-notify`)

| ID | Requirement (EARS) | Plain English |
|---|---|---|
| DA-01.1 | When `project-companion gate request` records a gate request, the CLI shall pass one notification for that gate to the system notifier. | Each new gate request makes one notification on the PM's Mac. |
| DA-01.2 | When `project-companion card open` records a question card or a track card, the CLI shall pass one notification for that card to the system notifier. | Each new question card or track card makes one notification. |
| DA-01.3 | The notification shall contain the decision's title, its command and the project name, with the same text that `project-companion cockpit --json` shows in its `needsYou` and `project` fields. | The notification says what the cockpit says, word for word, so the PM can type the command it shows. |
| DA-01.4 | If `gate request` or `card open` refuses its input and records nothing, then the CLI shall pass no notification. | A request that failed does not alert the PM. |
| DA-01.5 | The CLI shall pass notifications only from the `gate request` and `card open` commands. | Approvals, refusals, answers, status reads and the cockpit send nothing. Stale approvals, late updates and old decisions send nothing in this slice. |
| DA-01.6 | When decisions are recorded one after another, the CLI shall pass one notification for each decision, with no limit, delay or quiet hours of its own. | Five requests make five notifications. macOS Focus decides what the PM sees. |

Test notes:
- DA-01.3 runs `gate request` for each gate kind (prd, design, sprint, merge, release) and `card open` for a question card and a track card. Then it compares the stub's text with `cockpit --json`.
- DA-01.5 runs `gate approve`, `gate refuse`, `gate track`, `card answer`, `gate status` and `cockpit` with the stub, and expects zero calls.

### DA-02 Safe delivery (`notify-safety`)

| ID | Requirement (EARS) | Plain English |
|---|---|---|
| DA-02.1 | If the system notifier cannot start, or the notification record cannot be written, then the CLI shall exit with the same exit code and write the same standard output as it does with the off switch set. | A broken notifier never breaks the EM's command or its `--json` output. |
| DA-02.2 | If the system notifier cannot start, then the CLI shall write one line to standard error that says no notification was sent and why. | The EM can see a broken notifier and report it. |
| DA-02.3 | When the CLI passes a notification to the system notifier, the CLI shall exit without waiting for the system notifier to finish. | A slow or stuck notifier never holds up the command. |
| DA-02.4 | If a title, command or project name contains quotes, backslashes or line breaks, then the notifier shall deliver that text unchanged and run no part of it as code. | A card question that an agent wrote cannot run commands on the PM's Mac. |
| DA-02.5 | The notifier shall append no gate, track or card event to the event log. | Sending a notification never records or changes a decision. |

Test notes:
- DA-02.1 and DA-02.2 use a notifier path that does not exist, and a record path that cannot be written.
- DA-02.3 uses a stub that waits until the test releases it. The command must exit while the stub still waits. No timing number is needed.
- DA-02.4 opens a card whose question contains `"`, `\`, a line break and AppleScript text. The stub must receive the text unchanged, and the text must reach the system notifier only as an argument, never inside script source.

### DA-03 Off switch and systems (`notify-switch`)

| ID | Requirement (EARS) | Plain English |
|---|---|---|
| DA-03.1 | While the environment variable `PROJECT_COMPANION_NOTIFY` has the value `off`, the CLI shall pass no notification. | Tests, CI or the PM can turn notifications off for one shell. |
| DA-03.2 | When `npm test` runs a suite, the test runner shall set `PROJECT_COMPANION_NOTIFY` to `off` for that suite. | Running the tests never shows notifications to the PM. |
| DA-03.3 | If the CLI runs on a system other than macOS, then the CLI shall pass no notification and exit with the exit code and standard output that it gives with the off switch set. | On Linux or Windows, nothing is sent and nothing fails. |
| DA-03.4 | The README section "Gates, sprints and the PM cockpit" shall name the commands that send a notification, the off switch and the supported systems. | The PM and the agents can find how alerts work and how to turn them off. |

Test notes:
- DA-03.2 is a test in the suite that reads the variable that the runner set.
- DA-03.3 runs the notifier with the system set to `linux` and to `win32`.
- DA-03.4 is a test in the suite that reads `README.md`.

### DA-04 Notification record (`notify-record`)

| ID | Requirement (EARS) | Plain English |
|---|---|---|
| DA-04.1 | When `gate request` or `card open` records a decision, the CLI shall add one line of JSON to the notification record with the decision id, the time, the title, the command and the outcome `sent`, `off`, `unsupported` or `failed`. | We can count which decisions were notified, and why the others were not. `sent` means the CLI passed the notification to macOS. It does not prove that the PM saw it. |
| DA-04.2 | The notification record shall be a file in the project that git ignores, outside `.project-cache/` and `.project-log/`. | The record stays on this Mac, is not committed, and is not lost when the cache is cleaned. |

Test notes:
- DA-04.1 checks one line for each decision, once for each outcome.
- DA-04.2 runs `git check-ignore` on the record path.

## Open questions

- [x] Q1 Channel: where does the notification appear? — options: (a) macOS desktop only / (b) the cockpit page in the browser only / (c) both — recommendation: (a), because it reaches the PM away from the terminal and the browser and needs no running server. The browser option works only while the cockpit page is open and the local server runs, and the page must keep checking while its tab is hidden (idea brief). — affects: DA-01.1, DA-01.2. Option (b) or (c) adds a browser feature. — answered: (a) macOS desktop only, card c-189e41, 2026-10-08.
- [x] Q2 Events: which events send a notification? — options: (a) new gate requests and new question or track cards only / (b) also stale approvals, a late weekly update, and decisions that wait more than 2 working days — recommendation: (a), because the tracker finds stale approvals and late updates only when something reads the gates or the updates. So (b) needs a timed check, and timed reminders are a non-goal. The 2 working days is `DECISION_WAIT_LIMIT` in `lib/project/cockpit.ts`, which the code calls a placeholder. — affects: DA-01.5. — answered: (a) new gate requests and new question or track cards only, card c-ef73c0, 2026-10-08.
- [x] Q3 Limits and quiet hours: — options: (a) one notification for each new decision; macOS Focus decides when to show it / (b) our own rate limit and quiet hours — recommendation: (a), because the PM already controls Focus, and we have no data on how many decisions arrive in an hour (UNKNOWN: no gate was requested in this repository yet). Option (b) needs numbers that only the PM can give. — affects: DA-01.6. — answered: (a) one notification for each new decision; macOS Focus decides when to show it, card c-3a827d, 2026-10-08.
- [x] Q4 Systems: — options: (a) macOS only; other systems send nothing and do not fail the command / (b) also Linux and Windows — recommendation: (a), because the agents run on the PM's Mac (idea brief), and Linux and Windows support is UNKNOWN. — affects: DA-01.1, DA-01.2, DA-03.3. — answered: (a) macOS only, card c-610a60, 2026-10-08.
- [x] Q5 Notification record: where is it kept? — options: (a) the committed event log `.project-log/` / (b) a local file that git ignores — recommendation: (b), because a notification is a fact about one Mac. The event log is a shared, hash-chained history that every clone merges, and test and CI runs would add entries to it. The cost of (b): the record is only on the PM's Mac, so the first success metric can be measured only there. — affects: DA-04.1, DA-04.2, and the first success metric. — answered: (b) a local file that git ignores, card c-a9d4a9, 2026-10-08.

## Success metrics

| Metric | Target | Source of the target | How we measure |
|---|---|---|---|
| Decisions with a `sent` record | Every gate request and every question or track card opened on the PM's Mac during one sprint | Idea brief, "Outcome" | Compare the `gate.requested` and `card.opened` events in `.project-log/` for the sprint dates with the notification record. |
| Median gate wait | 1 working day or less | devolps PRD, section 6 (quoted in the idea brief) | `project-companion gate metrics` (median wait for each gate), over the same sprint. Baseline: UNKNOWN, because no gate was requested in this repository yet. |
| `gate request` or `card open` commands that fail because of the notifier | 0 | DA-02.1 | `npm test -- notify`, and the EM's reports during the sprint. |

A `sent` record means that the CLI passed the notification to macOS. It does not prove that the PM saw it.
