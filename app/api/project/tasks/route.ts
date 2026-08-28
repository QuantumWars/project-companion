import { NextResponse } from "next/server";

import { createTask, isTaskStatus, readTasks } from "@/lib/project/store";
import { resolveRequestRoot } from "@/lib/project/request-root";
import type { TaskStatus } from "@/lib/project/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = async (request: Request) => {
  const resolved = resolveRequestRoot(request);
  if (!resolved.ok) {
    return NextResponse.json({ configured: false, tasks: [] });
  }

  return NextResponse.json({
    configured: true,
    tasks: readTasks(resolved.root).tasks,
  });
};

export const POST = async (request: Request) => {
  const resolved = resolveRequestRoot(request);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }

  const body = (await request.json()) as {
    title?: string;
    description?: string;
    status?: TaskStatus;
    nodeIds?: string[];
    diagramId?: string;
    labels?: string[];
    assignee?: string;
    featureId?: string;
    phaseId?: string;
  };

  if (!body.title?.trim()) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }

  // An unvalidated status used to reach the store and land a task in a column
  // the board does not render, where it was invisible but not gone.
  if (body.status !== undefined && !isTaskStatus(body.status)) {
    return NextResponse.json({ error: `Unknown status "${body.status}"` }, { status: 400 });
  }

  return NextResponse.json(
    createTask(resolved.root, { ...body, title: body.title.trim() }),
  );
};
