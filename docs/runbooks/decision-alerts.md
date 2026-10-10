# Runbook: decision alerts

A decision alert is one macOS notification that a `gate request` or a `card
open` sends, with the decision's title, its command and the project name —
the same text the PM's cockpit already shows (design 3.3, ADR-0001). This
runbook is for whoever is on call while the PM is away.

## Off switch

Only the exact value `off` of `PROJECT_COMPANION_NOTIFY` turns alerts off
(`lib/project/notify.ts`: `env[NOTIFY_ENV] === "off"`). `OFF`, `0` and
`false` all leave alerts on.

Set it in one of 2 places:

- A shell: `export PROJECT_COMPANION_NOTIFY=off` before the command.
- The `env` block of `.claude/settings.json`, which covers every command the
  EM runs (design section 6, step 4). Only the PM edits `.claude/`.

Drill (proves the switch; touches nothing of this repository's own data):

```sh
npm run build:tools                 # only if dist/ is missing
repo=$(pwd)
drill=$(mktemp -d)
scratch_home=$(mktemp -d)
cd "$drill"
env -u CLAUDE_PROJECT_DIR HOME="$scratch_home" PROJECT_COMPANION_NOTIFY=off \
  node "$repo/dist/project-companion.mjs" init "Drill"
env -u CLAUDE_PROJECT_DIR HOME="$scratch_home" PROJECT_COMPANION_NOTIFY=off \
  node "$repo/dist/project-companion.mjs" card open --subject drill --ask "Off switch drill?"
cat .project-notify/record.jsonl    # one line, with "outcome":"off"
cd "$repo"
rm -rf "$drill" "$scratch_home"
```

No banner shows. Nothing is written to this repository's `.project-log/`,
and the drill project never reaches `~/.claude/project-companion/index.json`:
`HOME` points at a throwaway folder, and with `CLAUDE_PROJECT_DIR` unset the
CLI finds its project only by walking up from `$drill`.

## Notification record

Each attempt appends one line of JSON to `.project-notify/record.jsonl`
(git-ignored). The keys, in order: `id`, `at`, `title`, `command`,
`outcome`, then `reason` — `reason` appears only when `outcome` is `failed`
(`lib/project/notify-record.ts`, `appendRecord`). `outcome` is one of:

- `sent` — `/usr/bin/osascript` started.
- `off` — the off switch (above) was set.
- `unsupported` — the machine is not macOS.
- `failed` — see "When an alert does not appear", below; `reason` says why.

`sent` means only that `osascript` started (`lib/project/notify.ts`,
`dispatch`). It is not proof that the PM saw a banner (TH-18): the record is
a local metric, not an audit trail (TH-12). Git ignores the file. A reader
splits lines on `\n` only — one `JSON.stringify` call per line keeps a
title's own line breaks from forging an extra line (TH-15). Deleting the
file loses only metric history.

## Rollback

1. Off switch, no code: set `PROJECT_COMPANION_NOTIFY=off` as above. This
   takes effect at once and needs no pull request. It does not stop the
   text lookup that builds the title and command — see below.
2. Remove the 2 CLI calls, only if step 1 is not enough. PR #17 (squash
   commit `4ad07e9` on `master`) added them to `cli/index.ts`. Open a pull
   request that reverses only that file's change, removes the CLI tests
   that expect a notification (DA-01.1 and DA-01.2 in `tests/notify.test.ts`),
   and updates the README paragraph (DA-03.4). Take it through the PM's
   merge gate. Never revert the whole of `4ad07e9`: it also holds tracker
   log lines, PRD ticks and a QA report, and it no longer reverts cleanly.

   ```sh
   d=$(mktemp -d)
   git clone -q "$(git remote get-url origin)" "$d"
   git -C "$d" show 4ad07e9 -- cli/index.ts | git -C "$d" apply -R --check
   echo "exit=$?"    # 0: the cli/index.ts change still reverses cleanly
   rm -rf "$d"
   ```

The off switch does not stop the text lookup: every `gate request` or
`card open` still re-reads the cockpit, the gate artifacts and the PRD
source. The SR-8 fix (bug d5ebde85, PR #22) reads an artifact or the PRD
source only when it is a regular file inside the project root. Of its 3
residuals (threat model TH-7): 1 and 2 are accepted (card c-73ccab);
residual 3 — log shards and `.project` still read through a symlink or a
device — is open as bug 54b4e811.

## When an alert does not appear

Read the last line of `.project-notify/record.jsonl` for the decision's id.

| Last line for this id | Next step |
|---|---|
| `"outcome":"failed"` | Read `reason`, and match it to the standard error line below. It names a step and an error code, never the title, the command or the project name (TH-5). |
| `"outcome":"off"` | The off switch is set somewhere in this command's environment. Check the shell and `.claude/settings.json`. |
| `"outcome":"unsupported"` | The machine that ran the command is not macOS. |
| `"outcome":"sent"` | `osascript` started. Check macOS's Notification settings and Focus; both decide whether a banner shows on screen (TH-18). Which app macOS lists for `osascript` is UNKNOWN (design section 6, step 3). |
| No line at all, or none for this id | The command may have failed before the alert ran, or the record write itself failed. Check the command's own output first, then the standard error line below. |

Standard error, exactly as the code writes it (`lib/project/notify.ts`):

- `project-companion: notification not sent: ` — the notifier did not
  start; the rest of the line names a step and a code.
- `project-companion: notification record not written: ` — the line above
  was decided, but writing it to `.project-notify/record.jsonl` failed; the
  rest of the line names a code and the path.

A reason on either line never holds the title, the command or the project
name (TH-5): it is safe to paste into a message to the PM.
