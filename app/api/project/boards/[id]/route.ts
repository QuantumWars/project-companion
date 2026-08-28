import { NextResponse } from "next/server";

import { readWhiteboard, writeWhiteboard } from "@/lib/project/store";
import { resolveRequestRoot } from "@/lib/project/request-root";
import type { Layer } from "@/types/canvas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

export const GET = async (request: Request, { params }: Params) => {
  const resolved = resolveRequestRoot(request);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }

  const board = readWhiteboard(resolved.root, params.id);
  if (!board) {
    return NextResponse.json({ error: `No board "${params.id}"` }, { status: 404 });
  }

  return NextResponse.json(board);
};

export const PUT = async (request: Request, { params }: Params) => {
  const resolved = resolveRequestRoot(request);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }

  const existing = readWhiteboard(resolved.root, params.id);
  if (!existing) {
    return NextResponse.json({ error: `No board "${params.id}"` }, { status: 404 });
  }

  const body = (await request.json()) as {
    layerIds?: string[];
    layers?: [string, Layer][];
  };

  const saved = writeWhiteboard(resolved.root, {
    ...existing,
    layerIds: body.layerIds ?? existing.layerIds,
    layers: body.layers ?? existing.layers,
  });

  return NextResponse.json({ ok: true, updatedAt: saved.updatedAt });
};
