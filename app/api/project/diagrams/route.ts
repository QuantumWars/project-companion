import { NextResponse } from "next/server";

import { resolveRequestRoot } from "@/lib/project/request-root";
import { createDiagram, deleteDiagram, listDiagrams } from "@/lib/project/store";
import { DIAGRAM_TYPE_IDS, type DiagramType } from "@/types/arch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = async (request: Request) => {
  const resolved = resolveRequestRoot(request);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }
  return NextResponse.json({ diagrams: listDiagrams(resolved.root) });
};

/**
 * Creating a diagram was CLI- and MCP-only until now, which meant the one
 * surface a person actually looks at could not do the most obvious thing.
 *
 * The id is derived from the title by the store, with a collision suffix, so
 * the caller gets a readable URL without having to invent one.
 */
export const POST = async (request: Request) => {
  const resolved = resolveRequestRoot(request);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }

  const body = (await request.json()) as { title?: string; type?: string };
  const title = body.title?.trim();
  if (!title) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }

  // An unknown type would silently pick the wrong layout algorithm and bias the
  // shape palette, so it is rejected rather than coerced.
  if (body.type && !DIAGRAM_TYPE_IDS.includes(body.type as DiagramType)) {
    return NextResponse.json({ error: `Unknown diagram type "${body.type}"` }, { status: 400 });
  }

  const diagram = createDiagram(resolved.root, title, (body.type as DiagramType) ?? "architecture");
  return NextResponse.json(diagram, { status: 201 });
};

export const DELETE = async (request: Request) => {
  const resolved = resolveRequestRoot(request);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }

  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  return deleteDiagram(resolved.root, id)
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: `No diagram "${id}"` }, { status: 404 });
};
