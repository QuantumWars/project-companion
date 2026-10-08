# Decision alerts: tell the PM when a decision waits

Problem: Today the PM learns that a decision waits only from the cockpit or from the line shown when a Claude Code session starts. The cockpit page refreshes only while its tab is visible. The session line lists requested gates, but not question cards or stale approvals. While the PM does not look, the work behind the decision stops. The cost in hours is UNKNOWN: no gate was requested in this repository yet.

Users: The PM, on the Mac where the agents run. The Engineering Manager, who records each gate request and card.

Appetite: 1 sprint (a proposal; the PM decides).

Outcome: We will know it works when, for one sprint, the tracker records a notification for every gate request and question card in that sprint, and the median gate wait is 1 working day or less (target from the devolps PRD, section 6).

Non-goals: No Slack, email or phone push, because each needs an outside service and an account, and none is set up. No decisions from a notification: the PM still types the command in Claude Code (the cockpit is read-only, devolps decision Q4). No notifications on a second computer. No repeated reminders on a timer.

Options considered:
1. Desktop notification when the tracker records a gate request or opens a card. It uses the notifications built into macOS, so it needs no outside service. It does not catch stale approvals, because the tracker finds those only when it reads the gates. Linux and Windows support is UNKNOWN.
2. Browser notification from the cockpit page. It works only while the page is open and the local server runs, and the page must keep checking while its tab is hidden.
3. A session-start line that also lists question cards and stale approvals. This changes the devolps plugin, where role agents cannot write (Phase 5 decision record, P1).

The weekly update is too slow: it comes once a week, and the target wait is 1 working day.

Recommendation: Go, with option 1 as the first slice. It reaches the PM away from the terminal and the browser, needs no new service, and changes only the tracker. It shows the cockpit's title and command. Option 3 is a small, separate change in the devolps repository. Before the PRD, the PM chooses the channels, the events and the quiet hours.
