/**
 * The skill written into the agent's own directory by `project-companion init`.
 *
 * Following the pattern Graphify uses: a skill file in the agent's own
 * directory means the agent learns the tool from the repository itself, with no
 * MCP configuration and no setup step.
 *
 * The single most important line in here is the commit trailer. Attribution
 * degrades to branch names and path guesses without it, so it is stated early,
 * repeated in the workflow, and shown in a worked example.
 */

export const SKILL_MD = `---
name: project-companion
description: Read and update this project's PRD, task board, architecture diagrams, and the git history linking them. Use when picking up work, when finishing it, when the shape of the system changes, or when you need to know what has actually been built.
---

# Project board

This project keeps its roadmap, task board and architecture diagrams in the
repository. The PRD is a markdown file; everything else is JSON. Read them
before changing code that spans more than one component, and update them as you
work.

## The one convention that matters

End every commit with a trailer naming the task:

\`\`\`
Add refund endpoint

project-companion: 978ce4d6
\`\`\`

That trailer is what links your commit to the board. Without it the link falls
back to the run you were working under, then to the branch name, then to a guess
from the files you touched -- weaker each step down, and the last one is an
inference rather than a claim.

Opening a run (below) makes attribution work even when you forget the trailer,
because the tool watched you write the files. Do both: the run is observed, the
trailer is stated, and a reader six months from now only has the trailer.

## Orient yourself

\`\`\`bash
npx project-companion component list      # what the system is made of, and who owns it
npx project-companion status              # diagrams and task counts
npx project-companion phase list          # phases, with progress
npx project-companion feature list        # the PRD's feature list
npx project-companion git status          # branch, ahead/behind, uncommitted files
\`\`\`

## Components: where work belongs

The architecture is not decoration. Every node on it can be a **component** -- a
part of the system somebody owns, with its own board, its own slice of the PRD
and its own history. A component declares the source it covers, and that
declaration is how everything else finds it.

Before you edit a file you have not touched before, ask who owns it:

\`\`\`bash
npx project-companion whose lib/auth/token.ts
# auth-service  grace@example.com
#   matched lib/auth/**
\`\`\`

Then read everything about it in one go:

\`\`\`bash
npx project-companion component show auth-service
\`\`\`

If you have the MCP tools, \`get_component_context\` is better: it answers the
same question and also hands you that component's acceptance criteria, open
tasks, recent commits and contributors in a single call. Prefer it to several
smaller ones -- the gathering happens on the server, where it costs you nothing.

If \`whose\` says a file belongs to nobody, that is worth knowing rather than
worth ignoring. Either nothing claims it, or two components claim it equally
well -- and in that case the tool deliberately attributes it to neither, because
a coin-flip presented as evidence is worse than no evidence.
\`\`\`bash
npx project-companion component doctor    # what is wrong with the catalog
\`\`\`

Components are opt-in. A box on a diagram is decorative until somebody says it
is real, so do not track every node you see -- track one when it turns out to
own work, and give it accurate paths:

\`\`\`bash
npx project-companion component add "Auth service" \\
  --owner grace@example.com --paths "lib/auth/**,app/login/**"
\`\`\`

## The loop

1. **Pick a feature.** \`project-companion feature list --status todo\`, then
   \`project-companion feature show <id>\` for its acceptance criteria.

2. **Break it into tasks.**

   \`\`\`bash
   npx project-companion task add "Add refund endpoint" \\
     --feature refunds --component billing --status todo
   \`\`\`

   \`--component\` puts the card on that part of the system's board. Use
   \`whose <path>\` if you are not sure which one you are working in.

3. **Start.** This moves the task to in progress and tells you the branch name:

   \`\`\`bash
   npx project-companion task start 978ce4d6
   \`\`\`

   It does **not** create the branch. Run the \`git checkout -b\` it prints,
   so branch creation stays under the user's control rather than happening as a
   side effect.

4. **Commit with the trailer.** Every commit, not just the last one.

5. **Finish.** Tick the acceptance criteria you satisfied:

   \`\`\`bash
   npx project-companion feature check refunds "refund is idempotent"
   npx project-companion task done 978ce4d6 --commit HEAD
   \`\`\`

   A feature's status is **derived** from its criteria: all ticked means done,
   some means in progress. There is no separate feature status to set, and
   ticking a box is what moves it.

## Work inside a run

Open a run before you start. It costs one command and it is what gives the tool
anything to supervise:

\`\`\`bash
npx project-companion run start <taskId> --model claude-opus-5
# Run 1ef86859  component auth  autonomy confirm  40000 tokens
# May write: lib/auth/**
\`\`\`

The budget, the autonomy level and the paths you may write come from whichever
component owns that task -- you do not have to know them, and you should not
argue with them. If you find yourself needing to write outside the boundary, that
is usually a real finding about the architecture rather than a limit to work
around. Say so.

\`\`\`bash
npx project-companion run list           # what is in flight, and what it has spent
npx project-companion run show <id>      # spend, boundary, files touched
npx project-companion run awaiting_review <id>
\`\`\`

A run cannot go straight from running to merged. Merging is a person's decision
and the tool will refuse it, which is the point rather than an obstacle.

## Prove it, do not just claim it

A feature can name the command that proves it works, beside the paths that say
where it lives:

\`\`\`markdown
Paths: lib/auth/**

Verify: npm test -- auth
\`\`\`

\`\`\`bash
npx project-companion verify <featureId>   # or all of them
\`\`\`

If the check fails, every ticked criterion on that feature is UNTICKED. That is
deliberate: a claim the repository just refused should not still be standing.
Tick a box only when you have run the thing that backs it.

## Before you hand work over

\`\`\`bash
npx project-companion drift              # coupling the architecture does not draw
npx project-companion review <sha>       # writes a review packet for the reviewer
npx project-companion flow               # where work is piling up
npx project-companion next               # what a person should look at first
\`\`\`

\`review\` writes a packet -- the criteria the change has to satisfy, what to read
and in what order, what to skip, and which boundaries it crosses. If you are the
one reviewing, read it and report through \`report_findings\`; anchor every
finding to a file:line inside the diff, because anything landing outside it is
dropped before a person sees it.

\`drift\` is worth running whenever you have added an import between two parts of
the system. Undeclared coupling means either the canvas is missing an edge or the
code should not be crossing there, and you are the one who just found out which.

## The PRD

The feature list lives in \`docs/prd.md\`. It is an ordinary markdown file --
edit it with your normal tools.

\`\`\`markdown
## Phase: Foundations

Goal: ship a working cart.

### Guest checkout
<!-- id: guest-checkout -->

Allow purchase without an account.

Paths: app/checkout/**, lib/cart/**

- [ ] No login prompt
- [x] Email receipt sent
\`\`\`

Three rules when you edit it:

- **Never remove or change an \`<!-- id: ... -->\` line.** It is what keeps
  tasks attached to a feature when the heading is renamed. Renaming the heading
  is fine; changing the id detaches every task pointing at it.
- **A new feature needs an id.** Use
  \`project-companion feature add "<title>" --phase <id>\` and it is stamped for you,
  or add the comment yourself.
- \`Paths:\` lists the globs a feature owns. It is how commits get attributed
  when there is no trailer, so keep it accurate.

## Keep the architecture true

When you add, remove or rewire a component, reflect it:

\`\`\`bash
npx project-companion diagram list
npx project-companion diagram show <id>     # cheaper than reading the source
npx project-companion diagram new "Payments" --type architecture
npx project-companion diagram import prisma/schema.prisma --title "Database"
\`\`\`

For node and edge edits use the MCP tools (\`add_node\`, \`connect_nodes\`,
\`remove_node\`) when they are available.

## Check your work is visible

\`\`\`bash
npx project-companion git log            # commits, and what each is linked to
npx project-companion git unlinked       # commits linked to nothing
\`\`\`

If your commits show up under \`git unlinked\`, the trailer is missing. Fix it
with \`project-companion task done <id> --commit <sha>\`, which records the sha
directly.

## What happened here

Every change to the board is recorded in an append-only log at
\`.project-log/\`, one file per person or agent, so it merges without conflicts
and nobody's history overwrites anybody else's.

\`\`\`bash
npx project-companion log                          # what has happened, in order
npx project-companion log --component auth-service # ...to one part of the system
\`\`\`

Read it when you pick up work somebody else -- or some earlier session -- left
half done. It is the only place a deleted card leaves a trace, and it is what
answers "why is this in review".

## Rules

- Do not hand-edit the JSON in the store. Use the CLI or the MCP tools so the
  index stays consistent and writes stay atomic. \`docs/prd.md\` is the
  exception -- it is meant to be edited directly.
- The board is shared with a human working in the browser. Re-read before
  writing if you have been away; a write that would overwrite someone else's
  edit is refused rather than applied.
- Never rewrite git history, and do not create branches or worktrees on your own
  initiative. Ask.
- Keep \`--paths\` accurate when you add or change a component. They are how
  commits attribute themselves, and a wrong glob quietly credits your work to
  somebody else's part of the system.
- Do not track every node on a diagram. A component is a claim that something is
  owned; making one for every box produces a catalog that looks like coverage
  without being it.
- If a column is full, \`task start\` and \`run start\` will refuse. That is a
  signal to go and finish something, not to raise the limit.
`;
