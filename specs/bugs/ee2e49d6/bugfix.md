# Bug: a confirmed track card never leaves `card list --open`

## Observed

`project-companion card list --open` still shows `c-31ea34 open decision-alerts Which track should Decision
alerts take?`, even though `gate status` shows `track decision-alerts full` -- the PM confirmed the track on
2026-10-08. The card stays "open" and stays on the PM's list. The EM observed the same for `c-dbab2b` (subject
`ci`, confirmed `quick`) on 2026-10-09.

## Expected

A track card closes -- leaves `card list --open` -- once its subject's track is confirmed. This already holds
for the cockpit's "needs you" list: `buildCockpit` (`lib/project/cockpit.ts:171-174`) drops a track card once
`gates.tracks.get(c.subject)` is newer than the card, and `tests/devolps-phase3.test.ts`'s existing test "needs
you: a track card closes when the track is confirmed" proves it. `project-companion card list --open` is a
second, older reader of the same two events (`card.opened` and `track.confirmed`) and must agree with the
cockpit, so the PM sees one answer, not two, for the same decision.

Requirement ID: **UNKNOWN**. I read `specs/decision-alerts/requirements.md` in full: its DA-01..DA-04 criteria
cover notifications (what fires one, what it contains, when it is suppressed, what is recorded) -- none of them
states that a track card closes, or that `card list --open` and the cockpit must agree on which cards are open.
`docs/prd.md` names no "Cockpit" or "Decision cards" phase at all; the only PRD text about cards is the
Decision-alerts phase's notification text (lines 377-390), which is also not this behaviour. The nearest thing
to a requirement is the code comment on `lib/project/decisions.ts` and `lib/project/cockpit.ts`
("devolps TR-14, PC-01, PC-06" / "PC-01..PC-11"), from the commit that introduced cards (`1a249a5`, "devolps
Phase 3"), but no `requirements.md` for that work was ever committed to this repository, so those ids cannot be
checked here. This should be flagged to the PM/EM: either that commit's ids get a requirements doc before this
bug is built, or `docs/prd.md` gets a line for "a track card closes when its track is confirmed" so the next
bug in this area has an id to cite.

## Steps to reproduce

1. `project-companion init Demo` (or `initProject` directly) in a fresh project.
2. `project-companion card open --subject alerts --ask "Which track?" --kind track --json` -- note the id it
   returns.
3. `project-companion gate track alerts full --via prompt:pm`.
4. `project-companion card list --open --json`.
5. Observe: the card id from step 2 is still in the list, and in the plain-text `card list --open` output it
   still prints `open    `. `gate status --json` already shows `alerts` on track `full`.

## Root cause

`project-companion card list` (`cli/index.ts:1448-1449,1474`) builds its list from `foldCards(readEvents(root))`
alone, and filters with:

```ts
const list = Array.from(cards.values()).filter((c) => !has("open") || c.answer === undefined);
```

`foldCards` (`lib/project/decisions.ts:36-61`) only ever sets a card's `answer` from a `card.answered` event
(line 55-60). A track is confirmed with `project-companion gate track`, which calls `confirmTrack`
(`lib/project/gate.ts:353-359`): it appends a `track.confirmed` event carrying `{ subject, track, via }` -- no
`cardId` -- so `foldCards` has nothing in that event it can match to the card (its own `id` lookup at line 40
requires `d.cardId`), and the track card's `answer` stays `undefined` forever. `card list --open`'s filter sees
only `c.answer === undefined` and keeps the card.

`buildCockpit` (`lib/project/cockpit.ts:171-174`) does not have this gap, because it reads both `foldCards(...)`
and `readGates(...).tracks` and cross-references them:

```ts
if (c.answer !== undefined) continue;
// A track card is answered by confirming the track.
if (c.kind === "track" && (gates.tracks.get(c.subject)?.at ?? 0) > c.openedAt) continue;
```

`readGates` (`lib/project/gate.ts:186-196`) folds `track.confirmed` into a separate `tracks` map keyed by
`subject`, which is exactly the lookup `card list --open` is missing. The two readers of the same event log
disagree because only one of them joins `card.opened`/`card.answered` with `track.confirmed`.

## Fix

Out of scope for this spec (bugfix track: spec first, code by the builder). The fix belongs in
`cli/index.ts`'s `card` command: before filtering, read `readGates(root).tracks` (as `cockpit.ts` already does)
and treat a track card as closed when `gates.tracks.get(card.subject)?.at` is newer than `card.openedAt` --
either by reusing the exact rule cockpit.ts uses, or by moving that rule into a shared helper (for example
exporting it from `lib/project/decisions.ts` or `lib/project/cockpit.ts`) that both `cli/index.ts` and
`cockpit.ts` call, so the two can no longer drift apart again. The plain-text `card list` output
(`cli/index.ts:1483`, `c.answer === undefined ? "open    " : "answered"`) should also show a confirmed track
card as answered/closed, not "open", for the same reason.

Open question for the PM/architect: should a track card that was confirmed before this fix ships get a
retroactive `answer`, or does the new read rule alone fix every existing project without a data change? (No
`.project`/`.project-log` file was touched for this spec, per the bugfix track's write scope.)

## Regression test

`tests/bug-ee2e49d6.test.ts`, 2 tests:

- `ee2e49d6: card list --open still shows a track card after its track is confirmed` -- opens a track card,
  confirms its track with `gate track ... --via`, then asserts the card id is gone from `card list --open
  --json`. This is the failing test; it proves the bug as named above.
- `ee2e49d6: the cockpit's needs-you list already drops the same card (control)` -- same sequence, read through
  `cockpit --json`'s `needsYou` instead, to show that the cockpit already gets this right and the two surfaces
  disagree only because of `cli/index.ts`'s `card` command.

Both tests spawn the built CLI (`dist/project-companion.mjs`) in a temporary project under `os.tmpdir()`, never
the real `.project` of this repository. The suite refuses to run unless `PROJECT_COMPANION_NOTIFY` is already
`off` (set by the test runner), never writes `process.env` itself, and every spawned CLI call is given an
explicit `PROJECT_COMPANION_NOTIFY=off` and a `HOME` inside the suite's own temporary folder, so `card open`'s
one notification (DA-01.2) is never shown to the PM.

```
$ npm test -- bug-ee2e49d6
...
bug-ee2e49d6.test.ts
  FAIL ee2e49d6: card list --open still shows a track card after its track is confirmed
       a confirmed track card must leave card list --open: expected false, got true
  ok   ee2e49d6: the cockpit's needs-you list already drops the same card (control)

1/2 passed
```
Exit code: 1.
