# Runbook: decision alerts

A decision alert is one macOS notification from a `gate request` or a `card
open`. It holds the title, command and project name that the cockpit shows
(design 3.3, ADR-0001). This runbook is for whoever is on call.

## Off switch

Only the exact value `off` of `PROJECT_COMPANION_NOTIFY` turns alerts off
(`lib/project/notify.ts`). `OFF`, `0` and `false` leave alerts on. Set it in
one of 2 places:

- A shell: `export PROJECT_COMPANION_NOTIFY=off`. It covers only later
  commands in that same shell. Each Claude Code Bash call starts a new
  shell, so an export does not reach the EM's commands.
- The `env` block of `.claude/settings.json`. This is the only way to cover
  the EM's commands (design section 6, step 4). Only the PM edits `.claude/`.

Drill (proves the switch; touches none of this repository's data):

```sh
( set -eu
repo=$(pwd)
test -f dist/project-companion.mjs || npm run build:tools
drill=$(mktemp -d)
scratch_home=$(mktemp -d)
cd "$drill"
env -u CLAUDE_PROJECT_DIR HOME="$scratch_home" PROJECT_COMPANION_NOTIFY=off \
  node "$repo/dist/project-companion.mjs" init "Drill"
env -u CLAUDE_PROJECT_DIR HOME="$scratch_home" PROJECT_COMPANION_NOTIFY=off \
  node "$repo/dist/project-companion.mjs" card open --subject drill --ask "Off switch drill?"
cat .project-notify/record.jsonl
rm -rf "$drill" "$scratch_home"
)
```

Run it from the repository root. It stops at the first failure. The `cat`
prints one line, with `"outcome":"off"`. No banner shows. Nothing reaches
this repository's `.project-log/` or `~/.claude/project-companion/index.json`:
`HOME` is a throwaway folder, and `CLAUDE_PROJECT_DIR` is unset.

## Notification record

Each attempt appends one JSON line to `.project-notify/record.jsonl`, which
git ignores. The keys, in order: `id`, `at`, `title`, `command`, `outcome`,
then `reason`, only when `outcome` is `failed` (`appendRecord` in
`lib/project/notify-record.ts`). `outcome` is one of:

- `sent` — `/usr/bin/osascript` started.
- `off` — the off switch (above) was set.
- `unsupported` — the machine is not macOS.
- `failed` — see "When an alert does not appear"; `reason` says why.

`sent` means only that `osascript` started (`dispatch` in
`lib/project/notify.ts`). It is not proof that the PM saw a banner (TH-18).
The record is a local metric, not an audit trail (TH-12). Read it by
splitting on `\n` only (TH-15). Deleting the file loses only history.

## Rollback

1. Off switch, no code: the PM sets `PROJECT_COMPANION_NOTIFY=off` in the
   `env` block, as above. Confirm that the next record line for a new
   decision shows `off`. It does not stop the text lookup (see below). Both
   rollback steps need the PM.
2. Remove the 2 CLI calls, only if step 1 is not enough. PR #17 (squash
   commit `4ad07e9` on `master`) added them to `cli/index.ts`. Open a pull
   request that reverses only that file's change, removes or changes every
   CLI test in `tests/notify.test.ts` that expects a record line, a notifier
   call or a stderr line from the CLI (every one except DA-01.4, including
   DA-01.1 and DA-01.2), and updates the README paragraph and its DA-03.4
   test. Use the PM's merge gate. Never revert all of `4ad07e9`.

   Try the reverse on a clone; `exit=0` means it still reverses cleanly:

   ```sh
   d=$(mktemp -d)
   git clone -q "$(git remote get-url origin)" "$d"
   git -C "$d" show 4ad07e9 -- cli/index.ts | git -C "$d" apply -R --check
   echo "exit=$?"
   rm -rf "$d"
   ```

The off switch does not stop the text lookup: `gate request` and `card open`
still read the cockpit, gate artifacts and PRD source. The SR-8 fix (bug
d5ebde85, PR #22) reads them only as regular files in the project root,
except residual 3. Residuals 1, 2 are accepted. Bugfix 54b4e811 (PR 28) fixed
residual 3: shard and `.project` reads, temp writes, appends. Open: `.project`
folder fallback (task 49c078ce); unreported refused shard (task d78ae4cf);
events lost with no message after a refused append (task ce914d26).

## When an alert does not appear

Find the last line of `.project-notify/record.jsonl` for the decision's id.
A card's id is its `c-` id. A gate's id is `gate:<kind>:<subject>`. Example,
all on one line: `grep -F '{"id":"c-08caca",' .project-notify/record.jsonl |
tail -n 1`.

| Last line for this id | Next step |
|---|---|
| `"outcome":"failed"` | Read `reason`. It has 3 forms, and it never holds the title, the command or the project name (TH-5). See "Reasons" below. |
| `"outcome":"off"` or `"outcome":"unsupported"` | Off: the switch is set in the shell or in `.claude/settings.json`. Unsupported: the machine is not macOS. On the PM's Mac, either can mean the command's own environment silenced the alert (TH-20). Find the command that made the decision, and tell the PM. |
| `"outcome":"sent"` | `osascript` started. Check macOS's Notification settings and Focus; both decide whether a banner shows on screen (TH-18). Which app macOS lists for `osascript` is UNKNOWN (design section 6, step 3). |
| No line at all, or none for this id | The command may have failed before the alert ran, or the record write itself failed. Check the command's own output first, then the standard error line below. |

Standard error lines (`lib/project/notify.ts`):

- `project-companion: notification not sent: ` — no alert; the rest is the `reason`.
- `project-companion: notification record not written: ` — the outcome was
  decided, but the record step failed; the rest is a code, and usually the path.

Reasons, in 3 groups:

- `lookup failed: <code>` or `not in the cockpit: <id>` — the decision text
  could not be read, so the notifier was not tried. Run
  `project-companion cockpit` and check that the decision is listed.
- `<code> <path>`, `did not start <path>` or `not an absolute path: <path>`
  — the notifier could not start.
- `<code>` alone — spawn refused the text, for example a NUL character.

A reason never holds the title, command or project name (TH-5).
