import { NextResponse } from "next/server";

import {
  deleteTask,
  isTaskStatus,
  moveTask,
  readTasks,
  reorderTask,
  updateTask,
} from "@/lib/project/store";
import { resolveRequestRoot } from "@/lib/project/request-root";
import type { Task } from "@/lib/project/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

export const PATCH = async (request: Request, { params }: Params) => {
  const resolved = resolveRequestRoot(request);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }

  const body = (await request.json()) as Partial<Task> & { index?: number };

  // A status change reorders within the target column, so it goes through
  // `moveTask`/`reorderTask` rather than a blind field assignment. An `index`
  // means the card was dropped between two others rather than onto the end.
  if (body.status !== undefined) {
    if (!isTaskStatus(body.status)) {
      return NextResponse.json({ error: `Unknown status "${body.status}"` }, { status: 400 });
    }
    const moved =
      body.index === undefined
        ? moveTask(resolved.root, params.id, body.status)
        : reorderTask(resolved.root, params.id, body.status, body.index);
    if (!moved) {
      return NextResponse.json({ error: `No task "${params.id}"` }, { status: 404 });
    }
  }

  const { status: _status, index: _index, ...rest } = body;
  if (Object.keys(rest).length === 0) {
    // Nothing else changed, so skip a second full read-modify-write of tasks.json.
    const current = readTasks(resolved.root).tasks.find((t) => t.id === params.id);
    return NextResponse.json(current);
  }

  const task = updateTask(resolved.root, params.id, rest);

  if (!task) {
    return NextResponse.json({ error: `No task "${params.id}"` }, { status: 404 });
  }

  return NextResponse.json(task);
};

export const DELETE = async (request: Request, { params }: Params) => {
  const resolved = resolveRequestRoot(request);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }

  if (!deleteTask(resolved.root, params.id)) {
    return NextResponse.json({ error: `No task "${params.id}"` }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
};
