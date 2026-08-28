import { NextResponse } from "next/server";

import { GitError, gitRoot } from "@/lib/project/git";
import { addWorktree, branchNameFor, createBranch } from "@/lib/project/git-write";
import { resolveRequestRoot } from "@/lib/project/request-root";
import { readTasks, updateTask } from "@/lib/project/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Creates a branch for a task, and optionally a worktree.
 *
 * This is the only route in the application that writes to a repository, and it
 * exists because the browser can put a confirmation in front of it. There is
 * deliberately no equivalent MCP tool that runs unattended -- an agent is told
 * the branch name and creates it itself, where the user's own tooling governs
 * what it is allowed to do.
 */
export const POST = async (request: Request) => {
  const resolved = resolveRequestRoot(request);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }

  const body = (await request.json()) as { taskId?: string; worktree?: boolean; from?: string };
  if (!body.taskId) {
    return NextResponse.json({ error: "taskId is required" }, { status: 400 });
  }

  const task = readTasks(resolved.root).tasks.find((t) => t.id === body.taskId);
  if (!task) {
    return NextResponse.json({ error: `No task "${body.taskId}"` }, { status: 404 });
  }

  const repo = await gitRoot(resolved.root);
  if (!repo) {
    return NextResponse.json({ error: "Not inside a git repository." }, { status: 400 });
  }

  const name = branchNameFor(task.id, task.title);

  try {
    const branch = await createBranch(repo, name, { from: body.from });
    const worktree = body.worktree
      ? await addWorktree(repo, `../${name.replace(/\//g, "-")}`, name)
      : undefined;

    // Recording the branch on the task means attribution works even after the
    // branch is deleted, when its name is no longer discoverable from git.
    updateTask(resolved.root, task.id, { branch: name });

    return NextResponse.json({ ok: true, branch, worktree });
  } catch (error) {
    if (error instanceof GitError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
};
