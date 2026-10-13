# Quick change: Add a computed `closed` field to `card list --json`

What: `project-companion card list --json` and `card list --open --json` add one boolean field, `closed`, to each card they print. It is computed when the list is printed, by the same `isCardClosed(card, tracks)` call that the text output already uses (`cli/index.ts:1480-1490`, `lib/project/decisions.ts:44`). The tracker log, the `Card` type, `foldCards`, the `--open` filter and the text output do not change. The help line at `cli/index.ts:215` gets a short note.

Why: today a script cannot tell an open card from a closed one using the JSON alone. A track card closes when its track is confirmed, but it never gets an `answer` (checked: after `gate track alerts full`, the card's JSON has no `answer` key, while the text output says `answered`). A script that reads `answer` therefore treats a closed track card as open. That is the same mistake as bug ee2e49d6.

Limits: 1 source file (`cli/index.ts`), 1 new test suite, about 40 changed lines. No schema change, no log change, no new component.

## Requirements
| ID | Requirement (EARS) | Plain English |
|---|---|---|
| CL-01.1 | When `card list --json` prints a card, the CLI shall add a boolean field `closed` whose value equals `isCardClosed(card, tracks)`, with `tracks` read from the same log. | Every card in the JSON says `true` or `false`, and it is the same rule the text list uses. |
| CL-01.2 | If a track card has no answer and its subject's track was confirmed after the card opened, then `card list --json` shall print `"closed": true` for that card. | This is the case that `answer` alone misses: a track card closed by `gate track`. |
| CL-01.3 | If a card has no answer and no track was confirmed for its subject after it opened, then `card list --json` shall print `"closed": false` for that card. | Still-open cards say `false`. This includes a track card opened after the confirmation, and a question card on a subject whose track is confirmed. |
| CL-01.4 | When `card list --json` runs, with or without `--open`, the CLI shall print the same cards, in the same order, with the same field names, values and key order as before this change, and `closed` as the last key of each card. | Nothing that scripts read today moves or changes. The new key is only added at the end. |
| CL-01.5 | When `card list --open --json` runs, the CLI shall print only the cards for which `isCardClosed` is false, each with `"closed": false`. | The `--open` filter works as before, and every card it keeps says `false`. |
| CL-01.6 | When `card list` runs without `--json`, with or without `--open`, the CLI shall print the same text, byte for byte, as before this change. | The PM's text list does not change. |
| CL-01.7 | When `card list` runs, with any of `--open` and `--json`, the CLI shall leave `.project` and every file in `.project-log/` unchanged. | `closed` is worked out when the list is printed. It is never stored. |

Verify (a new suite `tests/card-list-closed.test.ts`, run with `npm test -- card-list-closed`. It follows the `pc` helper in `tests/bug-ee2e49d6.test.ts`: a temp project, a temp `HOME`, no `CLAUDE_PROJECT_DIR`, `PROJECT_COMPANION_NOTIFY=off`, a 10 s timeout):
- CL-01.1: test `CL-01.1: closed matches isCardClosed for every card`. It opens a question card and a track card, answers one, and checks that each printed `closed` is `typeof "boolean"` and equals `isCardClosed` run on `foldCards(readEvents(root))` with `foldGates(...).tracks`.
- CL-01.2: test `CL-01.2: a confirmed track card prints closed true with no answer key`. Steps: `card open --kind track`, then `gate track <subject> full --via prompt:pm`. Expected: `closed === true` and `"answer" in card === false`.
- CL-01.3: test `CL-01.3: unanswered cards print closed false`. It covers a fresh question card, a track card opened after its subject's confirmation, and a question card on a confirmed subject.
- CL-01.4: test `CL-01.4: existing fields keep name, value and order; closed is last`. For each card, `Object.keys(c).at(-1) === "closed"`, and the card with `closed` removed deep-equals `JSON.parse(JSON.stringify(<the foldCards card>))`, with the same key order. It runs for both `--json` and `--open --json`.
- CL-01.5: test `CL-01.5: --open --json holds only closed false cards`. The ids equal the ids in text `card list --open`, and every `closed === false`. The existing tests must also stay green: `npm test -- bug-ee2e49d6` (9/9 today) and `npm test -- devolps-phase3` (30/30 today).
- CL-01.6: test `CL-01.6: text output is unchanged`. It asserts the exact lines `` `${id}  open      auth             Which provider?` `` and `` `${id}  answered  alerts           Which track?` `` for `card list`, and `No cards.` for an empty list. The existing ee2e49d6 plain-text test stays green.
- CL-01.7: test `CL-01.7: card list writes nothing`. It compares a SHA-256 of `.project` and of each `.project-log/*.jsonl` before and after the 4 forms of `card list`.
- Revert check (test rule 6): remove only the `closed` spread in place, keeping every export. CL-01.1, CL-01.2, CL-01.3 and CL-01.5 must then fail.

## Risk
- **Scripts that read every key of the JSON.** Any script that turns every key into a column, or that checks against a strict schema with no extra keys allowed, sees one new key. The known readers all read keys by name, so they are not affected:
  - devolps `plugin/cli/devolps.ts:426,492` reads `id` and `answer`.
  - devolps `plugin/hooks/src/main.ts:519` reads `subject`, `openedAt`, `id` and `ask` from `--open --json`.
  - `tests/bug-ee2e49d6.test.ts` reads `id`.
  - `tests/devolps-phase3.test.ts:304` reads the length.

  Scripts outside these two repositories: UNKNOWN. CL-01.4 keeps every old key, its value and its order, and puts `closed` last, so a positional or old-key reader is not affected.
- **The old `--open` behaviour.** The filter must stay `!has("open") || !isCardClosed(c, tracks)`. If `closed` were computed another way (for example `c.answer !== undefined`), `closed` and `--open` could disagree, and bug ee2e49d6 would come back for JSON readers. CL-01.1 and CL-01.5 tie both to one call.
- **Storing `closed` by mistake.** If the builder adds `closed` to `Card` or to `foldCards`, the cockpit (`cockpit.ts:172`) and the MCP readers would see a stale field. `foldCards` has no `tracks` either. The field must be added only at print time. CL-01.7 and the CL-01.4 deep-equal check catch a stored field.
- **A track confirmation at the card's own millisecond** leaves the card open (`isCardClosed` uses a strict `>`). This is existing behaviour, already covered by `ee2e49d6: isCardClosed: a confirmation at the card's own timestamp leaves it open`.
- **Rollback.** Revert the one commit. Nothing is stored, so no data needs a fix.

## Tasks
- f0770230 — Add a computed `closed` field to `card list --json` — role: backend-engineer — component: none.
- Docs (constitution rule 12), in the same pull request: change the help line at `cli/index.ts:215` to `project-companion card list [--open] [--json]   --json gives each card "closed": true|false`. Check: `node dist/project-companion.mjs --help | grep 'card list'` shows `closed`. A grep of every tracked file for `card list` found no other doc that lists the JSON shape. (The README's "Sprints, cards and updates" block at `README.md:168-177` has no `card list` line. `lib/project/skill-template.ts` and `docs/runbooks/` do not mention it.) The PM answered Q1 "yes": the same pull request also adds one line to `README.md`'s "Sprints, cards and updates" block, `project-companion card list --open --json   # each card has "closed": true or false`. Check: `grep -n 'closed' README.md` shows that line.
- CHANGELOG entry: at release, not in this pull request (this follows the current practice; `/devolps:release` writes it).

## Open questions
- [x] **Q1. Add a README example line?** Answered by the PM on 2026-10-13 in chat: yes (option a). The README line is part of the Docs task above.
