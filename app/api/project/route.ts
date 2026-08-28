import { NextResponse } from "next/server";

import { findProject, listDiagrams, readProject } from "@/lib/project/store";
import { registerProject } from "@/lib/project/registry";
import { resolveRequestRoot } from "@/lib/project/request-root";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = async (request: Request) => {
  const resolved = resolveRequestRoot(request);

  if (!resolved.ok) {
    // A missing store is a normal state for a fresh checkout, not an error.
    return resolved.status === 404
      ? NextResponse.json({
          configured: false,
          message: "No project store found. Run `project-companion init`.",
        })
      : NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }

  registerProject(resolved.root);
  const project = readProject(resolved.root);

  return NextResponse.json({
    configured: true,
    root: resolved.root,
    // Which agent directory holds the store, so the UI can say so rather than
    // hardcoding a name that stops being true when the store moves.
    storeDir: findProject(resolved.root)?.storeDir ?? null,
    name: project.name,
    diagrams: listDiagrams(resolved.root),
  });
};
