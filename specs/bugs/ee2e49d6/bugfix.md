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

A shared helper, `isCardClosed(card, tracks)` in `lib/project/decisions.ts`, holds the one rule: a card is closed
when `card.answer` is set, or when it is a track card and `tracks.get(card.subject)?.at` is newer than
`card.openedAt`. Its callers:

- `cli/index.ts`, `card list --open`: the filter is `!has("open") || !isCardClosed(c, tracks)`, with `tracks` read
  from `readGates(root).tracks`.
- `cli/index.ts`, plain-text `card list`: shows `answered` when `isCardClosed` is true, else `open`.
- `lib/project/cockpit.ts`, `buildCockpit`: `if (isCardClosed(c, gates.tracks)) continue;` replaces its own copy of
  the rule, so the two readers cannot drift apart.

A card opened after the confirmation stays open (its `openedAt` is newer than the track's `at`). A question card
is never closed by a track confirmation.

PM decision (card c-0fe3e6): the read rule alone fixes every existing project. No stored answer, no log write.
The open question that was here is removed.

## Regression test

`tests/bug-ee2e49d6.test.ts`, 4 tests:

- `ee2e49d6: card list --open still shows a track card after its track is confirmed` -- opens a track card,
  confirms its track, asserts the id is gone from `card list --open --json`. This test failed before the fix.
- `ee2e49d6: the cockpit's needs-you list already drops the same card (control)` -- the same sequence, read
  through `cockpit --json`.
- `ee2e49d6: a track card opened again after the confirmation stays open` -- a second track card for the same
  subject, opened after the confirmation, stays on the open list.
- `ee2e49d6: a question card is not closed by a track confirmation; plain text says answered for a closed track card`
  -- only the question card stays open; plain `card list` prints `answered` for the closed track card and `open`
  for the question card.

The suite spawns the built CLI in a temporary project under `os.tmpdir()`. Each CLI call gets
`PROJECT_COMPANION_NOTIFY=off`, `HOME` set to a folder inside the suite's temporary folder, and no
`CLAUDE_PROJECT_DIR` (test rule 5). Each call has a 20 s timeout (test rule 3).

```
$ npm test -- bug-ee2e49d6      (head f22c59d)
  ok   ee2e49d6: card list --open still shows a track card after its track is confirmed
  ok   ee2e49d6: the cockpit's needs-you list already drops the same card (control)
  ok   ee2e49d6: a track card opened again after the confirmation stays open
  ok   ee2e49d6: a question card is not closed by a track confirmation; plain text says answered for a closed track card
4/4 passed
```

Before the fix (commit 4c37e22, the 2-test version): `1/2 passed`; the first test fails with "a confirmed track
card must leave card list --open: expected false, got true".
