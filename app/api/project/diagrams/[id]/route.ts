import { NextResponse } from "next/server";

import { readDiagram, writeDiagram } from "@/lib/project/store";
import { resolveRequestRoot } from "@/lib/project/request-root";
import type { ArchEdge, ArchNode, DiagramType, Viewport } from "@/types/arch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

export const GET = async (request: Request, { params }: Params) => {
  const resolved = resolveRequestRoot(request);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }

  const diagram = readDiagram(resolved.root, params.id);
  if (!diagram) {
    return NextResponse.json({ error: `No diagram "${params.id}"` }, { status: 404 });
  }

  return NextResponse.json(diagram);
};

export const PUT = async (request: Request, { params }: Params) => {
  const resolved = resolveRequestRoot(request);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }

  const existing = readDiagram(resolved.root, params.id);
  if (!existing) {
    return NextResponse.json({ error: `No diagram "${params.id}"` }, { status: 404 });
  }

  const body = (await request.json()) as {
    nodes?: ArchNode[];
    edges?: ArchEdge[];
    viewport?: Viewport;
    diagramType?: DiagramType;
  };

  // The title stays the project index's business, but the diagram type is a
  // property of the document the canvas owns, so a switch in the UI persists.
  const saved = writeDiagram(resolved.root, {
    ...existing,
    nodes: body.nodes ?? existing.nodes,
    edges: body.edges ?? existing.edges,
    viewport: body.viewport ?? existing.viewport,
    type: body.diagramType ?? existing.type,
  });

  return NextResponse.json({ ok: true, updatedAt: saved.updatedAt });
};
