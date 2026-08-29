import { NextResponse } from "next/server";

import { resolveRequestRoot } from "@/lib/project/request-root";
import { createWhiteboard, deleteWhiteboard } from "@/lib/project/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Whiteboards are file-backed too, so they can be created the same way. */
export const POST = async (request: Request) => {
  const resolved = resolveRequestRoot(request);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }

  const body = (await request.json()) as { title?: string };
  const title = body.title?.trim();
  if (!title) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }

  return NextResponse.json(createWhiteboard(resolved.root, title), { status: 201 });
};

export const DELETE = async (request: Request) => {
  const resolved = resolveRequestRoot(request);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }

  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  return deleteWhiteboard(resolved.root, id)
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: `No whiteboard "${id}"` }, { status: 404 });
};
