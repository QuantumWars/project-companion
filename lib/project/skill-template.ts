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
back to guessing from the branch name and the files you touched, which is
weaker and sometimes wrong.

## Orient yourself

\`\`\`bash
npx project-companion status              # diagrams and task counts
npx project-companion phase list          # phases, with progress
npx project-companion feature list        # the PRD's feature list
npx project-companion git status          # branch, ahead/behind, uncommitted files
\`\`\`

## The loop

1. **Pick a feature.** \`project-companion feature list --status todo\`, then
   \`project-companion feature show <id>\` for its acceptance criteria.

2. **Break it into tasks.**

   \`\`\`bash
   npx project-companion task add "Add refund endpoint" --feature refunds --status todo
   \`\`\`

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

## Rules

- Do not hand-edit the JSON in the store. Use the CLI or the MCP tools so the
  index stays consistent and writes stay atomic. \`docs/prd.md\` is the
  exception -- it is meant to be edited directly.
- The board is shared with a human working in the browser. Re-read before
  writing if you have been away; a write that would overwrite someone else's
  edit is refused rather than applied.
- Never rewrite git history, and do not create branches or worktrees on your own
  initiative. Ask.
`;
