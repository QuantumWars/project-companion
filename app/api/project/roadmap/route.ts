import { NextResponse } from "next/server";

import { PrdEditError, type PrdOp } from "@/lib/project/prd";
import { resolveRequestRoot } from "@/lib/project/request-root";
import { editPrd, readRoadmap, RoadmapConflictError } from "@/lib/project/roadmap";
import { tasksForFeature } from "@/lib/project/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = async (request: Request) => {
  const resolved = resolveRequestRoot(request);
  if (!resolved.ok) {
    return NextResponse.json({ configured: false, error: resolved.error }, { status: 200 });
  }

  const roadmap = readRoadmap(resolved.root);

  // `?hash=1` makes the poll nearly free: the client only needs to know whether
  // the document moved, not what it now says.
  if (new URL(request.url).searchParams.get("hash")) {
    return NextResponse.json({ configured: true, sourceHash: roadmap.sourceHash });
  }

  return NextResponse.json({
    configured: true,
    ...roadmap,
    tasksByFeature: Object.fromEntries(
      roadmap.features.map((f) => [f.id, tasksForFeature(resolved.root, f.id)]),
    ),
  });
};

/**
 * Edits are semantic, and the write is a compare-and-swap on `baseHash`.
 *
 * Offsets never cross this boundary: the client says which feature and which
 * field, and the server works out where that is against the file as it exists
 * right now. A stale `baseHash` returns 409 with the current state rather than
 * overwriting whatever an agent wrote in the meantime.
 */
export const PATCH = async (request: Request) => {
  const resolved = resolveRequestRoot(request);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }

  const body = (await request.json()) as { baseHash?: string; ops?: PrdOp[] };
  if (!Array.isArray(body.ops) || body.ops.length === 0) {
    return NextResponse.json({ error: "ops is required" }, { status: 400 });
  }

  try {
    const roadmap = editPrd(resolved.root, body.baseHash, body.ops);
    return NextResponse.json({ ok: true, ...roadmap });
  } catch (error) {
    if (error instanceof RoadmapConflictError) {
      return NextResponse.json(
        {
          error: error.message,
          conflict: true,
          ...readRoadmap(resolved.root),
        },
        { status: 409 },
      );
    }
    if (error instanceof PrdEditError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
};
