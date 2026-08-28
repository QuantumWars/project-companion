import { NextResponse } from "next/server";

import { readGitView } from "@/lib/project/git-view";
import { resolveRequestRoot } from "@/lib/project/request-root";
import { readRoadmap } from "@/lib/project/roadmap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read-only. Everything here observes the repository and nothing mutates it;
 * the two write operations live behind `/api/project/git/branch`, which is a
 * POST the browser only issues after a confirmation.
 */
export const GET = async (request: Request) => {
  const resolved = resolveRequestRoot(request);
  if (!resolved.ok) {
    return NextResponse.json({ available: false, reason: resolved.error }, { status: 200 });
  }

  const url = new URL(request.url);
  const view = await readGitView(resolved.root, readRoadmap(resolved.root).features, {
    limit: Number(url.searchParams.get("limit")) || undefined,
    refresh: url.searchParams.get("refresh") === "1",
  });

  return NextResponse.json(view);
};
